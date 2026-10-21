#import "RNSpeech.h"
#import "RNSpeechTrace.h"
#import "NativeDictWrapper.h"
#import <React/RCTLog.h>
#import <unistd.h>
#if RN_SPEECH_PHONON
#import <React/RCTInvalidating.h>
#import "phonon/RNSpeechPhonon.h"
#include "phonon/PhononIosPolicy.h"
#include <cmath>
#endif

using namespace JS::NativeSpeech;

#if RN_SPEECH_PHONON
@interface RNSpeech () <RCTInvalidating>
@end
#endif

@implementation RNSpeech
{
  BOOL isDucking;
  NSDictionary *defaultOptions;
#if RN_SPEECH_PHONON
  RNSpeechPhonon *_phonon;
#endif
}

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (NSDictionary<NSString *, id> *)constantsToExport
{
  return @{};
}

- (NSDictionary<NSString *, id> *)getConstants
{
  return [self constantsToExport];
}

- (instancetype)init {
  self = [super init];

  if (self) {
    // Initialize OS TTS
    _synthesizer = [[AVSpeechSynthesizer alloc] init];
    _synthesizer.delegate = self;

    defaultOptions = @{
      @"pitch": @(1.0),
      @"volume": @(1.0),
      @"ducking": @(NO),
      @"silentMode": @"obey",
      @"rate": @(AVSpeechUtteranceDefaultSpeechRate),
      @"language": [AVSpeechSynthesisVoice currentLanguageCode] ?: @"en-US"
    };
    self.globalOptions = [defaultOptions copy];

    // Initialize neural audio player
    _audioEngine = [[AVAudioEngine alloc] init];
    _playerNode = [[AVAudioPlayerNode alloc] init];
    [_audioEngine attachNode:_playerNode];

    _isAudioPlaying = NO;
    _isAudioPaused = NO;
    _isAudioDucking = NO;
    _currentAudioUtteranceId = 0;
    _audioQueue = dispatch_queue_create("com.speech.neuralaudioplayer", DISPATCH_QUEUE_SERIAL);
#if RN_SPEECH_PHONON
    // Bridges onto the process-wide Phonon core; this module's promises only.
    _phonon = [[RNSpeechPhonon alloc] init];
#endif

    // Initialize trace instrumentation (no-op if RN_SPEECH_TRACE is not defined)
    RNSpeechTraceInit();

    // Setup audio session interruption handling
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(handleAudioInterruption:)
                                                 name:AVAudioSessionInterruptionNotification
                                               object:nil];

    // Best-effort default audio session category so interruption notifications
    // fire reliably. Ducking / silentMode overrides call setCategory explicitly
    // with their own options and take precedence.
    NSError *categoryError = nil;
    [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayback
                                            mode:AVAudioSessionModeSpokenAudio
                                         options:0
                                           error:&categoryError];
    if (categoryError) {
      NSLog(@"[Speech] Failed to set default audio session category: %@", categoryError.localizedDescription);
    }
  }
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [self cleanupAudio];
}

- (void)handleAudioInterruption:(NSNotification *)notification {
  NSNumber *interruptionType = notification.userInfo[AVAudioSessionInterruptionTypeKey];

  if (interruptionType.unsignedIntegerValue == AVAudioSessionInterruptionTypeBegan) {
    if (_isAudioPlaying) {
      [self pauseAudioInternal];
    }
    // Pause OS TTS as well (idempotent if not speaking).
    if (self.synthesizer.isSpeaking && !self.synthesizer.isPaused) {
      [self.synthesizer pauseSpeakingAtBoundary:AVSpeechBoundaryImmediate];
    }
    [self emitOnAudioInterruption:@{@"type": @"began"}];
  } else if (interruptionType.unsignedIntegerValue == AVAudioSessionInterruptionTypeEnded) {
    NSNumber *interruptionOption = notification.userInfo[AVAudioSessionInterruptionOptionKey];
    BOOL shouldResume = interruptionOption.unsignedIntegerValue == AVAudioSessionInterruptionOptionShouldResume;
    if (shouldResume) {
      if (_isAudioPaused) {
        [self resumeAudioInternal];
      }
      if (self.synthesizer.isPaused) {
        [self.synthesizer continueSpeaking];
      }
    }
    [self emitOnAudioInterruption:@{@"type": @"ended", @"shouldResume": @(shouldResume)}];
  }
}

