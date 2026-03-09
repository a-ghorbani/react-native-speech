#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>
#import <os/signpost.h>
#import <os/log.h>
#import <mach/mach.h>
#import <os/proc.h>

@interface RNBenchmark : NSObject <RCTBridgeModule>
@end

@implementation RNBenchmark
{
  os_log_t _benchLog;
  os_log_t _benchPoiLog;
  NSMutableDictionary<NSString *, NSNumber *> *_signpostIdMap;

  dispatch_source_t _memoryPollTimer;
  dispatch_queue_t _pollQueue;
  double _peakResidentMB;
  NSInteger _memorySampleCount;
  BOOL _isMemoryPolling;
}

RCT_EXPORT_MODULE();

- (instancetype)init {
  self = [super init];
  if (self) {
    _benchLog = os_log_create("com.mhpdev.speech", "TTS");
    _benchPoiLog = os_log_create("com.mhpdev.speech", OS_LOG_CATEGORY_POINTS_OF_INTEREST);
    _signpostIdMap = [NSMutableDictionary new];
    _pollQueue = dispatch_queue_create("com.speech.benchmark.poll", DISPATCH_QUEUE_SERIAL);
    _isMemoryPolling = NO;
    _peakResidentMB = 0;
    _memorySampleCount = 0;
  }
  return self;
}

- (void)dealloc {
  if (_memoryPollTimer) {
    dispatch_source_cancel(_memoryPollTimer);
    _memoryPollTimer = nil;
  }
}

RCT_EXPORT_METHOD(getMemoryStats:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject) {
  mach_task_basic_info_data_t taskInfo;
  mach_msg_type_number_t infoCount = MACH_TASK_BASIC_INFO_COUNT;
  kern_return_t kernReturn = task_info(mach_task_self(),
                                        MACH_TASK_BASIC_INFO,
                                        (task_info_t)&taskInfo,
                                        &infoCount);

  double residentMB = 0;
  if (kernReturn == KERN_SUCCESS) {
    residentMB = taskInfo.resident_size / (1024.0 * 1024.0);
  }

  double availableMB = 0;
  if (@available(iOS 13.0, *)) {
    availableMB = os_proc_available_memory() / (1024.0 * 1024.0);
  }

  double totalMemMB = [NSProcessInfo processInfo].physicalMemory / (1024.0 * 1024.0);

  resolve(@{
    @"nativeHeapAllocatedMB": @(residentMB),
    @"nativeHeapFreeMB": @(0),
    @"totalMemoryMB": @(totalMemMB),
    @"availableMemoryMB": @(availableMB)
  });
}

RCT_EXPORT_METHOD(beginTraceInterval:(NSString *)name) {
  if (@available(iOS 12.0, *)) {
    os_signpost_id_t spid = os_signpost_id_generate(_benchLog);
    os_signpost_id_t poiSpid = os_signpost_id_generate(_benchPoiLog);
    @synchronized (_signpostIdMap) {
      _signpostIdMap[name] = @(spid);
      _signpostIdMap[[name stringByAppendingString:@":poi"]] = @(poiSpid);
    }
    os_signpost_interval_begin(_benchLog, spid, "JS", "%{public}s", name.UTF8String);
    os_signpost_interval_begin(_benchPoiLog, poiSpid, "TTS", "%{public}s", name.UTF8String);
  }
}

RCT_EXPORT_METHOD(endTraceInterval:(NSString *)name) {
  if (@available(iOS 12.0, *)) {
    NSNumber *spidNum;
    NSNumber *poiSpidNum;
    @synchronized (_signpostIdMap) {
      spidNum = _signpostIdMap[name];
      poiSpidNum = _signpostIdMap[[name stringByAppendingString:@":poi"]];
      [_signpostIdMap removeObjectForKey:name];
      [_signpostIdMap removeObjectForKey:[name stringByAppendingString:@":poi"]];
    }
    if (spidNum) {
      os_signpost_id_t spid = (os_signpost_id_t)[spidNum unsignedLongLongValue];
      os_signpost_interval_end(_benchLog, spid, "JS", "%{public}s", name.UTF8String);
    }
    if (poiSpidNum) {
      os_signpost_id_t poiSpid = (os_signpost_id_t)[poiSpidNum unsignedLongLongValue];
      os_signpost_interval_end(_benchPoiLog, poiSpid, "TTS", "%{public}s", name.UTF8String);
    }
  }
}

RCT_EXPORT_METHOD(startMemoryPolling:(double)intervalMs) {
  if (_isMemoryPolling) return;

  _isMemoryPolling = YES;
  _peakResidentMB = 0;
  _memorySampleCount = 0;

  double intervalSec = intervalMs / 1000.0;
  _memoryPollTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _pollQueue);
  dispatch_source_set_timer(_memoryPollTimer,
                            dispatch_time(DISPATCH_TIME_NOW, 0),
                            (uint64_t)(intervalSec * NSEC_PER_SEC),
                            (uint64_t)(10 * NSEC_PER_MSEC));

  __weak RNBenchmark *weakSelf = self;
  dispatch_source_set_event_handler(_memoryPollTimer, ^{
    RNBenchmark *strongSelf = weakSelf;
    if (!strongSelf) return;

    mach_task_basic_info_data_t taskInfo;
    mach_msg_type_number_t infoCount = MACH_TASK_BASIC_INFO_COUNT;
    kern_return_t kr = task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
                                 (task_info_t)&taskInfo, &infoCount);
    if (kr == KERN_SUCCESS) {
      double residentMB = taskInfo.resident_size / (1024.0 * 1024.0);
      if (residentMB > strongSelf->_peakResidentMB) {
        strongSelf->_peakResidentMB = residentMB;
      }
      strongSelf->_memorySampleCount++;
    }
  });

  dispatch_resume(_memoryPollTimer);
}

RCT_EXPORT_METHOD(stopMemoryPolling:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject) {
  if (_memoryPollTimer) {
    dispatch_source_cancel(_memoryPollTimer);
    _memoryPollTimer = nil;
  }
  _isMemoryPolling = NO;

  resolve(@{
    @"peakNativeHeapMB": @(_peakResidentMB),
    @"sampleCount": @(_memorySampleCount)
  });
}

@end
