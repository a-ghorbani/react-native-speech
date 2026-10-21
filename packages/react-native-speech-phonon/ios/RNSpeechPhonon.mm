// Threading: every ptts call runs on the shared PhononWorker, so upstream's
// one-thread-per-handle rule holds across RN reloads. Core ML autoreleases per prediction and
// the worker is not a GCD thread, so each job gets a pool that the frame hook swaps every 16
// frames. Support, request ids, cancel and the buffer store never touch the worker.
//
// libptts_ffi.a is linked into every app with this package (iOS 15-safe symbols, DESIGN.md §3.3) but is
// only called once +supportInfo confirms iOS 18.
#import "RNSpeechPhonon.h"

#import <CommonCrypto/CommonDigest.h>
#import <CoreML/CoreML.h>
#import <React/RCTLog.h>
#import <TargetConditionals.h>
#import <mach/mach.h>
#import <sys/sysctl.h>
#import <unistd.h>

#include <atomic>
#include <cstddef>
#include <memory>
#include <string>
#include <vector>

#include "PhononIosPolicy.h"
#include "PhononApi.h"
#include "PhononCore.h"
#include "PhononWorker.h"

using rnspeech::phonon::Busy;
using rnspeech::phonon::Core;
using rnspeech::phonon::Err;
using rnspeech::phonon::LoadResult;
using rnspeech::phonon::Platform;
using rnspeech::phonon::PttsApi;
using rnspeech::phonon::SynthResult;
using rnspeech::phonon::Worker;
namespace policy = rnspeech::phonon::ios;

// What @autoreleasepool lowers to (stable ABI, no public header); needed to swap mid-job.
extern "C" void *objc_autoreleasePoolPush(void);
extern "C" void objc_autoreleasePoolPop(void *context);

#define RNSPEECH_PHONON_STR2(x) #x
#define RNSPEECH_PHONON_STR(x) RNSPEECH_PHONON_STR2(x)
#ifdef RN_SPEECH_PHONON_VERSION
static const char *const kPhononLibraryVersion = RNSPEECH_PHONON_STR(RN_SPEECH_PHONON_VERSION);
#else
static const char *const kPhononLibraryVersion = "unknown";
#endif

static NSString *const kCapabilityFile = @"rnspeech-phonon-cap.json";
static const unsigned kFramesPerPoolDrain = 16;

// Worker thread only.
static thread_local void *tJobPool = nullptr;

namespace {

NSString *ToNS(const std::string &s) {
  return [[NSString alloc] initWithBytes:s.data() length:s.size() encoding:NSUTF8StringEncoding]
             ?: @"";
}

std::string ToStd(NSString *_Nullable s) {
  const char *c = s.UTF8String;
  return c != nullptr ? std::string(c) : std::string();
}

NSArray<NSString *> *ToNSArray(const std::vector<std::string> &v) {
  NSMutableArray<NSString *> *out = [NSMutableArray arrayWithCapacity:v.size()];
  for (const std::string &s : v) [out addObject:ToNS(s)];
  return out;
}

std::vector<std::string> DirEntries(NSString *dir) {
  std::vector<std::string> out;
  NSArray<NSString *> *items = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir
                                                                                   error:nil];
  for (NSString *name in items) out.push_back(ToStd(name));
  return out;
}

NSString *Sysctl(const char *name) {
  size_t size = 0;
  if (sysctlbyname(name, nullptr, &size, nullptr, 0) != 0 || size == 0) return @"";
  std::vector<char> buf(size + 1, '\0');
  if (sysctlbyname(name, buf.data(), &size, nullptr, 0) != 0) return @"";
  return [NSString stringWithUTF8String:buf.data()] ?: @"";
}

BOOL IsSimulator() { return TARGET_OS_SIMULATOR ? YES : NO; }

