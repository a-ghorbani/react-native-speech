//
//  PhononTests.m
//  SpeechExampleTests
//
//  XCTest for the iOS Phonon bridge (packages/react-native-speech-phonon/docs/DESIGN.md §8.1).
//
//  The bridge is reached through the runtime, not linked, so the process keeps one copy of the
//  core (the app's libRNSpeechPhonon.a). Builds without the add-on (RN_SPEECH_PHONON unset at
//  pod install) skip every test unless RN_SPEECH_PHONON_EXPECTED=1 (TEST_RUNNER_ prefix via
//  xcodebuild), which makes them fail.
//
//  Model smoke: PHONON_TEST_MODEL_DIR = the inner Core ML bundle folder (with bundle.json).
//

#import <XCTest/XCTest.h>
#import <objc/message.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

typedef void (^PTResolve)(id _Nullable result);
typedef void (^PTReject)(NSString *code, NSString *_Nullable message, NSError *_Nullable error);

// Mirror of the add-on's ios/RNSpeechPhonon.h (only what the tests call).
@protocol RNSpeechPhononTesting <NSObject>
+ (NSDictionary<NSString *, id> *)supportInfo;
+ (NSString *)libraryVersion;
+ (NSString *)abi;
+ (BOOL)needsCompile:(NSString *)modelDir;
+ (NSString *)effectiveComputeUnitFor:(NSString *)requested pttsUnit:(uint32_t *)unit;
+ (NSURL *)capabilityStoreURL;
+ (nullable NSDictionary<NSString *, id> *)applicableCapabilityRecord;
+ (void)recordCapabilityFailure:(NSString *)reason
                         detail:(NSString *)detail
                       modelDir:(nullable NSString *)modelDir;
+ (BOOL)clearCapabilityRecord;
+ (void)setCapabilityStoreURLForTesting:(nullable NSURL *)url;
+ (NSString *)modelStampFor:(nullable NSString *)modelDir;
- (void)createWithModelDir:(NSString *)modelDir
                  language:(NSString *)language
               computeUnit:(NSString *)computeUnit
                   resolve:(PTResolve)resolve
                    reject:(PTReject)reject;
- (int64_t)allocRequestId;
- (BOOL)cancelUpTo:(int64_t)requestId;
- (BOOL)cancelAll;
- (void)synthesizeWithHandle:(int64_t)handleId
                   requestId:(int64_t)requestId
                        text:(NSString *)text
                       voice:(NSString *)voice
                    language:(NSString *)language
                     resolve:(PTResolve)resolve
                      reject:(PTReject)reject;
- (nullable NSData *)takeBuffer:(int64_t)bufferId gain:(float)gain;
- (void)copyBuffer:(int64_t)bufferId resolve:(PTResolve)resolve reject:(PTReject)reject;
- (BOOL)releaseBuffer:(int64_t)bufferId;
- (void)destroyHandle:(int64_t)handleId resolve:(PTResolve)resolve reject:(PTReject)reject;
- (NSDictionary<NSString *, id> *)diagnostics;
- (void)invalidate;
@end

// PTTS_UNIT_* from the add-on's cpp/ptts.h.
static const uint32_t kUnitCpu = 0;
static const uint32_t kUnitAne = 2;

@interface PhononTests : XCTestCase
@property (nonatomic) Class<RNSpeechPhononTesting> phonon;
@property (nonatomic, copy) NSURL *storeURL;
@property (nonatomic, copy) NSString *tmpDir;
@end

@implementation PhononTests

