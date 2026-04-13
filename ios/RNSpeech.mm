#import "RNSpeech.h"
#import "RNSpeechTrace.h"
#import "NativeDictWrapper.h"
#import <React/RCTLog.h>

using namespace JS::NativeSpeech;

@implementation RNSpeech
{
  BOOL isDucking;
  NSDictionary *defaultOptions;
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

    // Initialize trace instrumentation (no-op if RN_SPEECH_TRACE is not defined)
    RNSpeechTraceInit();

    // Setup audio session interruption handling
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(handleAudioInterruption:)
                                                 name:AVAudioSessionInterruptionNotification
                                               object:nil];
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
  } else if (interruptionType.unsignedIntegerValue == AVAudioSessionInterruptionTypeEnded) {
    NSNumber *interruptionOption = notification.userInfo[AVAudioSessionInterruptionOptionKey];
    if (interruptionOption.unsignedIntegerValue == AVAudioSessionInterruptionOptionShouldResume) {
      if (_isAudioPaused) {
        [self resumeAudioInternal];
      }
    }
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
    } else { // obey
      category = AVAudioSessionCategorySoloAmbient;
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

      float *float32Samples = (float *)malloc(sampleCount * sizeof(float));
      if (!float32Samples) {
        reject(@"audio_error", @"Failed to allocate memory for audio conversion", nil);
        return;
      }

      // Convert Int16 to Float32 (normalize to -1.0 to 1.0)
      for (NSUInteger i = 0; i < sampleCount; i++) {
        float32Samples[i] = int16Samples[i] / 32768.0f;
      }

      // Create audio format
      AVAudioFormat *audioFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sampleRate
                                                                                   channels:(AVAudioChannelCount)channels];

      // Create audio buffer
      AVAudioPCMBuffer *pcmBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:audioFormat
                                                                   frameCapacity:(AVAudioFrameCount)sampleCount];
      pcmBuffer.frameLength = (AVAudioFrameCount)sampleCount;

      // Copy samples to buffer
      memcpy(pcmBuffer.floatChannelData[0], float32Samples, sampleCount * sizeof(float));
      free(float32Samples);

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
            RNSpeechTraceEnd(traceHandle, "playAudio");
            [strongSelf emitOnFinish:[strongSelf getAudioEventData]];
            // Resolve promise when playback is complete
            resolve(nil);
          });
        }
      }];

      // Start playback
      [self->_playerNode play];
    }
    @catch (NSException *exception) {
      RNSpeechTraceEnd(traceHandle, "playAudio");
      reject(@"audio_error", exception.reason, nil);
    }
  });
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

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeSpeechSpecJSI>(params);
}

@end