NSString *MachineId() {
  if (IsSimulator()) {
    NSString *model = NSProcessInfo.processInfo.environment[@"SIMULATOR_MODEL_IDENTIFIER"];
    return [NSString stringWithFormat:@"simulator:%@", model ?: Sysctl("hw.machine")];
  }
  return Sysctl("hw.machine");
}

policy::CapabilityKey CurrentKey() {
  policy::CapabilityKey key;
  key.machine = ToStd(MachineId());
  key.osBuild = ToStd(Sysctl("kern.osversion"));
  key.libraryVersion = kPhononLibraryVersion;
  return key;
}

// DEBUG builds only: env RN_SPEECH_PHONON_FORCE_REASON or Info.plist RNSpeechPhononForceReason.
std::string ForcedReason() {
#if DEBUG
  const char *env = getenv("RN_SPEECH_PHONON_FORCE_REASON");
  if (env != nullptr && *env != '\0') return std::string(env);
  id plist = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"RNSpeechPhononForceReason"];
  if ([plist isKindOfClass:[NSString class]] && [(NSString *)plist length] > 0) {
    return ToStd((NSString *)plist);
  }
#endif
  return std::string();
}

void LogUnsupportedOnce(NSString *reason) {
  static NSMutableSet<NSString *> *logged;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    logged = [NSMutableSet new];
  });
  @synchronized(logged) {
    if ([logged containsObject:reason]) return;
    [logged addObject:reason];
  }
  RCTLogInfo(@"[Phonon] unsupported: %@", reason);
}

void SetupWorkerOnce() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Worker::shared().setJobHook([](const Worker::Job &job) {
      struct Pool {
        Pool() { tJobPool = objc_autoreleasePoolPush(); }
        ~Pool() {
          // The frame hook may have replaced the pool: pop whichever is current.
          if (tJobPool != nullptr) objc_autoreleasePoolPop(tJobPool);
          tJobPool = nullptr;
        }
      } pool;
      job();
    });
    // Upstream pushes no pool around the frame callback, so the job's pool is innermost here.
    Core::get().setFrameHook(
        [] {
          if (tJobPool != nullptr) {
            objc_autoreleasePoolPop(tJobPool);
            tJobPool = objc_autoreleasePoolPush();
          }
        },
        kFramesPerPoolDrain);
  });
}

// Worker thread only.
void EnsureApi() {
  Core &core = Core::get();
  if (core.libraryLoaded()) return;
  // Keeps CoreML linked: upstream only reaches it through objc_getClass.
  (void)[MLModel class];
  PttsApi api;
  rnspeech::phonon::phonon_bind_static_api(&api);
  core.setApi(api);
}

// §2.4 recovery.
NSUInteger RemoveRecompilable(NSString *dir) {
  NSUInteger removed = 0;
  for (const std::string &name : policy::recompilable_models(DirEntries(dir))) {
    NSString *path = [dir stringByAppendingPathComponent:ToNS(name)];
    if ([[NSFileManager defaultManager] removeItemAtPath:path error:nil]) ++removed;
  }
  return removed;
}

NSDictionary *SynthResultDict(const SynthResult &r) {
  return @{
    @"requestId" : @((double)r.requestId),
    @"bufferId" : @((double)r.bufferId),
    @"samples" : @((double)r.samples),
    @"sampleRate" : @(r.sampleRate),
    @"ttfaMs" : @(r.ttfaMs),
    @"totalMs" : @(r.totalMs),
    @"queuedMs" : @(r.queuedMs),
    @"voiceChanged" : @(r.voiceChanged),
    @"cancelled" : @(r.cancelled),
    @"startedAtMs" : @(r.startedAtMs),
    @"finishedAtMs" : @(r.finishedAtMs),
  };
}