- (void)setUp {
  self.continueAfterFailure = NO;
  self.phonon = (Class<RNSpeechPhononTesting>)NSClassFromString(@"RNSpeechPhonon");
  if (self.phonon == nil) {
    return;
  }
  self.tmpDir = [NSTemporaryDirectory()
      stringByAppendingPathComponent:[NSString stringWithFormat:@"phonon-tests-%@",
                                                                NSUUID.UUID.UUIDString]];
  [[NSFileManager defaultManager] createDirectoryAtPath:self.tmpDir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  self.storeURL = [NSURL fileURLWithPath:[self.tmpDir stringByAppendingPathComponent:@"cap.json"]];
  [self.phonon setCapabilityStoreURLForTesting:self.storeURL];
  unsetenv("RN_SPEECH_PHONON_FORCE_REASON");
}

- (void)tearDown {
  if (self.phonon != nil) {
    unsetenv("RN_SPEECH_PHONON_FORCE_REASON");
    [self.phonon setCapabilityStoreURLForTesting:nil];
    [[NSFileManager defaultManager] removeItemAtPath:self.tmpDir error:nil];
  }
}

- (BOOL)requirePhonon {
  if (self.phonon == nil) {
    const char *expected = getenv("RN_SPEECH_PHONON_EXPECTED");
    if (expected != NULL && strcmp(expected, "1") == 0) {
      XCTFail(@"RNSpeechPhonon is missing but RN_SPEECH_PHONON_EXPECTED=1");
      return NO;
    }
    NSLog(@"[PhononTests] skipped: built without the Phonon add-on");
    return NO;
  }
  return YES;
}

- (id<RNSpeechPhononTesting>)newBridge {
  return [(id)self.phonon new];
}

- (NSString *)makeModelDirWithEntries:(NSArray<NSString *> *)entries bundleJson:(NSString *)json {
  NSString *dir = [self.tmpDir stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
  NSFileManager *fm = [NSFileManager defaultManager];
  [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  for (NSString *name in entries) {
    [fm createDirectoryAtPath:[dir stringByAppendingPathComponent:name]
        withIntermediateDirectories:YES
                         attributes:nil
                              error:nil];
  }
  if (json != nil) {
    [json writeToFile:[dir stringByAppendingPathComponent:@"bundle.json"]
           atomically:YES
             encoding:NSUTF8StringEncoding
                error:nil];
  }
  return dir;
}

#pragma mark - Support (§2.2)

- (void)testSupportInfoShape {
  if (![self requirePhonon]) return;
  NSDictionary *info = [self.phonon supportInfo];
  for (NSString *key in @[ @"supported", @"reason", @"detail", @"abi", @"osVersion",
                           @"libraryVersion", @"isSimulator", @"pageSize" ]) {
    XCTAssertNotNil(info[key], @"missing %@", key);
  }
  NSSet *reasons = [NSSet setWithArray:@[ @"ok", @"unsupported-abi", @"os-too-old", @"low-memory",
                                          @"load-failed", @"error" ]];
  XCTAssertTrue([reasons containsObject:info[@"reason"]], @"reason %@", info[@"reason"]);
  XCTAssertEqual([info[@"supported"] boolValue], [info[@"reason"] isEqualToString:@"ok"]);
  XCTAssertEqualObjects(info[@"abi"], [self.phonon abi]);
  XCTAssertGreaterThan([info[@"pageSize"] doubleValue], 0);
  XCTAssertGreaterThan([info[@"libraryVersion"] length], 0u);
  XCTAssertEqualObjects(info[@"libraryVersion"], [self.phonon libraryVersion]);
#if TARGET_OS_SIMULATOR
  XCTAssertTrue([info[@"isSimulator"] boolValue]);
#else
  XCTAssertFalse([info[@"isSimulator"] boolValue]);
#endif
}

- (void)testSupportGatesOnOsAndArchitecture {
  if (![self requirePhonon]) return;
  NSDictionary *info = [self.phonon supportInfo];
#if TARGET_OS_SIMULATOR && defined(__x86_64__)
  // The x86_64 simulator slice is a stub: never supported, but the app links and launches.
  XCTAssertEqualObjects(info[@"abi"], @"ios-x86_64-simulator");
  if (@available(iOS 18.0, *)) {
    XCTAssertEqualObjects(info[@"reason"], @"unsupported-abi");
  } else {
    XCTAssertEqualObjects(info[@"reason"], @"os-too-old");
  }
#else
  if (@available(iOS 18.0, *)) {
    if ([NSProcessInfo processInfo].physicalMemory >= (3ull << 30)) {
      XCTAssertEqualObjects(info[@"reason"], @"ok");
      XCTAssertTrue([info[@"supported"] boolValue]);
    } else {
      XCTAssertEqualObjects(info[@"reason"], @"low-memory");
    }
  } else {
    XCTAssertEqualObjects(info[@"reason"], @"os-too-old");
    XCTAssertFalse([info[@"supported"] boolValue]);
  }
#endif
}

#if DEBUG
- (void)testForcedReasonInDebug {
  if (![self requirePhonon]) return;
  setenv("RN_SPEECH_PHONON_FORCE_REASON", "symbols-missing", 1);
  NSDictionary *info = [self.phonon supportInfo];
  XCTAssertFalse([info[@"supported"] boolValue]);
  XCTAssertEqualObjects(info[@"reason"], @"symbols-missing");
  XCTAssertEqualObjects(info[@"detail"], @"forced");

  // Direct create never reaches the library.
  XCTestExpectation *rejected = [self expectationWithDescription:@"create rejects"];
  [[self newBridge] createWithModelDir:self.tmpDir
      language:@"en"
      computeUnit:@"cpu"
      resolve:^(id result) {
        XCTFail(@"create resolved on a forced-unsupported device");
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTAssertEqualObjects(code, @"PHONON_UNSUPPORTED");
        XCTAssertTrue([message containsString:@"symbols-missing"], @"%@", message);
        [rejected fulfill];
      }];
  [self waitForExpectations:@[ rejected ] timeout:5];
  unsetenv("RN_SPEECH_PHONON_FORCE_REASON");
  XCTAssertNotEqualObjects([self.phonon supportInfo][@"reason"], @"symbols-missing");
}
#endif

#pragma mark - Compute unit (§1.4)

- (void)testComputeUnitMapping {
  if (![self requirePhonon]) return;
  uint32_t unit = 99;
  XCTAssertEqualObjects([self.phonon effectiveComputeUnitFor:@"cpu" pttsUnit:&unit], @"cpu");
  XCTAssertEqual(unit, kUnitCpu);

  unit = 99;
  NSString *ne = [self.phonon effectiveComputeUnitFor:@"neuralEngine" pttsUnit:&unit];
  XCTAssertEqual(unit, kUnitAne);
#if TARGET_OS_SIMULATOR
  // No Neural Engine in the simulator: Core ML runs the request on the CPU, reported as such.
  XCTAssertEqualObjects(ne, @"cpu");
#else
  XCTAssertEqualObjects(ne, @"neuralEngine");
#endif

  // Anything else (including '') means the default, the Neural Engine.
  unit = 99;
  [self.phonon effectiveComputeUnitFor:@"" pttsUnit:&unit];
  XCTAssertEqual(unit, kUnitAne);
  XCTAssertNoThrow([self.phonon effectiveComputeUnitFor:@"cpu" pttsUnit:NULL]);
}

#pragma mark - Model files

- (void)testNeedsCompile {
  if (![self requirePhonon]) return;
  NSString *precompiled = [self makeModelDirWithEntries:@[ @"flow_t1.mlmodelc", @"mimi.mlmodelc" ]
                                             bundleJson:@"{}"];
  XCTAssertFalse([self.phonon needsCompile:precompiled]);
  NSString *source = [self makeModelDirWithEntries:@[ @"flow_t1.mlpackage", @"mimi.mlpackage",
                                                      @"mimi.mlmodelc" ]
                                        bundleJson:@"{}"];
  XCTAssertTrue([self.phonon needsCompile:source]);
  XCTAssertFalse([self.phonon needsCompile:[self.tmpDir stringByAppendingPathComponent:@"missing"]]);
}

#pragma mark - Capability store (§2.4)

- (void)testCapabilityStoreRoundTripAndKeying {
  if (![self requirePhonon]) return;
  XCTAssertEqualObjects([self.phonon capabilityStoreURL], self.storeURL);
  XCTAssertNil([self.phonon applicableCapabilityRecord]);

  NSString *model = [self makeModelDirWithEntries:@[] bundleJson:@"{\"v\":1}"];
  NSString *stamp = [self.phonon modelStampFor:model];
  XCTAssertEqual(stamp.length, 64u);
  XCTAssertEqualObjects([self.phonon modelStampFor:self.tmpDir], @"none");

  [self.phonon recordCapabilityFailure:@"load-failed"
                                detail:@"compileModelAtURL: E5RT"
                              modelDir:model];
  NSDictionary *rec = [self.phonon applicableCapabilityRecord];
  XCTAssertEqualObjects(rec[@"reason"], @"load-failed");
  XCTAssertEqualObjects(rec[@"modelStamp"], stamp);
  XCTAssertEqualObjects(rec[@"key"][@"libraryVersion"], [self.phonon libraryVersion]);

  // The record hides the engine, before the OS / memory checks.
  NSDictionary *info = [self.phonon supportInfo];
  XCTAssertFalse([info[@"supported"] boolValue]);
  XCTAssertEqualObjects(info[@"reason"], @"load-failed");
  XCTAssertEqualObjects(info[@"detail"], @"compileModelAtURL: E5RT");

  // Excluded from backup.
  NSNumber *excluded = nil;
  [self.storeURL getResourceValue:&excluded forKey:NSURLIsExcludedFromBackupKey error:nil];
  XCTAssertTrue(excluded.boolValue);

  // A changed model (new bundle.json) re-enables the probe.
  [@"{\"v\":2}" writeToFile:[model stringByAppendingPathComponent:@"bundle.json"]
                 atomically:YES
                   encoding:NSUTF8StringEncoding
                      error:nil];
  XCTAssertNil([self.phonon applicableCapabilityRecord]);
  XCTAssertNotEqualObjects([self.phonon supportInfo][@"reason"], @"load-failed");

  // Another library release re-enables it as well (key mismatch).
  [self.phonon recordCapabilityFailure:@"load-failed" detail:@"x" modelDir:model];
  XCTAssertNotNil([self.phonon applicableCapabilityRecord]);
  NSMutableDictionary *json = [[NSJSONSerialization
      JSONObjectWithData:[NSData dataWithContentsOfURL:self.storeURL]
                 options:NSJSONReadingMutableContainers
                   error:nil] mutableCopy];
  json[@"key"][@"libraryVersion"] = @"0.0.0-r0";
  [[NSJSONSerialization dataWithJSONObject:json options:0 error:nil] writeToURL:self.storeURL
                                                                    atomically:YES];
  XCTAssertNil([self.phonon applicableCapabilityRecord]);

  // Corrupt file: ignored, never throws.
  [@"not json" writeToURL:self.storeURL atomically:YES encoding:NSUTF8StringEncoding error:nil];
  XCTAssertNil([self.phonon applicableCapabilityRecord]);

  XCTAssertTrue([self.phonon clearCapabilityRecord]);
  XCTAssertTrue([self.phonon clearCapabilityRecord]);  // nothing left: still YES
  XCTAssertFalse([[NSFileManager defaultManager] fileExistsAtPath:self.storeURL.path]);
}

#pragma mark - Ids, cancel, buffers (no model needed)

- (void)testRequestIdsAreProcessWideAndMonotonic {
  if (![self requirePhonon]) return;
  id<RNSpeechPhononTesting> a = [self newBridge];
  id<RNSpeechPhononTesting> b = [self newBridge];  // a "reloaded" module: same core
  int64_t first = [a allocRequestId];
  int64_t second = [b allocRequestId];
  XCTAssertGreaterThan(first, 0);
  XCTAssertEqual(second, first + 1);
  [a invalidate];
  XCTAssertGreaterThan([b allocRequestId], second);

  XCTAssertTrue([b cancelUpTo:second]);
  NSDictionary *d = [b diagnostics];
  XCTAssertGreaterThanOrEqual([d[@"cancelWatermark"] longLongValue], second);
  XCTAssertGreaterThanOrEqual([d[@"lastIssuedId"] longLongValue], second + 1);
  // cancelAll does not poison later ids.
  XCTAssertTrue([b cancelAll]);
  int64_t next = [b allocRequestId];
  XCTAssertGreaterThan(next, [[b diagnostics][@"cancelWatermark"] longLongValue]);
}

- (void)testUnknownBuffers {
  if (![self requirePhonon]) return;
  id<RNSpeechPhononTesting> bridge = [self newBridge];
  XCTAssertNil([bridge takeBuffer:987654321 gain:1]);
  XCTAssertFalse([bridge releaseBuffer:987654321]);
  XCTestExpectation *rejected = [self expectationWithDescription:@"copy rejects"];
  [bridge copyBuffer:987654321
      resolve:^(id result) {
        XCTFail(@"resolved");
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTAssertEqualObjects(code, @"PHONON_INVALID_BUFFER");
        [rejected fulfill];
      }];
  [self waitForExpectations:@[ rejected ] timeout:5];
}

- (void)testStaleHandleRejectsOnTheSynthThread {
  if (![self requirePhonon]) return;
  id<RNSpeechPhononTesting> bridge = [self newBridge];
  int64_t rid = [bridge allocRequestId];
  XCTestExpectation *rejected = [self expectationWithDescription:@"synthesize rejects"];
  [bridge synthesizeWithHandle:424242
      requestId:rid
      text:@"Hello."
      voice:@""
      language:@"en"
      resolve:^(id result) {
        XCTFail(@"resolved %@", result);
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTAssertEqualObjects(code, @"PHONON_INVALID_HANDLE");
        [rejected fulfill];
      }];
  XCTestExpectation *destroyed = [self expectationWithDescription:@"destroy rejects"];
  [bridge destroyHandle:424242
      resolve:^(id result) {
        XCTFail(@"resolved");
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTAssertEqualObjects(code, @"PHONON_INVALID_HANDLE");
        [destroyed fulfill];
      }];
  [self waitForExpectations:@[ rejected, destroyed ] timeout:10];
}

- (void)testCancelledRequestResolvesCancelledWithoutTheLibrary {
  if (![self requirePhonon]) return;
  id<RNSpeechPhononTesting> bridge = [self newBridge];
  int64_t rid = [bridge allocRequestId];
  [bridge cancelUpTo:rid];
  XCTestExpectation *done = [self expectationWithDescription:@"cancelled"];
  [bridge synthesizeWithHandle:424242
      requestId:rid
      text:@"Hello."
      voice:@""
      language:@"en"
      resolve:^(NSDictionary *result) {
        XCTAssertTrue([result[@"cancelled"] boolValue]);
        XCTAssertEqual([result[@"bufferId"] longLongValue], 0);
        XCTAssertEqual([result[@"requestId"] longLongValue], rid);
        [done fulfill];
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTFail(@"rejected %@ %@", code, message);
      }];
  [self waitForExpectations:@[ done ] timeout:10];
}

// §1.5: after invalidate (RN reload) a module's pending promises are dropped, not settled.
- (void)testInvalidateDropsPendingPromises {
  if (![self requirePhonon]) return;
  id<RNSpeechPhononTesting> bridge = [self newBridge];
  int64_t rid = [bridge allocRequestId];
  XCTestExpectation *never = [self expectationWithDescription:@"never settles"];
  never.inverted = YES;
  [bridge invalidate];
  [bridge synthesizeWithHandle:424242
      requestId:rid
      text:@"Hello."
      voice:@""
      language:@"en"
      resolve:^(id result) {
        [never fulfill];
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        [never fulfill];
      }];
  [bridge copyBuffer:987654321
      resolve:^(id result) {
        [never fulfill];
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        [never fulfill];
      }];
  [self waitForExpectations:@[ never ] timeout:1.5];
  // invalidate cancelled everything issued so far.
  XCTAssertGreaterThanOrEqual([[bridge diagnostics][@"cancelWatermark"] longLongValue], rid);
  XCTAssertEqual([[bridge diagnostics][@"liveBuffers"] integerValue], 0);
}

- (void)testDiagnosticsShape {
  if (![self requirePhonon]) return;
  NSDictionary *d = [[self newBridge] diagnostics];
  for (NSString *key in @[ @"memKb", @"peakMemKb", @"threads", @"libraryLoaded", @"handleOpen",
                           @"liveBuffers", @"orphanBuffers", @"busy", @"lastIssuedId",
                           @"cancelWatermark" ]) {
    XCTAssertNotNil(d[key], @"missing %@", key);
  }
  XCTAssertGreaterThan([d[@"memKb"] doubleValue], 0);
  XCTAssertGreaterThanOrEqual([d[@"peakMemKb"] doubleValue], [d[@"memKb"] doubleValue] * 0.5);
  XCTAssertGreaterThan([d[@"threads"] doubleValue], 1);
  NSArray *phases = @[ @"idle", @"loading", @"compiling", @"speaking" ];
  XCTAssertTrue([phases containsObject:d[@"busy"]], @"busy %@", d[@"busy"]);
}

#pragma mark - TurboModule queues

// playBuffer is ordered with RNSpeech's stopAudio/pauseAudio only while both modules run on
// the TurboModule manager's shared queue (no own methodQueue); setup stays off the main queue.
- (void)testModuleQueues {
  if (![self requirePhonon]) return;
  Class module = NSClassFromString(@"RNSpeechPhononModule");
  Class core = NSClassFromString(@"RNSpeech");
  XCTAssertNotNil(module);
  XCTAssertNotNil(core);
  for (Class cls in @[ module, core ]) {
    XCTAssertFalse([cls instancesRespondToSelector:NSSelectorFromString(@"methodQueue")], @"%@", cls);
    SEL setup = NSSelectorFromString(@"requiresMainQueueSetup");
    XCTAssertTrue([cls respondsToSelector:setup], @"%@", cls);
    XCTAssertFalse(((BOOL(*)(id, SEL))objc_msgSend)(cls, setup), @"%@", cls);
  }
}

#pragma mark - Optional model smoke (PHONON_TEST_MODEL_DIR)

- (void)testModelSmoke {
  if (![self requirePhonon]) return;
  NSString *dir = NSProcessInfo.processInfo.environment[@"PHONON_TEST_MODEL_DIR"];
  if (dir.length == 0) {
    NSLog(@"[PhononTests] testModelSmoke skipped: PHONON_TEST_MODEL_DIR not set");
    return;
  }
  if (![[self.phonon supportInfo][@"supported"] boolValue]) {
    NSLog(@"[PhononTests] testModelSmoke skipped: %@", [self.phonon supportInfo][@"reason"]);
    return;
  }
  id<RNSpeechPhononTesting> bridge = [self newBridge];
  NSString *unit = NSProcessInfo.processInfo.environment[@"PHONON_TEST_COMPUTE_UNIT"] ?: @"neuralEngine";

  __block NSDictionary *load = nil;
  XCTestExpectation *created = [self expectationWithDescription:@"create"];
  [bridge createWithModelDir:dir
      language:@"en"
      computeUnit:unit
      resolve:^(NSDictionary *result) {
        load = result;
        [created fulfill];
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTFail(@"create rejected %@: %@", code, message);
        [created fulfill];
      }];
  // A first-ever load may compile Core ML (tens of seconds in the simulator).
  [self waitForExpectations:@[ created ] timeout:600];
  XCTAssertNotNil(load);
  XCTAssertEqual([load[@"sampleRate"] intValue], 24000);
  XCTAssertGreaterThan([load[@"handleId"] longLongValue], 0);
  XCTAssertGreaterThan([load[@"voices"] count], 0u);
  XCTAssertEqual([load[@"numThreads"] intValue], 0);
  NSLog(@"[PhononTests] load %@", load);

  int64_t handle = [load[@"handleId"] longLongValue];
  __block NSDictionary *synth = nil;
  XCTestExpectation *spoken = [self expectationWithDescription:@"synthesize"];
  [bridge synthesizeWithHandle:handle
      requestId:[bridge allocRequestId]
      text:@"Hello from Phonon on iOS."
      voice:@""
      language:@"en"
      resolve:^(NSDictionary *result) {
        synth = result;
        [spoken fulfill];
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTFail(@"synthesize rejected %@: %@", code, message);
        [spoken fulfill];
      }];
  [self waitForExpectations:@[ spoken ] timeout:120];
  NSLog(@"[PhononTests] synth %@", synth);
  XCTAssertFalse([synth[@"cancelled"] boolValue]);
  int64_t bufferId = [synth[@"bufferId"] longLongValue];
  int64_t samples = [synth[@"samples"] longLongValue];
  XCTAssertGreaterThan(bufferId, 0);
  XCTAssertGreaterThan(samples, 24000 / 2);

  XCTestExpectation *copied = [self expectationWithDescription:@"copy"];
  [bridge copyBuffer:bufferId
      resolve:^(NSString *b64) {
        NSData *data = [[NSData alloc] initWithBase64EncodedString:b64 options:0];
        XCTAssertEqual(data.length, (NSUInteger)samples * sizeof(float));
        [copied fulfill];
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTFail(@"copy rejected %@", code);
        [copied fulfill];
      }];
  [self waitForExpectations:@[ copied ] timeout:30];

  NSData *played = [bridge takeBuffer:bufferId gain:0.5f];
  XCTAssertEqual(played.length, (NSUInteger)samples * sizeof(float));
  const float *pcm = (const float *)played.bytes;
  float peak = 0;
  for (int64_t i = 0; i < samples; ++i) peak = MAX(peak, fabsf(pcm[i]));
  XCTAssertGreaterThan(peak, 0.001f);
  XCTAssertLessThanOrEqual(peak, 0.5f + 1e-6f);
  XCTAssertNil([bridge takeBuffer:bufferId gain:1]);  // consumed

  XCTestExpectation *destroyed = [self expectationWithDescription:@"destroy"];
  [bridge destroyHandle:handle
      resolve:^(id result) {
        [destroyed fulfill];
      }
      reject:^(NSString *code, NSString *message, NSError *error) {
        XCTFail(@"destroy rejected %@", code);
        [destroyed fulfill];
      }];
  [self waitForExpectations:@[ destroyed ] timeout:30];
  XCTAssertFalse([[bridge diagnostics][@"handleOpen"] boolValue]);
}

@end
