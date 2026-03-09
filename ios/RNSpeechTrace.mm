#ifdef RN_SPEECH_TRACE

#import "RNSpeechTrace.h"
#import <os/signpost.h>
#import <os/log.h>

static os_log_t _ttsLog;
static os_log_t _ttsPoiLog;

void RNSpeechTraceInit(void) {
    _ttsLog = os_log_create("com.mhpdev.speech", "TTS");
    _ttsPoiLog = os_log_create("com.mhpdev.speech", OS_LOG_CATEGORY_POINTS_OF_INTEREST);
}

RNSpeechTraceHandle RNSpeechTraceBegin(const char *name, NSString *message) {
    RNSpeechTraceHandle handle;
    handle.spid = os_signpost_id_generate(_ttsLog);
    handle.poiSpid = os_signpost_id_generate(_ttsPoiLog);
    os_signpost_interval_begin(_ttsLog, handle.spid, "TTS", "%s %{public}s",
                               name, message ? message.UTF8String : "");
    os_signpost_interval_begin(_ttsPoiLog, handle.poiSpid, "TTS", "%s", name);
    return handle;
}

void RNSpeechTraceEnd(RNSpeechTraceHandle handle, const char *name) {
    os_signpost_interval_end(_ttsLog, handle.spid, "TTS", "%s", name);
    os_signpost_interval_end(_ttsPoiLog, handle.poiSpid, "TTS", "%s", name);
}

#endif