// phys_footprint and its lifetime peak (KB); 0 if unavailable.
void MemoryKb(double *memKb, double *peakKb) {
  *memKb = 0;
  *peakKb = 0;
  task_vm_info_data_t info = {};
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) {
    return;
  }
  *memKb = (double)(info.phys_footprint / 1024);
  // Older kernels fill fewer fields.
  const size_t peakEnd = offsetof(task_vm_info_data_t, ledger_phys_footprint_peak) +
                         sizeof(info.ledger_phys_footprint_peak);
  if ((size_t)count * sizeof(natural_t) >= peakEnd) {
    *peakKb = (double)(info.ledger_phys_footprint_peak / 1024);
  } else {
    *peakKb = *memKb;
  }
}

double ThreadCount() {
  thread_act_array_t threads = nullptr;
  mach_msg_type_number_t n = 0;
  if (task_threads(mach_task_self(), &threads, &n) != KERN_SUCCESS) return 0;
  for (mach_msg_type_number_t i = 0; i < n; ++i) mach_port_deallocate(mach_task_self(), threads[i]);
  vm_deallocate(mach_task_self(), (vm_address_t)threads, n * sizeof(thread_act_t));
  return (double)n;
}

}  // namespace

@implementation RNSpeechPhonon {
  // false after -invalidate: pending promises are dropped.
  std::shared_ptr<std::atomic<bool>> _alive;
}

static NSURL *sCapabilityStoreOverride = nil;

- (instancetype)init {
  if ((self = [super init])) {
    _alive = std::make_shared<std::atomic<bool>>(true);
  }
  return self;
}

#pragma mark - Support

+ (NSString *)libraryVersion {
  return [NSString stringWithUTF8String:kPhononLibraryVersion] ?: @"";
}

+ (NSString *)abi {
#if TARGET_OS_SIMULATOR
#if defined(__x86_64__)
  return @"ios-x86_64-simulator";
#else
  return @"ios-arm64-simulator";
#endif
#else
  return @"ios-arm64";
#endif
}

+ (NSDictionary<NSString *, id> *)supportInfo {
  policy::SupportInputs in;
  in.forcedReason = ForcedReason();
  if (in.forcedReason.empty()) {
    NSDictionary *record = [self applicableCapabilityRecord];
    if (record != nil) {
      in.recordReason = ToStd(record[@"reason"]);
      in.recordDetail = ToStd(record[@"detail"]);
    }
  }
  if (@available(iOS 18.0, *)) {
    in.osAtLeast18 = true;
  }
#if TARGET_OS_SIMULATOR && defined(__x86_64__)
  in.x86Simulator = true;
#endif
  in.physicalMemory = NSProcessInfo.processInfo.physicalMemory;
  policy::SupportDecision d = policy::decide_support(in);

  NSString *reason = ToNS(d.reason);
  if (!d.supported) LogUnsupportedOnce(reason);
  NSOperatingSystemVersion v = NSProcessInfo.processInfo.operatingSystemVersion;
  return @{
    @"supported" : @(d.supported),
    @"reason" : reason,
    @"detail" : ToNS(d.detail),
    @"abi" : [self abi],
    @"osVersion" : [NSString stringWithFormat:@"%ld.%ld.%ld", (long)v.majorVersion,
                                              (long)v.minorVersion, (long)v.patchVersion],
    @"libraryVersion" : [self libraryVersion],
    @"isSimulator" : @(IsSimulator()),
    @"pageSize" : @((double)getpagesize()),
  };
}

+ (BOOL)needsCompile:(NSString *)modelDir {
  return policy::needs_compile(DirEntries(modelDir)) ? YES : NO;
}

+ (NSString *)effectiveComputeUnitFor:(NSString *)requested pttsUnit:(uint32_t *)unit {
  std::string mapped;
  const uint32_t u = rnspeech::phonon::map_compute_unit(Platform::Apple, ToStd(requested), &mapped);
  if (unit != nullptr) *unit = u;
  return ToNS(policy::effective_compute_unit(mapped, IsSimulator()));
}

#pragma mark - Capability store

+ (void)setCapabilityStoreURLForTesting:(NSURL *)url {
  @synchronized(self) {
    sCapabilityStoreOverride = url;
  }
}

