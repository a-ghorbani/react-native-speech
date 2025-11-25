#import <RNSpeechSpec/RNSpeechSpec.h>
#import "AVFoundation/AVFoundation.h"

@interface RNSpeech : NativeSpeechSpecBase <NativeSpeechSpec, AVSpeechSynthesizerDelegate>
// OS TTS properties
@property (nonatomic, strong) AVSpeechSynthesizer *synthesizer;
@property (nonatomic, strong) NSDictionary *globalOptions;

// Neural audio player properties
@property (nonatomic, strong) AVAudioEngine *audioEngine;
@property (nonatomic, strong) AVAudioPlayerNode *playerNode;
@property (nonatomic, assign) BOOL isAudioPlaying;
@property (nonatomic, assign) BOOL isAudioPaused;
@property (nonatomic, assign) BOOL isAudioDucking;
@property (nonatomic, assign) NSInteger currentAudioUtteranceId;
@property (nonatomic, strong) dispatch_queue_t audioQueue;

@end