- (void)activateDuckingSession {
  if (!isDucking) {
    return;
  }
  NSError *error = nil;
  AVAudioSession *session = [AVAudioSession sharedInstance];

  [session setCategory:AVAudioSessionCategoryPlayback
            mode:AVAudioSessionModeSpokenAudio
            options:AVAudioSessionCategoryOptionDuckOthers
                  error:&error];
  if (error) {
    NSLog(@"[Speech] Failed to set audio session configuration for ducking: %@", error.localizedDescription);
    return;
  }
  [session setActive:YES error:&error];
  if (error) {
    NSLog(@"[Speech] Failed to activate audio session for ducking: %@", error.localizedDescription);
  }
}

- (void)deactivateDuckingSession {
  if (!isDucking) {
    return;
  }
  NSError *error = nil;
  [[AVAudioSession sharedInstance] setActive:NO
                                 withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                       error:&error];

  if (error) {
    NSLog(@"[Speech] AVAudioSession setActive (deactivate) error: %@", error.localizedDescription);
  }
}

- (void)configureSilentModeSession:(NSString *)silentMode {
  if (isDucking || [silentMode isEqualToString:@"obey"]) {
    return;
  }
  NSError *error = nil;
  if ([silentMode isEqualToString:@"ignore"]) {
     [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayback
             mode:AVAudioSessionModeSpokenAudio
             options:AVAudioSessionCategoryOptionInterruptSpokenAudioAndMixWithOthers
                   error:&error];
  } else if ([silentMode isEqualToString:@"respect"]) {
    [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryAmbient error:&error];
  }
  if (error) {
    NSLog(@"[Speech] AVAudioSession setCategory error: %@", error.localizedDescription);
  }
}

- (NSDictionary *)getEventData:(AVSpeechUtterance *)utterance {
  return @{
    @"id": @(utterance.hash)
  };
}

- (NSDictionary *)getVoiceItem:(AVSpeechSynthesisVoice *)voice {
  return @{
    @"name": voice.name,
    @"language": voice.language,
    @"identifier": voice.identifier,
    @"quality": voice.quality == AVSpeechSynthesisVoiceQualityEnhanced ? @"Enhanced" : @"Default"
  };
}

- (NSDictionary *)getValidatedOptions:(VoiceOptions &)options {
  NSMutableDictionary *validatedOptions = [self.globalOptions mutableCopy];

  if (options.ducking()) {
    validatedOptions[@"ducking"] = @(options.ducking().value());
  }
  if (options.voice()) {
    validatedOptions[@"voice"] = options.voice();
  }
  if (options.language()) {
    validatedOptions[@"language"] = options.language();
  }
  if (options.silentMode()) {
    validatedOptions[@"silentMode"] = options.silentMode();
  }
  if (options.pitch()) {
    float pitch = MAX(0.5, MIN(2.0, options.pitch().value()));
    validatedOptions[@"pitch"] = @(pitch);
  }
  if (options.volume()) {
    float volume = MAX(0, MIN(1.0, options.volume().value()));
    validatedOptions[@"volume"] = @(volume);
  }
  if (options.rate()) {
    float rate = MAX(AVSpeechUtteranceMinimumSpeechRate,
                    MIN(AVSpeechUtteranceMaximumSpeechRate, options.rate().value()));
    validatedOptions[@"rate"] = @(rate);
  }
  return validatedOptions;
}