+ (NSURL *)capabilityStoreURL {
  @synchronized(self) {
    if (sCapabilityStoreOverride != nil) return sCapabilityStoreOverride;
  }
  NSURL *support = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                          inDomains:NSUserDomainMask]
                       .firstObject;
  if (support == nil) support = [NSURL fileURLWithPath:NSTemporaryDirectory()];
  return [support URLByAppendingPathComponent:kCapabilityFile];
}

+ (NSString *)modelStampFor:(NSString *)modelDir {
  if (modelDir.length == 0) return @"";
  NSData *data = [NSData dataWithContentsOfFile:[modelDir stringByAppendingPathComponent:@"bundle.json"]];
  if (data == nil) return @"none";
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; ++i) [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

+ (NSDictionary<NSString *, id> *)applicableCapabilityRecord {
  NSData *data = [NSData dataWithContentsOfURL:[self capabilityStoreURL]];
  if (data == nil) return nil;
  id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![json isKindOfClass:[NSDictionary class]]) return nil;
  NSDictionary *rec = json;
  NSDictionary *key = [rec[@"key"] isKindOfClass:[NSDictionary class]] ? rec[@"key"] : nil;
  auto str = [](id v) { return [v isKindOfClass:[NSString class]] ? ToStd(v) : std::string(); };

  policy::CapabilityRecord r;
  r.key.machine = str(key[@"machine"]);
  r.key.osBuild = str(key[@"osBuild"]);
  r.key.libraryVersion = str(key[@"libraryVersion"]);
  r.modelPath = str(rec[@"modelPath"]);
  r.modelStamp = str(rec[@"modelStamp"]);
  r.reason = str(rec[@"reason"]);
  r.detail = str(rec[@"detail"]);
  NSString *stamp = r.modelPath.empty() ? @"" : [self modelStampFor:ToNS(r.modelPath)];
  if (!policy::record_applies(r, CurrentKey(), ToStd(stamp))) return nil;
  return rec;
}

