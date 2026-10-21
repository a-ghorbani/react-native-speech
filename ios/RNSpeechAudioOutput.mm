#import "RNSpeechAudioOutput+Internal.h"

static __weak RNSpeech *gSpeech;

@implementation RNSpeechAudioOutput

+ (RNSpeech *)speech {
  @synchronized(self) {
    return gSpeech;
  }
}

+ (void)attach:(RNSpeech *)speech {
  @synchronized(self) {
    gSpeech = speech;
  }
}

+ (nullable RNSpeechAudioOutput *)shared {
  if ([self speech] == nil) {
    return nil;
  }
  static RNSpeechAudioOutput *instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    instance = [[RNSpeechAudioOutput alloc] init];
  });
  return instance;
}

- (void)playFloatSamples:(NSData *)samples
              sampleRate:(double)sampleRate
                channels:(NSInteger)channels
                 ducking:(BOOL)ducking
              silentMode:(NSString *)silentMode
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  RNSpeech *speech = [RNSpeechAudioOutput speech];
  if (speech == nil) {
    reject(@"audio_error", @"RNSpeech module is not alive", nil);
    return;
  }
  [speech playFloatSamples:samples
                sampleRate:sampleRate
                  channels:channels
                   ducking:ducking
                silentMode:silentMode
                   resolve:resolve
                    reject:reject];
}

@end
