#import "RNSpeechPhononModule.h"
#import "RNSpeechPhonon.h"
#import <React/RCTInvalidating.h>
#import <RNSpeech/RNSpeechAudioOutput.h>
#include "PhononIosPolicy.h"
#include <cmath>

@interface RNSpeechPhononModule () <RCTInvalidating>
@end

@implementation RNSpeechPhononModule
{
  RNSpeechPhonon *_phonon;
}

RCT_EXPORT_MODULE(RNSpeechPhonon)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if (self = [super init]) {
    _phonon = [[RNSpeechPhonon alloc] init];
  }
  return self;
}

// NaN/inf map to 0, which is never issued.
static int64_t RNSpeechPhononId(double v) {
  return std::isfinite(v) ? (int64_t)std::llround(v) : 0;
}

- (void)getSupport:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  resolve([RNSpeechPhonon supportInfo]);
}

- (void)needsCompile:(NSString *)modelDir
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  resolve(@([RNSpeechPhonon needsCompile:modelDir]));
}

- (void)create:(NSString *)modelDir
       options:(JS::NativeSpeechPhonon::PhononLoadOptions &)options
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject {
  // options references the call's arguments: read before going async.
  NSString *language = options.language() ?: @"en";
  NSString *computeUnit = options.computeUnit() ?: @"neuralEngine";
  [_phonon createWithModelDir:modelDir
                     language:language
                  computeUnit:computeUnit
                      resolve:resolve
                       reject:reject];
}

- (NSNumber *)allocRequestId {
  return @((double)[_phonon allocRequestId]);
}

- (void)synthesize:(double)handleId
         requestId:(double)requestId
              text:(NSString *)text
             voice:(NSString *)voice
          language:(NSString *)language
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  [_phonon synthesizeWithHandle:RNSpeechPhononId(handleId)
                      requestId:RNSpeechPhononId(requestId)
                           text:text ?: @""
                          voice:voice ?: @""
                       language:language ?: @""
                        resolve:resolve
                         reject:reject];
}

- (NSNumber *)cancel:(double)upToRequestId {
  return @([_phonon cancelUpTo:RNSpeechPhononId(upToRequestId)]);
}

- (NSNumber *)cancelAll {
  return @([_phonon cancelAll]);
}

// Ordered with RNSpeech's stopAudio/pauseAudio only because neither module declares a
// methodQueue (RN >= 0.74 runs both on the TurboModule manager's shared serial queue).
- (void)playBuffer:(double)bufferId
            config:(JS::NativeSpeechPhonon::PhononPlayConfig &)config
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  double sampleRate = config.sampleRate();
  BOOL ducking = config.ducking().value_or(false);
  NSString *silentMode = config.silentMode() ?: @"obey";
  std::optional<double> volume = config.volume();
  float gain = rnspeech::phonon::ios::playback_gain(volume.value_or(1.0), volume.has_value());

  // Checked before the take, so the buffer stays releasable on failure.
  RNSpeechAudioOutput *output = [RNSpeechAudioOutput shared];
  if (output == nil) {
    reject(@"PHONON_INTERNAL", @"The RNSpeech native module is not available", nil);
    return;
  }
  // Taken on the calling thread: consumed even if playback is interrupted; unknown ids reject now.
  int64_t bid = RNSpeechPhononId(bufferId);
  NSData *samples = [_phonon takeBuffer:bid gain:gain];
  if (samples == nil) {
    reject(@"PHONON_INVALID_BUFFER",
           [NSString stringWithFormat:@"unknown Phonon buffer %lld", (long long)bid], nil);
    return;
  }
  [output playFloatSamples:samples
                sampleRate:sampleRate
                  channels:1
                   ducking:ducking
                silentMode:silentMode
                   resolve:resolve
                    reject:reject];
}

- (void)copyBuffer:(double)bufferId
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  [_phonon copyBuffer:RNSpeechPhononId(bufferId) resolve:resolve reject:reject];
}

- (NSNumber *)releaseBuffer:(double)bufferId {
  return @([_phonon releaseBuffer:RNSpeechPhononId(bufferId)]);
}

- (void)destroy:(double)handleId
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  [_phonon destroyHandle:RNSpeechPhononId(handleId) resolve:resolve reject:reject];
}

- (void)getDiagnostics:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  resolve([_phonon diagnostics]);
}

// +supportInfo is not cached on iOS, so clearing the record is enough.
- (void)resetSupport:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  resolve(@([RNSpeechPhonon clearCapabilityRecord]));
}

- (void)invalidate {
  [_phonon invalidate];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeSpeechPhononSpecJSI>(params);
}

@end