+ (void)recordCapabilityFailure:(NSString *)reason
                         detail:(NSString *)detail
                       modelDir:(NSString *)modelDir {
  policy::CapabilityKey key = CurrentKey();
  NSDictionary *rec = @{
    @"key" : @{
      @"machine" : ToNS(key.machine),
      @"osBuild" : ToNS(key.osBuild),
      @"libraryVersion" : ToNS(key.libraryVersion),
    },
    @"modelPath" : modelDir ?: @"",
    @"modelStamp" : [self modelStampFor:modelDir],
    @"reason" : reason ?: @"error",
    @"detail" : detail ?: @"",
    @"at" : @((double)(NSDate.date.timeIntervalSince1970 * 1000.0)),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:rec options:0 error:nil];
  NSURL *url = [self capabilityStoreURL];
  [[NSFileManager defaultManager] createDirectoryAtURL:[url URLByDeletingLastPathComponent]
                           withIntermediateDirectories:YES
                                            attributes:nil
                                                 error:nil];
  if (data != nil && [data writeToURL:url atomically:YES]) {
    [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
    RCTLogInfo(@"[Phonon] capability record: %@ (%@)", reason, detail);
  }
}

+ (BOOL)clearCapabilityRecord {
  NSURL *url = [self capabilityStoreURL];
  [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
  return ![[NSFileManager defaultManager] fileExistsAtPath:url.path];
}

#pragma mark - Work

- (void)createWithModelDir:(NSString *)modelDir
                  language:(NSString *)language
               computeUnit:(NSString *)computeUnit
                   resolve:(RNSpeechPhononResolve)resolve
                    reject:(RNSpeechPhononReject)reject {
  // An unsupported device never reaches the library.
  NSDictionary *support = [RNSpeechPhonon supportInfo];
  if (![support[@"supported"] boolValue]) {
    reject(@"PHONON_UNSUPPORTED",
           [NSString stringWithFormat:@"Phonon is not supported here: %@ (%@)", support[@"reason"],
                                      support[@"detail"]],
           nil);
    return;
  }
  SetupWorkerOnce();
  auto alive = _alive;
  RNSpeechPhononResolve res = [resolve copy];
  RNSpeechPhononReject rej = [reject copy];
  NSString *dir = [modelDir copy] ?: @"";
  const std::string lang = ToStd(language);
  uint32_t unit = 0;
  NSString *effective = [RNSpeechPhonon effectiveComputeUnitFor:computeUnit pttsUnit:&unit];

  const bool posted = Worker::shared().post([=]() {
    if (@available(iOS 18.0, *)) {
      EnsureApi();
      Core &core = Core::get();
      bool compiled = policy::needs_compile(DirEntries(dir));
      if (compiled) core.setBusy(Busy::Compiling);
      LoadResult lr;
      std::string err;
      Err e = core.create(ToStd(dir), unit, lang, &lr, &err);
      if (e == Err::LoadFailed) {
        // §2.4: a half-written or stale compile is the usual cause; rebuild once.
        const NSUInteger removed = RemoveRecompilable(dir);
        if (removed > 0) {
          RCTLogInfo(@"[Phonon] load failed (%@); removed %lu compiled model(s), retrying",
                     ToNS(err), (unsigned long)removed);
          compiled = true;
          core.setBusy(Busy::Compiling);
          err.clear();
          e = core.create(ToStd(dir), unit, lang, &lr, &err);
        }
        if (e == Err::LoadFailed && policy::should_persist_load_error(err)) {
          [RNSpeechPhonon recordCapabilityFailure:@"load-failed" detail:ToNS(err) modelDir:dir];
        }
      }
      core.setBusy(Busy::Idle);
      if (!alive->load()) return;
      if (e != Err::None) {
        rej(ToNS(rnspeech::phonon::err_code(e)), ToNS(err), nil);
        return;
      }
      res(@{
        @"handleId" : @((double)lr.handleId),
        @"voices" : ToNSArray(lr.voices),
        @"languages" : ToNSArray(lr.languages),
        @"defaultVoice" : ToNS(lr.defaultVoice),
        @"sampleRate" : @(lr.sampleRate),
        @"loadMs" : @(lr.loadMs),
        @"compiled" : @(compiled),
        @"numThreads" : @(0),
        @"computeUnit" : effective,
      });
    } else {
      if (alive->load()) rej(@"PHONON_UNSUPPORTED", @"Phonon needs iOS 18", nil);
    }
  });
  if (!posted) {
    reject(@"PHONON_INTERNAL", ToNS("synth thread unavailable: " + Worker::shared().startError()),
           nil);
  }
}

- (int64_t)allocRequestId {
  return Core::get().allocRequestId();
}

- (BOOL)cancelUpTo:(int64_t)requestId {
  Core::get().cancelUpTo(requestId);
  return YES;
}

- (BOOL)cancelAll {
  Core::get().cancelAll();
  return YES;
}

- (void)synthesizeWithHandle:(int64_t)handleId
                   requestId:(int64_t)requestId
                        text:(NSString *)text
                       voice:(NSString *)voice
                    language:(NSString *)language
                     resolve:(RNSpeechPhononResolve)resolve
                      reject:(RNSpeechPhononReject)reject {
  SetupWorkerOnce();
  auto alive = _alive;
  RNSpeechPhononResolve res = [resolve copy];
  RNSpeechPhononReject rej = [reject copy];
  const std::string t = ToStd(text), v = ToStd(voice), l = ToStd(language);
  const double enqueuedAt = rnspeech::phonon::monotonic_ms();
  const bool posted = Worker::shared().post([=]() {
    SynthResult r;
    std::string err;
    Err e = Core::get().synthesize(handleId, requestId, t, v, l, &r, &err, enqueuedAt);
    if (!alive->load()) {
      // Reloaded meanwhile: nobody will play or release it.
      if (r.bufferId != 0) Core::get().releaseBuffer(r.bufferId);
      return;
    }
    if (e != Err::None) {
      rej(ToNS(rnspeech::phonon::err_code(e)), ToNS(err), nil);
      return;
    }
    res(SynthResultDict(r));
  });
  if (!posted) {
    reject(@"PHONON_INTERNAL", ToNS("synth thread unavailable: " + Worker::shared().startError()),
           nil);
  }
}

- (NSData *)takeBuffer:(int64_t)bufferId gain:(float)gain {
  auto *samples = new std::vector<float>();
  if (!Core::get().takeBuffer(bufferId, samples)) {
    delete samples;
    return nil;
  }
  if (samples->empty()) {
    delete samples;
    return [NSData data];
  }
  policy::apply_gain_clamp(samples->data(), samples->size(), gain, samples->data());
  return [[NSData alloc] initWithBytesNoCopy:samples->data()
                                      length:samples->size() * sizeof(float)
                                 deallocator:^(void *, NSUInteger) {
                                   delete samples;
                                 }];
}

- (void)copyBuffer:(int64_t)bufferId
           resolve:(RNSpeechPhononResolve)resolve
            reject:(RNSpeechPhononReject)reject {
  auto alive = _alive;
  RNSpeechPhononResolve res = [resolve copy];
  RNSpeechPhononReject rej = [reject copy];
  // Up to 96 MB: copy and encode off the JS thread.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    std::vector<float> samples;
    if (!Core::get().copyBuffer(bufferId, &samples)) {
      if (alive->load()) {
        rej(@"PHONON_INVALID_BUFFER",
            [NSString stringWithFormat:@"unknown buffer %lld", (long long)bufferId], nil);
      }
      return;
    }
    // iOS is little-endian: the float32 bytes are already in the wire order.
    NSData *data = [NSData dataWithBytes:samples.data() length:samples.size() * sizeof(float)];
    NSString *b64 = [data base64EncodedStringWithOptions:0];
    if (alive->load()) res(b64);
  });
}

