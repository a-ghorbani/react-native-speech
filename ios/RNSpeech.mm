#import "RNSpeech.h"
#import "RNSpeechTrace.h"
#import "NativeDictWrapper.h"
#import <React/RCTLog.h>
#import "RNSpeechAudioOutput+Internal.h"

using namespace JS::NativeSpeech;

@implementation RNSpeech
{
  BOOL isDucking;
  NSDictionary *defaultOptions;
  // Bumped by cleanupAudio; completion handlers of older buffers then only resolve.
  NSUInteger _playbackGeneration;
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

    [RNSpeechAudioOutput attach:self];

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
  _playbackGeneration++;
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
      if (![self ensureSupportedChannels:channels traceHandle:traceHandle traceName:"playAudio" reject:reject]) {
        return;
      }

      // Stop any current playback
      [self cleanupAudio];

      // Increment utterance ID
      self->_currentAudioUtteranceId++;

      // Decode base64 audio data
      NSData *decodedData = [[NSData alloc] initWithBase64EncodedString:audioData options:0];
      if (!decodedData) {
        [self abandonPlaybackWithTraceHandle:traceHandle
                                   traceName:"playAudio"
                                     resolve:resolve
                                      reject:reject
                                     message:@"Failed to decode base64 audio data"
                                       error:nil];
        return;
      }

      [self playOnAudioQueueWithSampleCount:decodedData.length / sizeof(int16_t)
                                 sampleRate:sampleRate
                                   channels:channels
                                    ducking:ducking
                                 silentMode:silentMode
                                traceHandle:traceHandle
                                  traceName:"playAudio"
                                    resolve:resolve
                                     reject:reject
                                       fill:^(float *const *dst, NSUInteger frameCount, NSUInteger channelCount) {
        const int16_t *int16Samples = (const int16_t *)decodedData.bytes;
        for (NSUInteger ch = 0; ch < channelCount; ch++) {
          for (NSUInteger f = 0; f < frameCount; f++) {
            dst[ch][f] = int16Samples[f * channelCount + ch] / 32768.0f;
          }
        }
      }];
    }
    @catch (NSException *exception) {
      RNSpeechTraceEnd(traceHandle, "playAudio");
      reject(@"audio_error", exception.reason, nil);
    }
  });
}

- (void)playFloatSamples:(NSData *)samples
              sampleRate:(double)sampleRate
                channels:(NSInteger)channels
                 ducking:(BOOL)ducking
              silentMode:(NSString *)silentMode
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_audioQueue, ^{
    RNSpeechTraceHandle traceHandle = RNSpeechTraceBegin("playPcm",
        [NSString stringWithFormat:@"samples=%lu", (unsigned long)(samples.length / sizeof(float))]);
    @try {
      if (![self ensureSupportedChannels:channels traceHandle:traceHandle traceName:"playPcm" reject:reject]) {
        return;
      }

      [self cleanupAudio];

      self->_currentAudioUtteranceId++;

      [self playOnAudioQueueWithSampleCount:samples.length / sizeof(float)
                                 sampleRate:sampleRate
                                   channels:channels
                                    ducking:ducking
                                 silentMode:silentMode
                                traceHandle:traceHandle
                                  traceName:"playPcm"
                                    resolve:resolve
                                     reject:reject
                                       fill:^(float *const *dst, NSUInteger frameCount, NSUInteger channelCount) {
        const float *interleaved = (const float *)samples.bytes;
        for (NSUInteger ch = 0; ch < channelCount; ch++) {
          for (NSUInteger f = 0; f < frameCount; f++) {
            dst[ch][f] = interleaved[f * channelCount + ch];
          }
        }
      }];
    }
    @catch (NSException *exception) {
      RNSpeechTraceEnd(traceHandle, "playPcm");
      reject(@"audio_error", exception.reason, nil);
    }
  });
}

// Same rule as Android's pcmFrameBytes. Call before cleanupAudio so a rejection leaves current
// playback alone.
- (BOOL)ensureSupportedChannels:(NSInteger)channels
                    traceHandle:(RNSpeechTraceHandle)traceHandle
                      traceName:(const char *)traceName
                         reject:(RCTPromiseRejectBlock)reject {
  if (channels <= 2) {
    return YES;
  }
  RNSpeechTraceEnd(traceHandle, traceName);
  reject(@"audio_error", [NSString stringWithFormat:@"Unsupported channel count: %ld", (long)channels], nil);
  return NO;
}

