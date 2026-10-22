#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Process-wide sink onto RNSpeech's neural player, for engine add-ons.
 * EXPERIMENTAL: may change in a minor release until a second add-on exists; add-ons should pin a
 * tilde range (~2.7.0) on the core.
 */
@interface RNSpeechAudioOutput : NSObject

/** nil until an RNSpeech module is alive. */
+ (nullable RNSpeechAudioOutput *)shared;

/**
 * Plays interleaved float32 samples in [-1, 1] like playAudio: stops the current playback, emits
 * onStart/onFinish, and resolves when playback finishes, is stopped or is replaced.
 * Callable from any thread; work runs on RNSpeech's serial audio queue.
 * Calls from a TurboModule with no methodQueue of its own are ordered with RNSpeech's JS-called
 * stopAudio/pauseAudio on RN >= 0.74.
 * channels must be 1 or 2 (below 1 plays as mono); more rejects with "audio_error" without stopping
 * the current playback.
 * silentMode: as SynthesisOptions.silentMode (@"obey", @"respect", @"ignore"; unknown values obey);
 * ignored when ducking is YES.
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
