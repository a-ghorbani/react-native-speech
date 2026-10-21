#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/** Process-wide sink onto RNSpeech's neural player, for engine add-ons. */
@interface RNSpeechAudioOutput : NSObject

/** nil until an RNSpeech module is alive. */
+ (nullable RNSpeechAudioOutput *)shared;

/**
 * Plays float32 samples in [-1, 1] the way playAudio plays its decoded PCM: stops the current
 * playback, emits onStart/onFinish, and resolves when playback finishes or is replaced.
 */
- (void)playFloatSamples:(NSData *)samples
              sampleRate:(double)sampleRate
                channels:(NSInteger)channels
                 ducking:(BOOL)ducking
              silentMode:(NSString *)silentMode
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject;

@end

NS_ASSUME_NONNULL_END
