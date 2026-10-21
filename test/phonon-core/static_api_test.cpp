// iOS binding path (RN_SPEECH_PHONON_STATIC_API=1): fake_ptts.c linked in, bound without dlopen.
#include <string>

#include "PhononApi.h"
#include "PhononCore.h"
#include "fake_ptts.h"  // its own extern "C"; ptts.h comes via PhononApi.h
#include "test_harness.h"

#if !RN_SPEECH_PHONON_STATIC_API
#error "static_api_test must be built with RN_SPEECH_PHONON_STATIC_API=1"
#endif

using namespace rnspeech::phonon;

TEST(static_bind_resolves_all_symbols) {
  PttsApi api;
  CHECK(phonon_bind_static_api(&api) == ApiStatus::Ok);
  CHECK(api.complete());
  CHECK(api.lib == nullptr);
  CHECK(api.create == &ptts_new);
  CHECK(api.free == &ptts_free);
}

TEST(static_bind_drives_core_on_apple_mapping) {
  fake_ptts_reset();
  fake_ptts_state()->cpu_only = 0;
  PttsApi api;
  phonon_bind_static_api(&api);
  Core core(Platform::Apple);
  core.setApi(api);
  std::string eff;
  const uint32_t unit = map_compute_unit(Platform::Apple, "neuralEngine", &eff);
  LoadResult lr;
  std::string err;
  CHECK(core.create("/bundle/phonon-31m-en-coreml", unit, "en", &lr, &err) == Err::None);
  CHECK_EQ(fake_ptts_state()->last_unit, uint32_t{PTTS_UNIT_ANE});
  CHECK_EQ(eff, std::string("neuralEngine"));
  CHECK_EQ(lr.defaultVoice, std::string("alba"));  // Core ML: first voice

  int drains = 0;
  core.setFrameHook([&] { ++drains; }, 2);
  SynthResult r;
  CHECK(core.synthesize(lr.handleId, core.allocRequestId(), "Hi.", "", "", &r, &err) ==
        Err::None);
  CHECK(r.bufferId > 0);
  CHECK_EQ(drains, 2);  // 4 frames, every 2
  CHECK(core.destroy(lr.handleId) == Err::None);
  CHECK_EQ(fake_ptts_state()->live_handles, 0);
}

int main(int argc, char** argv) { return harness::run_all(argc > 1 ? argv[1] : nullptr); }