- (AVSpeechUtterance *)getUtterance:(NSString *)text withOptions:(NSDictionary *)options {
  AVSpeechUtterance *utterance = [[AVSpeechUtterance alloc] initWithString:text];

  if (options[@"voice"]) {
    AVSpeechSynthesisVoice *voice = [AVSpeechSynthesisVoice voiceWithIdentifier:options[@"voice"]];
    if (voice) {
      utterance.voice = voice;
    }
  } else if (options[@"language"]) {
    utterance.voice = [AVSpeechSynthesisVoice voiceWithLanguage:options[@"language"]];
  }
  utterance.rate = [options[@"rate"] floatValue];
  utterance.volume = [options[@"volume"] floatValue];
  utterance.pitchMultiplier = [options[@"pitch"] floatValue];

  return utterance;
}

- (void)initialize:(VoiceOptions &)options {
  NSMutableDictionary *newOptions = [NSMutableDictionary dictionaryWithDictionary:self.globalOptions];
  NSDictionary *validatedOptions = [self getValidatedOptions:options];
  [newOptions addEntriesFromDictionary:validatedOptions];
  self.globalOptions = newOptions;
}

- (void)reset {
  self.globalOptions = [defaultOptions copy];
}

- (void)getAvailableVoices:(NSString *)language
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  NSMutableArray *voicesArray = [NSMutableArray new];
  NSArray *speechVoices = [AVSpeechSynthesisVoice speechVoices];

  // Treat empty string as nil (no language filter)
  if (language && language.length > 0) {
    NSString *lowercaseLanguage = [language lowercaseString];

    for (AVSpeechSynthesisVoice *voice in speechVoices) {
      if ([[voice.language lowercaseString] hasPrefix:lowercaseLanguage]) {
        [voicesArray addObject:[self getVoiceItem:voice]];
      }
    }
  } else {
    for (AVSpeechSynthesisVoice *voice in speechVoices) {
      [voicesArray addObject:[self getVoiceItem:voice]];
    }
  }
  resolve(voicesArray);
}

- (void)openVoiceDataInstaller:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  resolve(nil);
}

- (void)getEngines:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  resolve(@[]);
}

- (void)setEngine:(NSString *)engineName
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  resolve(nil);
}

- (void)isSpeaking:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  resolve(@(self.synthesizer.isSpeaking));
}

- (void)stop:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  if (self.synthesizer.isSpeaking) {
    [self.synthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }
  resolve(nil);
}

- (void)pause:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  if (self.synthesizer.isSpeaking && !self.synthesizer.isPaused) {
    BOOL paused = [self.synthesizer pauseSpeakingAtBoundary:AVSpeechBoundaryImmediate];
    [self deactivateDuckingSession];
    resolve(@(paused));
  } else {
    resolve(@(false));
  }
}

- (void)resume:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  if (self.synthesizer.isPaused) {
    [self activateDuckingSession];
    BOOL resumed = [self.synthesizer continueSpeaking];
    resolve(@(resumed));
  } else {
    resolve(@(false));
  }
}

- (void)speak:(NSString *)text
    resolve:(RCTPromiseResolveBlock)resolve
    reject:(RCTPromiseRejectBlock)reject
{
  if (!text) {
    reject(@"speech_error", @"Text cannot be null", nil);
    return;
  }

  AVSpeechUtterance *utterance;
 
  @try {
    isDucking = [self.globalOptions[@"ducking"] boolValue];

    [self activateDuckingSession];
    [self configureSilentModeSession:self.globalOptions[@"silentMode"]];

    utterance = [self getUtterance:text withOptions:self.globalOptions];
    [self.synthesizer speakUtterance:utterance];
    resolve(nil);
  }
  @catch (NSException *exception) {
    [self deactivateDuckingSession];
    [self emitOnError:[self getEventData:utterance]];
    reject(@"speech_error", exception.reason, nil);
  }
}

