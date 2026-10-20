// Host stand-in for <android/log.h> (test/phonon-jni only): logs to stderr.
#pragma once
#ifdef __cplusplus
extern "C" {
#endif
enum { ANDROID_LOG_INFO = 4, ANDROID_LOG_WARN = 5, ANDROID_LOG_ERROR = 6 };
int __android_log_print(int prio, const char* tag, const char* fmt, ...);
#ifdef __cplusplus
}
#endif
