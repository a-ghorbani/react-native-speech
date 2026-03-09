#ifndef RNSpeechTrace_h
#define RNSpeechTrace_h

#import <Foundation/Foundation.h>

#ifdef RN_SPEECH_TRACE

#import <os/signpost.h>

typedef struct {
    os_signpost_id_t spid;
    os_signpost_id_t poiSpid;
} RNSpeechTraceHandle;

void RNSpeechTraceInit(void);
RNSpeechTraceHandle RNSpeechTraceBegin(const char *name, NSString *message);
void RNSpeechTraceEnd(RNSpeechTraceHandle handle, const char *name);

#else

typedef int RNSpeechTraceHandle;

static inline void RNSpeechTraceInit(void) {}
static inline RNSpeechTraceHandle RNSpeechTraceBegin(const char *name __unused, NSString *message __unused) { return 0; }
static inline void RNSpeechTraceEnd(RNSpeechTraceHandle handle __unused, const char *name __unused) {}

#endif

#endif /* RNSpeechTrace_h */