- (void)speakWithOptions:(NSString *)text
    options:(VoiceOptions &)options
    resolve:(RCTPromiseResolveBlock)resolve
    reject:(RCTPromiseRejectBlock)reject
{
  if (!text) {
    reject(@"speech_error", @"Text cannot be null", nil);
    return;
  }
  
  AVSpeechUtterance *utterance;

  @try {
    NSDictionary *validatedOptions = [self getValidatedOptions:options];
    isDucking = [validatedOptions[@"ducking"] boolValue];

    [self activateDuckingSession];
    [self configureSilentModeSession:validatedOptions[@"silentMode"]];
    
    utterance = [self getUtterance:text withOptions:validatedOptions];
    [self.synthesizer speakUtterance:utterance];
    resolve(nil);
  }
  @catch (NSException *exception) {
    [self deactivateDuckingSession];
    [self emitOnError:[self getEventData:utterance]];
    reject(@"speech_error", exception.reason, nil);
  }
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
  didStartSpeechUtterance:(AVSpeechUtterance *)utterance {
  [self emitOnStart:[self getEventData:utterance]];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
  willSpeakRangeOfSpeechString:(NSRange)characterRange utterance:(AVSpeechUtterance *)utterance {
  [self emitOnProgress:@{
    @"id": @(utterance.hash),
    @"length": @(characterRange.length),
    @"location": @(characterRange.location)
  }];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
  didFinishSpeechUtterance:(AVSpeechUtterance *)utterance {
  [self deactivateDuckingSession];
  [self emitOnFinish:[self getEventData:utterance]];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
  didPauseSpeechUtterance:(nonnull AVSpeechUtterance *)utterance {
  [self emitOnPause:[self getEventData:utterance]];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
  didContinueSpeechUtterance:(nonnull AVSpeechUtterance *)utterance {
  [self emitOnResume:[self getEventData:utterance]];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
  didCancelSpeechUtterance:(AVSpeechUtterance *)utterance {
  [self deactivateDuckingSession];
  [self emitOnStopped:[self getEventData:utterance]];
}

// MARK: - Neural Audio Player Methods

- (void)activateAudioSession:(BOOL)ducking silentMode:(NSString *)silentMode {
  AVAudioSession *audioSession = [AVAudioSession sharedInstance];
  NSError *error = nil;

  AVAudioSessionCategory category;
  AVAudioSessionCategoryOptions options = 0;

  if (ducking) {
    category = AVAudioSessionCategoryPlayback;
    options = AVAudioSessionCategoryOptionDuckOthers;
  } else {
    if ([silentMode isEqualToString:@"respect"]) {
      category = AVAudioSessionCategoryAmbient;
    } else if ([silentMode isEqualToString:@"ignore"]) {
      category = AVAudioSessionCategoryPlayback;
    } else { // obey: TTS should be heard by default
      category = AVAudioSessionCategoryPlayback;
    }
  }

  [audioSession setCategory:category withOptions:options error:&error];
  if (error) {
    RCTLogError(@"Failed to set audio session category: %@", error.localizedDescription);
  }

  [audioSession setActive:YES error:&error];
  if (error) {
    RCTLogError(@"Failed to activate audio session: %@", error.localizedDescription);
  }
}

- (void)deactivateAudioSession {
  AVAudioSession *audioSession = [AVAudioSession sharedInstance];
  NSError *error = nil;
  [audioSession setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:&error];
  if (error) {
    RCTLogError(@"Failed to deactivate audio session: %@", error.localizedDescription);
  }
}

- (void)cleanupAudio {
  if (_audioEngine.isRunning) {
    [_audioEngine stop];
  }
  [_playerNode stop];
  _isAudioPlaying = NO;
  _isAudioPaused = NO;
}

- (NSDictionary *)getAudioEventData {
  return @{
    @"id": @(_currentAudioUtteranceId)
  };
}

- (void)pauseAudioInternal {
  [_playerNode pause];
  _isAudioPaused = YES;
}

- (void)resumeAudioInternal {
  [_playerNode play];
  _isAudioPaused = NO;
}

- (void)playAudio:(NSString *)audioData
           config:(AudioPlayerConfig &)config
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {

  // Extract config values before async block (config is passed by reference and will be deallocated)
  double sampleRate = config.sampleRate();
  NSInteger channels = (NSInteger)config.channels();
  BOOL ducking = config.ducking().value_or(false);
  NSString *silentMode = config.silentMode() ?: @"obey";

  dispatch_async(_audioQueue, ^{
    RNSpeechTraceHandle traceHandle = RNSpeechTraceBegin("playAudio",
        [NSString stringWithFormat:@"sampleRate=%f channels=%ld", sampleRate, (long)channels]);
    @try {
      // Stop any current playback
      [self cleanupAudio];

      // Increment utterance ID
      self->_currentAudioUtteranceId++;

      // Decode base64 audio data
      NSData *decodedData = [[NSData alloc] initWithBase64EncodedString:audioData options:0];
      if (!decodedData) {
        reject(@"audio_error", @"Failed to decode base64 audio data", nil);
        return;
      }

      // Convert Int16 PCM to Float32 for AVAudioEngine
      const int16_t *int16Samples = (const int16_t *)decodedData.bytes;
      NSUInteger sampleCount = decodedData.length / sizeof(int16_t);

      NSMutableData *floatData = [NSMutableData dataWithLength:sampleCount * sizeof(float)];
      if (!floatData) {
        reject(@"audio_error", @"Failed to allocate memory for audio conversion", nil);
        return;
      }
      float *float32Samples = (float *)floatData.mutableBytes;

      // Convert Int16 to Float32 (normalize to -1.0 to 1.0)
      for (NSUInteger i = 0; i < sampleCount; i++) {
        float32Samples[i] = int16Samples[i] / 32768.0f;
      }

      [self playFloatSamplesOnAudioQueue:floatData
                              sampleRate:sampleRate
                                channels:channels
                                 ducking:ducking
                              silentMode:silentMode
                             traceHandle:traceHandle
                               traceName:"playAudio"
                                 resolve:resolve
                                  reject:reject];
    }
    @catch (NSException *exception) {
      RNSpeechTraceEnd(traceHandle, "playAudio");
      reject(@"audio_error", exception.reason, nil);
    }
  });
}

// Shared playback entry point of the base64 int16 path (playAudio) and the native Phonon
// buffer path (phononPlayBuffer): float32 samples, already scaled. Must run on _audioQueue,
// after the caller stopped the current playback and bumped the utterance id. Resolves when
// playback completes (or is interrupted), so chunks play back to back.
- (void)playFloatSamplesOnAudioQueue:(NSData *)floatSamples
                          sampleRate:(double)sampleRate
                            channels:(NSInteger)channels
                             ducking:(BOOL)ducking
                          silentMode:(NSString *)silentMode
                         traceHandle:(RNSpeechTraceHandle)traceHandle
                           traceName:(const char *)traceName
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject {
  NSUInteger sampleCount = floatSamples.length / sizeof(float);

  // Create audio format
  AVAudioFormat *audioFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sampleRate
                                                                               channels:(AVAudioChannelCount)channels];

  // Create audio buffer
  AVAudioPCMBuffer *pcmBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:audioFormat
                                                               frameCapacity:(AVAudioFrameCount)sampleCount];
  if (!pcmBuffer) {
    // Zero samples (or an unusable format): nothing to schedule.
    RNSpeechTraceEnd(traceHandle, traceName);
    reject(@"audio_error", @"Failed to create audio buffer", nil);
    return;
  }
  pcmBuffer.frameLength = (AVAudioFrameCount)sampleCount;

  // Copy samples to buffer
  memcpy(pcmBuffer.floatChannelData[0], floatSamples.bytes, sampleCount * sizeof(float));

  // Configure audio session
  self->_isAudioDucking = ducking;

  [self activateAudioSession:self->_isAudioDucking silentMode:silentMode];

  // Connect player node to engine output
  [self->_audioEngine connect:self->_playerNode
                           to:self->_audioEngine.mainMixerNode
                       format:audioFormat];

  // Start audio engine
  NSError *error = nil;
  if (!self->_audioEngine.isRunning) {
    [self->_audioEngine startAndReturnError:&error];
    if (error) {
      RNSpeechTraceEnd(traceHandle, traceName);
      reject(@"audio_error", [NSString stringWithFormat:@"Failed to start audio engine: %@", error.localizedDescription], error);
      return;
    }
  }

  self->_isAudioPlaying = YES;
  self->_isAudioPaused = NO;

  // Emit onStart event
  [self emitOnStart:[self getAudioEventData]];

  // Schedule buffer for playback
  // We need to resolve the promise when playback completes, not when it starts
  // This allows sequential chunk playback to work correctly
  __weak RNSpeech *weakSelf = self;
  [self->_playerNode scheduleBuffer:pcmBuffer
                     atTime:nil
                    options:AVAudioPlayerNodeBufferInterrupts
          completionHandler:^{
    RNSpeech *strongSelf = weakSelf;
    if (strongSelf) {
      dispatch_async(strongSelf->_audioQueue, ^{
        strongSelf->_isAudioPlaying = NO;
        [strongSelf deactivateAudioSession];
        RNSpeechTraceEnd(traceHandle, traceName);
        [strongSelf emitOnFinish:[strongSelf getAudioEventData]];
        // Resolve promise when playback is complete
        resolve(nil);
      });
    }
  }];

  // Start playback
  [self->_playerNode play];
}

- (void)stopAudio:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_audioQueue, ^{
    [self cleanupAudio];
    [self deactivateAudioSession];
    [self emitOnStopped:[self getAudioEventData]];
    resolve(nil);
  });
}

- (void)pauseAudio:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_audioQueue, ^{
    if (self->_isAudioPlaying && !self->_isAudioPaused) {
      [self pauseAudioInternal];
      [self emitOnPause:[self getAudioEventData]];
      resolve(@(YES));
    } else {
      resolve(@(NO));
    }
  });
}

