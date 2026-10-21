// iOS bridge onto the shared Phonon core (cpp/phonon); docs/phonon/DESIGN.md §1.3–§1.5, §2.2, §2.4.
// Core, worker and handle are process-wide and survive RN reloads. Each instance belongs to one
// RNSpeech module; after -invalidate its pending promises are dropped, never settled.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^RNSpeechPhononResolve)(id _Nullable result);
typedef void (^RNSpeechPhononReject)(NSString *code, NSString *_Nullable message,
                                     NSError *_Nullable error);

@interface RNSpeechPhonon : NSObject

#pragma mark Support (never touches the Phonon library)

/// PhononSupportInfo, decided in §2.2 order.
+ (NSDictionary<NSString *, id> *)supportInfo;
/// From phonon.lock.json via the podspec, e.g. "0.4.0-r1".
+ (NSString *)libraryVersion;
/// "ios-arm64" | "ios-arm64-simulator" | "ios-x86_64-simulator".
+ (NSString *)abi;
/// Any .mlpackage in `modelDir` lacks a sibling .mlmodelc.
+ (BOOL)needsCompile:(NSString *)modelDir;
/// Maps a JS compute unit to PTTS_UNIT_*; returns the effective unit reported to JS.
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
/// Moves the buffer out of the store with `gain` and a [-1, 1] clamp applied; nil if unknown.
- (nullable NSData *)takeBuffer:(int64_t)bufferId gain:(float)gain;
/// Base64 little-endian float32 copy; the buffer stays in the store.
- (void)copyBuffer:(int64_t)bufferId
           resolve:(RNSpeechPhononResolve)resolve
            reject:(RNSpeechPhononReject)reject;
- (BOOL)releaseBuffer:(int64_t)bufferId;
/// Queued behind in-flight work on the synth thread; a stale id rejects PHONON_INVALID_HANDLE.
- (void)destroyHandle:(int64_t)handleId
              resolve:(RNSpeechPhononResolve)resolve
               reject:(RNSpeechPhononReject)reject;
- (NSDictionary<NSString *, id> *)diagnostics;
/// cancelAll, free unplayed buffers and drop pending promises. Never destroys the handle or
/// waits for the synth thread.
- (void)invalidate;

@end

NS_ASSUME_NONNULL_END
