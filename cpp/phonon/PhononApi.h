// PhononApi.h — function table over the vendored ptts.h (Phonon v0.4.0 FFI).
//
// Android resolves the table with dlopen/dlsym, lazily, from phononCreate and only after the
// HWCAP gate (DESIGN.md §2.1). iOS links libptts_ffi.a statically and binds the symbols
// directly (RN_SPEECH_PHONON_STATIC_API). Nothing here ever aborts: every failure is reported
// as a status plus a human-readable message.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <string>

// Upstream's header has no extern "C" guard; without this the statically linked (iOS)
// symbols would be looked up with C++ mangling. Its system includes come first (above), so
// they are not re-entered inside the extern "C" block.
extern "C" {
#include "ptts.h"
}

#ifndef RN_SPEECH_PHONON_STATIC_API
#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE
#define RN_SPEECH_PHONON_STATIC_API 1
#endif
#endif
#endif

namespace rnspeech::phonon {

struct PttsApi {
  decltype(&::ptts_new) create = nullptr;
  decltype(&::ptts_speak) speak = nullptr;
  decltype(&::ptts_voices) voices = nullptr;
  decltype(&::ptts_set_voice) set_voice = nullptr;
  decltype(&::ptts_languages) languages = nullptr;
  decltype(&::ptts_set_language) set_language = nullptr;
  decltype(&::ptts_last_error) last_error = nullptr;
  decltype(&::ptts_free) free = nullptr;
  // dlopen handle (nullptr when bound statically). Owned by the table.
  void* lib = nullptr;

  // True when every entry is resolved.
  bool complete() const;
};

enum class ApiStatus {
  Ok,
  LibraryMissing,  // dlopen failed
  SymbolsMissing,  // dlopen ok, at least one ptts_* symbol absent (library closed again)
};

// Capability reason string reported by getSupport (DESIGN.md §1.3): "ok", "library-missing",
// "symbols-missing".
const char* api_status_reason(ApiStatus status);

#if RN_SPEECH_PHONON_STATIC_API
// iOS: bind the statically linked ptts_* symbols. Always Ok.
ApiStatus phonon_bind_static_api(PttsApi* out);
#else
// dlopen(soname, RTLD_NOW | RTLD_LOCAL) and resolve all 8 symbols. On SymbolsMissing the
// library is dlclose'd and `err` lists the missing names. `out` is only filled on Ok.
ApiStatus phonon_load_api(PttsApi* out, const char* soname, std::string* err);

// dlclose the library behind `api` (if any) and clear the table. Only for tests and for the
// symbols-missing path: in production the library stays loaded for the process lifetime.
void phonon_unload_api(PttsApi* api);
#endif

}  // namespace rnspeech::phonon
