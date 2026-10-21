// The ptts_* API with no engine behind it: the ios-x86_64-simulator slice of PhononCore.xcframework
// (Intel-Mac simulator builds link without EXCLUDED_ARCHS; the engine reports unsupported-abi there)
// and the body of the verifiers' self-test libraries. ptts_new always fails, so no other call ever
// sees a handle.
#include <stddef.h>

#include "ptts.h"

#define PTTS_STUB_EXPORT __attribute__((visibility("default")))

static const char kStubError[] = "Phonon is not available on this architecture";
// Two NULs: an empty NUL-separated list.
static const char kEmptyList[2] = {0, 0};

PTTS_STUB_EXPORT PttsHandle *ptts_new(const char *dir, uint32_t unit, const char *lang) {
  (void)dir;
  (void)unit;
  (void)lang;
  return NULL;
}

PTTS_STUB_EXPORT bool ptts_speak(PttsHandle *h, const char *text, PttsFrameFn cb, void *user,
                                 PttsResult *out) {
  (void)h;
  (void)text;
  (void)cb;
  (void)user;
  (void)out;
  return false;
}

PTTS_STUB_EXPORT const char *ptts_voices(const PttsHandle *h) {
  (void)h;
  return kEmptyList;
}

PTTS_STUB_EXPORT bool ptts_set_voice(PttsHandle *h, const char *name) {
  (void)h;
  (void)name;
  return false;
}

PTTS_STUB_EXPORT bool ptts_set_language(PttsHandle *h, const char *lang) {
  (void)h;
  (void)lang;
  return false;
}

PTTS_STUB_EXPORT const char *ptts_languages(const PttsHandle *h) {
  (void)h;
  return kEmptyList;
}

PTTS_STUB_EXPORT const char *ptts_last_error(const PttsHandle *h) {
  (void)h;
  return kStubError;
}

PTTS_STUB_EXPORT void ptts_free(PttsHandle *h) { (void)h; }