- (BOOL)releaseBuffer:(int64_t)bufferId {
  return Core::get().releaseBuffer(bufferId) ? YES : NO;
}

- (void)destroyHandle:(int64_t)handleId
              resolve:(RNSpeechPhononResolve)resolve
               reject:(RNSpeechPhononReject)reject {
  SetupWorkerOnce();
  auto alive = _alive;
  RNSpeechPhononResolve res = [resolve copy];
  RNSpeechPhononReject rej = [reject copy];
  const bool posted = Worker::shared().post([=]() {
    const Err e = Core::get().destroy(handleId);
    if (!alive->load()) return;
    if (e == Err::None) {
      res(nil);
    } else {
      rej(ToNS(rnspeech::phonon::err_code(e)),
          [NSString stringWithFormat:@"Phonon handle %lld is not open", (long long)handleId], nil);
    }
  });
  if (!posted) resolve(nil);
}

- (NSDictionary<NSString *, id> *)diagnostics {
  rnspeech::phonon::CoreDiagnostics d = Core::get().diagnostics();
  double memKb = 0, peakKb = 0;
  MemoryKb(&memKb, &peakKb);
  return @{
    @"memKb" : @(memKb),
    @"peakMemKb" : @(peakKb),
    @"threads" : @(ThreadCount()),
    @"libraryLoaded" : @(d.libraryLoaded),
    @"handleOpen" : @(d.handleOpen),
    @"liveBuffers" : @((double)d.liveBuffers),
    @"orphanBuffers" : @((double)d.orphanBuffers),
    @"busy" : ToNS(d.busy),
    @"lastIssuedId" : @((double)d.lastIssuedId),
    @"cancelWatermark" : @((double)d.cancelWatermark),
  };
}

- (void)invalidate {
  _alive->store(false);
  Core &core = Core::get();
  core.cancelAll();
  // After cancelAll every stored buffer is an orphan.
  core.releaseOrphans();
}

@end
