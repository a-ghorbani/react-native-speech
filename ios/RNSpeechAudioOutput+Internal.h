#import "RNSpeechAudioOutput.h"

#import "RNSpeech.h"

NS_ASSUME_NONNULL_BEGIN

@interface RNSpeechAudioOutput (Internal)
/** Called by RNSpeech's init; the newest module wins. */
+ (void)attach:(RNSpeech *)speech;
@end

@interface RNSpeech ()
- (void)playFloatSamples:(NSData *)samples
              sampleRate:(double)sampleRate
                channels:(NSInteger)channels
                 ducking:(BOOL)ducking
              silentMode:(NSString *)silentMode
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject;
@end

NS_ASSUME_NONNULL_END