- (void)resumeAudio:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_audioQueue, ^{
    if (self->_isAudioPaused) {
      [self resumeAudioInternal];
      [self emitOnResume:[self getAudioEventData]];
      resolve(@(YES));
    } else {
      resolve(@(NO));
    }
  });
}

- (void)isAudioPlaying:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_audioQueue, ^{
    resolve(@(self->_isAudioPlaying));
  });
}

- (void)dictOpen:(NSString *)path
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    NSError *error = nil;
    BOOL ok = [NativeDictWrapper openDict:path error:&error];
    if (!ok) {
      reject(@"DICT_OPEN_ERROR",
             error.localizedDescription ?: @"Failed to open dict",
             error);
      return;
    }
    resolve(@(YES));
  });
}

- (NSString *)dictLookup:(NSString *)word {
  return [NativeDictWrapper lookupWord:word];
}

#pragma mark - Phonon

#if !RN_SPEECH_PHONON
// Flag-off stubs (pod installed without ENV['RN_SPEECH_PHONON'] = '1').
// Support resolves `not-compiled`, work methods reject PHONON_NOT_COMPILED,
// sync methods return 0/NO. No Phonon code or binary is linked.

static NSString *const kPhononNotCompiled = @"PHONON_NOT_COMPILED";
static NSString *const kPhononNotCompiledMessage =
    @"Phonon is not compiled into this build (set ENV['RN_SPEECH_PHONON'] = '1' in the Podfile)";

