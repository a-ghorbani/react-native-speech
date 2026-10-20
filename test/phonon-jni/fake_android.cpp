// Host implementations of the two bionic APIs phonon_jni.cpp uses (test/phonon-jni only).
#include <cstdarg>
#include <cstdio>

#include "android/log.h"
#include "sys/system_properties.h"

extern "C" int __android_log_print(int prio, const char* tag, const char* fmt, ...) {
  std::fprintf(stderr, "[%d/%s] ", prio, tag);
  va_list ap;
  va_start(ap, fmt);
  const int n = std::vfprintf(stderr, fmt, ap);
  va_end(ap);
  std::fputc('\n', stderr);
  return n;
}

extern "C" int __system_property_get(const char*, char* value) {
  value[0] = '\0';
  return 0;
}