// Ends a playback that fails after cleanupAudio, which leaves the session active for the replacement.
- (void)abandonPlaybackWithTraceHandle:(RNSpeechTraceHandle)traceHandle
                             traceName:(const char *)traceName
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
                               message:(NSString *)message
                                 error:(NSError *)error {
  [self deactivateAudioSession];
  RNSpeechTraceEnd(traceHandle, traceName);
  if (message) {
    reject(@"audio_error", message, error);
  } else {
    resolve(nil);
  }
}

// Runs on _audioQueue after the caller's cleanupAudio and utterance-id bump; `fill` deinterleaves into dst.
// Resolves on completion, stop or replace, so chunks play back to back.
- (void)playOnAudioQueueWithSampleCount:(NSUInteger)sampleCount
                             sampleRate:(double)sampleRate
                               channels:(NSInteger)channels
                                ducking:(BOOL)ducking
                             silentMode:(NSString *)silentMode
                            traceHandle:(RNSpeechTraceHandle)traceHandle
                              traceName:(const char *)traceName
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
                                   fill:(void (NS_NOESCAPE ^)(float *const *dst, NSUInteger frameCount, NSUInteger channelCount))fill {
  NSUInteger channelCount = (NSUInteger)MAX(channels, (NSInteger)1);
  NSUInteger frameCount = sampleCount / channelCount;
  void (^abandon)(NSString *, NSError *) = ^(NSString *message, NSError *error) {
    [self abandonPlaybackWithTraceHandle:traceHandle
                               traceName:traceName
                                 resolve:resolve
                                  reject:reject
                                 message:message
                                   error:error];
  };
  if (frameCount == 0) {
    abandon(nil, nil);
    return;
  }

  AVAudioFormat *audioFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sampleRate
                                                                               channels:(AVAudioChannelCount)channelCount];

  AVAudioPCMBuffer *pcmBuffer = audioFormat
      ? [[AVAudioPCMBuffer alloc] initWithPCMFormat:audioFormat
                                      frameCapacity:(AVAudioFrameCount)frameCount]
      : nil;
  if (!pcmBuffer) {
    abandon(@"Failed to create audio buffer", nil);
    return;
  }
  pcmBuffer.frameLength = (AVAudioFrameCount)frameCount;
  fill(pcmBuffer.floatChannelData, frameCount, channelCount);

  self->_isAudioDucking = ducking;

  [self activateAudioSession:self->_isAudioDucking silentMode:silentMode];

  [self->_audioEngine connect:self->_playerNode
                           to:self->_audioEngine.mainMixerNode
                       format:audioFormat];

  NSError *error = nil;
  if (!self->_audioEngine.isRunning) {
    [self->_audioEngine startAndReturnError:&error];
    if (error) {
      abandon([NSString stringWithFormat:@"Failed to start audio engine: %@", error.localizedDescription], error);
      return;
    }
  }

  self->_isAudioPlaying = YES;
  self->_isAudioPaused = NO;

  [self emitOnStart:[self getAudioEventData]];

  NSUInteger generation = self->_playbackGeneration;
  __weak RNSpeech *weakSelf = self;
  // The plain handler fires before the tail is audible (#43).
  [self->_playerNode scheduleBuffer:pcmBuffer
                     atTime:nil
                    options:AVAudioPlayerNodeBufferInterrupts
      completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack
          completionHandler:^(AVAudioPlayerNodeCompletionCallbackType callbackType) {
    RNSpeech *strongSelf = weakSelf;
    if (strongSelf) {
      dispatch_async(strongSelf->_audioQueue, ^{
        // Also fires when cleanupAudio stops the node; a newer playback or stop then owns the state.
        if (strongSelf->_playbackGeneration != generation) {
          RNSpeechTraceEnd(traceHandle, traceName);
          resolve(nil);
          return;
        }
        strongSelf->_isAudioPlaying = NO;
        [strongSelf deactivateAudioSession];
        RNSpeechTraceEnd(traceHandle, traceName);
        [strongSelf emitOnFinish:[strongSelf getAudioEventData]];
        resolve(nil);
      });
    }
  }];

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

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeSpeechSpecJSI>(params);
}

@end
