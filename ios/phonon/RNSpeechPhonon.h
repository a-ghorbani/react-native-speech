// RNSpeechPhonon.h — iOS bridge from RNSpeech (TurboModule) onto the shared Phonon core
// (cpp/phonon). Compiled only when the pod is installed with ENV['RN_SPEECH_PHONON'] = '1'.
// See docs/phonon/DESIGN.md §1.3–§1.5, §2.2, §2.4.
//
// Process-wide state (Core, the synth worker, the handle) is shared by every instance and
// survives RN reloads. One instance belongs to one RNSpeech module: its pending promises are
// dropped, never resolved into a dead runtime, once -invalidate is called.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^RNSpeechPhononResolve)(id _Nullable result);
typedef void (^RNSpeechPhononReject)(NSString *code, NSString *_Nullable message,
                                     NSError *_Nullable error);

@interface RNSpeechPhonon : NSObject

#pragma mark Support (cheap; never touches the Phonon library)

/// PhononSupportInfo: §2.2 order (DEBUG force reason, capability record, iOS 18, x86_64
/// simulator, physical memory).
+ (NSDictionary<NSString *, id> *)supportInfo;
/// e.g. "0.4.0-r1" (from phonon.lock.json via the podspec).
+ (NSString *)libraryVersion;
/// "ios-arm64" | "ios-arm64-simulator" | "ios-x86_64-simulator".
+ (NSString *)abi;
/// Any .mlpackage in `modelDir` without a compiled .mlmodelc beside it.
+ (BOOL)needsCompile:(NSString *)modelDir;
/// The one JS → PTTS_UNIT_* mapping (Core); returns the effective unit reported to JS.
+ (NSString *)effectiveComputeUnitFor:(NSString *)requested pttsUnit:(uint32_t *_Nullable)unit;

#pragma mark Capability store (Library/Application Support/rnspeech-phonon-cap.json)

+ (NSURL *)capabilityStoreURL;
/// The stored record if it still applies to this device / OS build / library / model.
+ (nullable NSDictionary<NSString *, id> *)applicableCapabilityRecord;
+ (void)recordCapabilityFailure:(NSString *)reason
                         detail:(NSString *)detail
                       modelDir:(nullable NSString *)modelDir;
/// Deletes the record; YES if none is left afterwards.
+ (BOOL)clearCapabilityRecord;
/// Tests only: redirect the store (nil restores the default).
+ (void)setCapabilityStoreURLForTesting:(nullable NSURL *)url;
/// sha256 of <modelDir>/bundle.json, "none" if unreadable.
+ (NSString *)modelStampFor:(nullable NSString *)modelDir;

#pragma mark Work (per-module instance)

- (void)createWithModelDir:(NSString *)modelDir
                  language:(NSString *)language
               computeUnit:(NSString *)computeUnit
                   resolve:(RNSpeechPhononResolve)resolve
                    reject:(RNSpeechPhononReject)reject;
/// Synchronous (JS thread); atomics only.
- (int64_t)allocRequestId;
- (BOOL)cancelUpTo:(int64_t)requestId;
- (BOOL)cancelAll;
- (void)synthesizeWithHandle:(int64_t)handleId
                   requestId:(int64_t)requestId
                        text:(NSString *)text
                       voice:(NSString *)voice
                    language:(NSString *)language
                     resolve:(RNSpeechPhononResolve)resolve
                      reject:(RNSpeechPhononReject)reject;
/// Moves the buffer out of the store as float32 mono samples with `gain` and [-1, 1] clamp
/// applied. nil if the id is unknown.
- (nullable NSData *)takeBuffer:(int64_t)bufferId gain:(float)gain;
/// Base64 little-endian float32 copy; the buffer stays in the store.
- (void)copyBuffer:(int64_t)bufferId
           resolve:(RNSpeechPhononResolve)resolve
            reject:(RNSpeechPhononReject)reject;
- (BOOL)releaseBuffer:(int64_t)bufferId;
/// Enqueued on the synth thread; settles after it ran (stale id: PHONON_INVALID_HANDLE).
- (void)destroyHandle:(int64_t)handleId
              resolve:(RNSpeechPhononResolve)resolve
               reject:(RNSpeechPhononReject)reject;
- (NSDictionary<NSString *, id> *)diagnostics;
/// RN reload / module teardown: cancelAll, free unplayed buffers, drop this instance's pending
/// promises. Returns at once; never destroys the handle or waits for the synth thread.
- (void)invalidate;

@end

NS_ASSUME_NONNULL_END