static NSString *RNSpeechPhononStubAbi(void) {
#if TARGET_OS_SIMULATOR
#if defined(__x86_64__)
  return @"ios-x86_64-simulator";
#else
  return @"ios-arm64-simulator";
#endif
#else
  return @"ios-arm64";
#endif
}

- (void)phononGetSupport:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  static dispatch_once_t logOnce;
  dispatch_once(&logOnce, ^{
    RCTLogInfo(@"[Phonon] unsupported: not-compiled");
  });
  NSOperatingSystemVersion v = [[NSProcessInfo processInfo] operatingSystemVersion];
  resolve(@{
    @"supported": @(NO),
    @"reason": @"not-compiled",
    @"detail": @"built without RN_SPEECH_PHONON",
    @"abi": RNSpeechPhononStubAbi(),
    @"osVersion": [NSString stringWithFormat:@"%ld.%ld.%ld",
                   (long)v.majorVersion, (long)v.minorVersion, (long)v.patchVersion],
    @"libraryVersion": @"",
    @"isSimulator": @(TARGET_OS_SIMULATOR ? YES : NO),
    @"pageSize": @((double)getpagesize()),
  });
}

- (void)phononNeedsCompile:(NSString *)modelDir
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  reject(kPhononNotCompiled, kPhononNotCompiledMessage, nil);
}

