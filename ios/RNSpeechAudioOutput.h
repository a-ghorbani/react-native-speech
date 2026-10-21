#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/** Process-wide sink onto RNSpeech's neural player, for engine add-ons. Stable within 2.x. */
@interface RNSpeechAudioOutput : NSObject

/** nil until an RNSpeech module is alive. */
+ (nullable RNSpeechAudioOutput *)shared;

/**
 * Plays interleaved float32 samples in [-1, 1] the way playAudio plays its decoded PCM: stops the current
 * playback, emits onStart/onFinish, and resolves when playback finishes or is replaced.
 * Callable from any thread; work runs on RNSpeech's serial audio queue.
 * channels must be 1 or 2 (values below 1 play as mono); more rejects with "audio_error" without
 * stopping the current playback.
 * silentMode: @"obey" (default; any other value behaves as obey), @"respect" or @"ignore", as
 * SynthesisOptions.silentMode; ignored when ducking is YES.
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
