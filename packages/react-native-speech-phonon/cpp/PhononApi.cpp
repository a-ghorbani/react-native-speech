// PhononApi.cpp — resolves the ptts_* function table (see PhononApi.h).
#include "PhononApi.h"

#if !RN_SPEECH_PHONON_STATIC_API
#include <dlfcn.h>
#endif

namespace rnspeech::phonon {

bool PttsApi::complete() const {
  return create && speak && voices && set_voice && languages && set_language && last_error &&
         free;
}

const char* api_status_reason(ApiStatus status) {
  switch (status) {
    case ApiStatus::Ok:
      return "ok";
    case ApiStatus::LibraryMissing:
      return "library-missing";
    case ApiStatus::SymbolsMissing:
      return "symbols-missing";
  }
  return "error";
}

#if RN_SPEECH_PHONON_STATIC_API

ApiStatus phonon_bind_static_api(PttsApi* out) {
  PttsApi api;
  api.create = &::ptts_new;
  api.speak = &::ptts_speak;
  api.voices = &::ptts_voices;
  api.set_voice = &::ptts_set_voice;
  api.languages = &::ptts_languages;
  api.set_language = &::ptts_set_language;
  api.last_error = &::ptts_last_error;
  api.free = &::ptts_free;
  *out = api;
  return ApiStatus::Ok;
}

#else

namespace {

template <typename Fn>
void resolve(void* lib, const char* name, Fn* slot, std::string* missing) {
  // POSIX guarantees dlsym results convert to function pointers.
  *slot = reinterpret_cast<Fn>(dlsym(lib, name));
  if (*slot == nullptr) {
    if (!missing->empty()) missing->append(", ");
    missing->append(name);
  }
}

}  // namespace

ApiStatus phonon_load_api(PttsApi* out, const char* soname, std::string* err) {
  dlerror();  // clear any stale message
  void* lib = dlopen(soname, RTLD_NOW | RTLD_LOCAL);
  if (lib == nullptr) {
    if (err != nullptr) {
      const char* msg = dlerror();
      *err = msg != nullptr ? msg : "dlopen failed";
    }
    return ApiStatus::LibraryMissing;
  }

  PttsApi api;
  std::string missing;
  resolve(lib, "ptts_new", &api.create, &missing);
  resolve(lib, "ptts_speak", &api.speak, &missing);
  resolve(lib, "ptts_voices", &api.voices, &missing);
  resolve(lib, "ptts_set_voice", &api.set_voice, &missing);
  resolve(lib, "ptts_languages", &api.languages, &missing);
  resolve(lib, "ptts_set_language", &api.set_language, &missing);
  resolve(lib, "ptts_last_error", &api.last_error, &missing);
  resolve(lib, "ptts_free", &api.free, &missing);

  if (!missing.empty()) {
    dlclose(lib);
    if (err != nullptr) *err = "missing symbols: " + missing;
    return ApiStatus::SymbolsMissing;
  }

  api.lib = lib;
  *out = api;
  return ApiStatus::Ok;
}

void phonon_unload_api(PttsApi* api) {
  if (api == nullptr) return;
  if (api->lib != nullptr) dlclose(api->lib);
  *api = PttsApi{};
}

#endif

}  // namespace rnspeech::phonon