- (void)phononCreate:(NSString *)modelDir
             options:(JS::NativeSpeech::PhononLoadOptions &)options
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  reject(kPhononNotCompiled, kPhononNotCompiledMessage, nil);
}

- (NSNumber *)phononAllocRequestId {
  return @(0);
}

- (void)phononSynthesize:(double)handleId
               requestId:(double)requestId
                    text:(NSString *)text
                   voice:(NSString *)voice
                language:(NSString *)language
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  reject(kPhononNotCompiled, kPhononNotCompiledMessage, nil);
}

- (NSNumber *)phononCancel:(double)upToRequestId {
  return @(NO);
}

- (NSNumber *)phononCancelAll {
  return @(NO);
}

- (void)phononPlayBuffer:(double)bufferId
                  config:(JS::NativeSpeech::PhononPlayConfig &)config
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  reject(kPhononNotCompiled, kPhononNotCompiledMessage, nil);
}

- (void)phononCopyBuffer:(double)bufferId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  reject(kPhononNotCompiled, kPhononNotCompiledMessage, nil);
}

- (NSNumber *)phononReleaseBuffer:(double)bufferId {
  return @(NO);
}

- (void)phononDestroy:(double)handleId
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  resolve(nil);
}

- (void)phononGetDiagnostics:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  resolve(@{
    @"memKb": @(0),
    @"peakMemKb": @(0),
    @"threads": @(0),
    @"libraryLoaded": @(NO),
    @"handleOpen": @(NO),
    @"liveBuffers": @(0),
    @"orphanBuffers": @(0),
    @"busy": @"idle",
    @"lastIssuedId": @(0),
    @"cancelWatermark": @(0),
  });
}

// Nothing is ever recorded without Phonon.
- (void)phononResetSupport:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  resolve(@(YES));
}
#else // RN_SPEECH_PHONON
// Flag on: everything goes through ios/phonon/RNSpeechPhonon onto the shared core
// (cpp/phonon). Sync methods only touch atomics; ptts work runs on the Phonon worker.

// JS numbers arrive as doubles; ids are small positive integers. NaN/inf -> 0 (never issued).
static int64_t RNSpeechPhononId(double v) {
  return std::isfinite(v) ? (int64_t)std::llround(v) : 0;
}

- (void)phononGetSupport:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  resolve([RNSpeechPhonon supportInfo]);
}

- (void)phononNeedsCompile:(NSString *)modelDir
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  resolve(@([RNSpeechPhonon needsCompile:modelDir]));
}

