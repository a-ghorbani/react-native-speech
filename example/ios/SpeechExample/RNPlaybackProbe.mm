// Self-test helpers for the playback-edges suite (src/selftest/edgesSelfTest.ts).
#import <React/RCTBridgeModule.h>
#import <AVFoundation/AVFoundation.h>

@interface RNPlaybackProbe : NSObject <RCTBridgeModule>
@end

@implementation RNPlaybackProbe

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (dispatch_queue_t)methodQueue {
  return dispatch_queue_create("speech.example.playbackprobe", DISPATCH_QUEUE_SERIAL);
}

static NSArray<NSString *> *RouteOutputs(void) {
  NSMutableArray<NSString *> *out = [NSMutableArray new];
  for (AVAudioSessionPortDescription *port in AVAudioSession.sharedInstance.currentRoute.outputs) {
    [out addObject:port.portType];
  }
  return out;
}

RCT_EXPORT_METHOD(getOutputInfo:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject) {
  AVAudioSession *session = AVAudioSession.sharedInstance;
  resolve(@{
    @"outputLatencyMs": @(session.outputLatency * 1000.0),
    @"probeLatencyMs": @(-1),
    @"bufferMs": @(session.IOBufferDuration * 1000.0),
    @"sampleRate": @(session.sampleRate),
    @"route": RouteOutputs(),
  });
}

RCT_EXPORT_METHOD(interrupt:(NSString *)kind
                     holdMs:(double)holdMs
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject) {
  AVAudioSession *session = AVAudioSession.sharedInstance;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center postNotificationName:AVAudioSessionInterruptionNotification
                        object:session
                      userInfo:@{AVAudioSessionInterruptionTypeKey: @(AVAudioSessionInterruptionTypeBegan)}];
  [NSThread sleepForTimeInterval:holdMs / 1000.0];
  [center postNotificationName:AVAudioSessionInterruptionNotification
                        object:session
                      userInfo:@{
                        AVAudioSessionInterruptionTypeKey: @(AVAudioSessionInterruptionTypeEnded),
                        AVAudioSessionInterruptionOptionKey: @(AVAudioSessionInterruptionOptionShouldResume),
                      }];
  resolve(@{@"granted": @YES});
}

RCT_EXPORT_METHOD(routeChange:(double)holdMs
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject) {
  AVAudioSession *session = AVAudioSession.sharedInstance;
  NSArray *before = RouteOutputs();
  AVAudioSessionCategory previousCategory = session.category;
  AVAudioSessionCategoryOptions previousOptions = session.categoryOptions;
  AVAudioSessionMode previousMode = session.mode;
  NSError *error = nil;
  // The speaker override is only valid in PlayAndRecord; the library uses Playback.
  BOOL switched = ![previousCategory isEqualToString:AVAudioSessionCategoryPlayAndRecord];
  if (switched && ![session setCategory:AVAudioSessionCategoryPlayAndRecord
                                   mode:AVAudioSessionModeDefault
                                options:0
                                  error:&error]) {
    reject(@"probe_error", error.localizedDescription ?: @"setCategory failed", error);
    return;
  }
  NSString *overrideError = @"";
  if (![session overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:&error]) {
    overrideError = error.localizedDescription ?: @"override failed";
  }
  [NSThread sleepForTimeInterval:holdMs / 2000.0];
  NSArray *during = RouteOutputs();
  [NSThread sleepForTimeInterval:holdMs / 2000.0];
  [session overrideOutputAudioPort:AVAudioSessionPortOverrideNone error:nil];
  if (switched) {
    [session setCategory:previousCategory mode:previousMode options:previousOptions error:nil];
  }
  resolve(@{
    @"before": before,
    @"during": during,
    @"after": RouteOutputs(),
    @"switchedCategory": @(switched),
    @"overrideError": overrideError,
  });
}

RCT_EXPORT_METHOD(recordProbe:(double)ms
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject) {
  AVAudioSession *session = AVAudioSession.sharedInstance;
  AVAudioSessionCategory previousCategory = session.category;
  AVAudioSessionCategoryOptions previousOptions = session.categoryOptions;
  AVAudioSessionMode previousMode = session.mode;
  NSMutableDictionary *result = [@{
    @"started": @NO,
    @"bytes": @0,
    @"previousCategory": previousCategory ?: @"",
    @"permission": @(session.recordPermission),
  } mutableCopy];
  NSError *error = nil;
  NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:@"edges-mic-probe.caf"]];
  AVAudioRecorder *recorder = nil;
  if (![session setCategory:AVAudioSessionCategoryPlayAndRecord
                       mode:AVAudioSessionModeDefault
                    options:AVAudioSessionCategoryOptionDefaultToSpeaker
                      error:&error] ||
      ![session setActive:YES error:&error]) {
    result[@"error"] = [NSString stringWithFormat:@"session: %@ (%ld)", error.localizedDescription, (long)error.code];
  } else {
    recorder = [[AVAudioRecorder alloc] initWithURL:url
                                           settings:@{
                                             AVFormatIDKey: @(kAudioFormatLinearPCM),
                                             AVSampleRateKey: @16000,
                                             AVNumberOfChannelsKey: @1,
                                           }
                                              error:&error];
    if (!recorder) {
      result[@"error"] = [NSString stringWithFormat:@"recorder: %@ (%ld)", error.localizedDescription, (long)error.code];
    } else if (![recorder record]) {
      result[@"error"] = @"record returned NO";
    } else {
      result[@"started"] = @YES;
      [NSThread sleepForTimeInterval:ms / 1000.0];
      [recorder stop];
      NSDictionary *attrs = [NSFileManager.defaultManager attributesOfItemAtPath:url.path error:nil];
      result[@"bytes"] = @([attrs fileSize]);
    }
  }
  [NSFileManager.defaultManager removeItemAtURL:url error:nil];
  NSError *restoreError = nil;
  if (previousCategory &&
      ![session setCategory:previousCategory mode:previousMode options:previousOptions error:&restoreError]) {
    result[@"restoreError"] = restoreError.localizedDescription ?: @"restore failed";
  }
  resolve(result);
}

@end