- (void)phononCreate:(NSString *)modelDir
             options:(JS::NativeSpeech::PhononLoadOptions &)options
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  // options is a reference into the call's arguments: read it before going async.
  NSString *language = options.language() ?: @"en";
  NSString *computeUnit = options.computeUnit() ?: @"neuralEngine";
  [_phonon createWithModelDir:modelDir
                     language:language
                  computeUnit:computeUnit
                      resolve:resolve
                       reject:reject];
}

- (NSNumber *)phononAllocRequestId {
  return @((double)[_phonon allocRequestId]);
}

- (void)phononSynthesize:(double)handleId
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

- (NSNumber *)phononCancel:(double)upToRequestId {
  return @([_phonon cancelUpTo:RNSpeechPhononId(upToRequestId)]);
}

- (NSNumber *)phononCancelAll {
  return @([_phonon cancelAll]);
}

- (void)phononPlayBuffer:(double)bufferId
                  config:(JS::NativeSpeech::PhononPlayConfig &)config
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  double sampleRate = config.sampleRate();
  NSInteger channels = MAX((NSInteger)config.channels(), (NSInteger)1);
  BOOL ducking = config.ducking().value_or(false);
  NSString *silentMode = config.silentMode() ?: @"obey";
  // Volume is applied natively (no JS copy of the PCM): clamped to [0, 1] like OS TTS.
  std::optional<double> volume = config.volume();
  float gain = rnspeech::phonon::ios::playback_gain(volume.value_or(1.0), volume.has_value());

  // Taken (moved out of the store) now, on the calling thread: the buffer is consumed even if
  // playback is later interrupted, and an unknown id rejects at once.
  int64_t bid = RNSpeechPhononId(bufferId);
  NSData *samples = [_phonon takeBuffer:bid gain:gain];
  if (samples == nil) {
    reject(@"PHONON_INVALID_BUFFER",
           [NSString stringWithFormat:@"unknown Phonon buffer %lld", (long long)bid], nil);
    return;
  }
  dispatch_async(_audioQueue, ^{
    RNSpeechTraceHandle traceHandle = RNSpeechTraceBegin("phononPlayBuffer",
        [NSString stringWithFormat:@"bufferId=%lld samples=%lu", (long long)bid,
                                   (unsigned long)(samples.length / sizeof(float))]);
    @try {
      // Stop any current playback
      [self cleanupAudio];

      // Increment utterance ID
      self->_currentAudioUtteranceId++;

      [self playFloatSamplesOnAudioQueue:samples
                              sampleRate:sampleRate
                                channels:channels
                                 ducking:ducking
                              silentMode:silentMode
                             traceHandle:traceHandle
                               traceName:"phononPlayBuffer"
                                 resolve:resolve
                                  reject:reject];
    }
    @catch (NSException *exception) {
      RNSpeechTraceEnd(traceHandle, "phononPlayBuffer");
      reject(@"PHONON_INTERNAL", exception.reason, nil);
    }
  });
}

- (void)phononCopyBuffer:(double)bufferId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  [_phonon copyBuffer:RNSpeechPhononId(bufferId) resolve:resolve reject:reject];
}

- (NSNumber *)phononReleaseBuffer:(double)bufferId {
  return @([_phonon releaseBuffer:RNSpeechPhononId(bufferId)]);
}

- (void)phononDestroy:(double)handleId
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [_phonon destroyHandle:RNSpeechPhononId(handleId) resolve:resolve reject:reject];
}

- (void)phononGetDiagnostics:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  resolve([_phonon diagnostics]);
}

// Speech.resetEngineSupport: +supportInfo is not cached on iOS, so clearing the file is enough.
- (void)phononResetSupport:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  resolve(@([RNSpeechPhonon clearCapabilityRecord]));
}

// RN reload / teardown: cancel everything and drop this module's pending promises, without
// destroying the handle or waiting for the synth thread (DESIGN.md §1.5).
- (void)invalidate {
  [_phonon invalidate];
}
#endif // !RN_SPEECH_PHONON

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeSpeechSpecJSI>(params);
}

@end
