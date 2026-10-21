// Usage: core_test [name-filter]; see README.md for the optional real_lib test.
#include <dlfcn.h>
#include <pthread.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <future>
#include <limits>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "PhononApi.h"
#include "PhononCore.h"
#include "PhononWorker.h"
#include "fake_ptts.h"
#include "test_harness.h"

namespace rnspeech::phonon {
inline std::ostream& operator<<(std::ostream& os, Err e) {
  return os << (e == Err::None ? "None" : err_code(e));
}
inline std::ostream& operator<<(std::ostream& os, ApiStatus s) {
  return os << api_status_reason(s);
}
}  // namespace rnspeech::phonon

using namespace rnspeech::phonon;

namespace {

constexpr int kFrame = 1920;   // fake default frame size
constexpr int kFrames = 4;     // fake default frames per speak
constexpr int kSpeakSamples = kFrame * kFrames;

struct Fake {
  PttsApi api;
  FakePttsState* (*state)() = nullptr;
  void (*reset)() = nullptr;
  void (*setVoices)(const char* const*) = nullptr;
  void (*setLanguages)(const char* const*) = nullptr;
  void (*closeGate)() = nullptr;
  void (*openGate)() = nullptr;
  int (*waitSpeaks)(int, int) = nullptr;

  FakePttsState& s() { return *state(); }
};

template <typename Fn>
void sym(void* lib, const char* name, Fn* out) {
  *out = reinterpret_cast<Fn>(dlsym(lib, name));
  if (*out == nullptr) {
    std::fprintf(stderr, "missing fake control %s\n", name);
    std::abort();
  }
}

Fake& fake() {
  static Fake* f = [] {
    auto* f = new Fake();
    std::string err;
    if (phonon_load_api(&f->api, FAKE_PTTS_LIB, &err) != ApiStatus::Ok) {
      std::fprintf(stderr, "cannot load fake ptts %s: %s\n", FAKE_PTTS_LIB, err.c_str());
      std::abort();
    }
    sym(f->api.lib, "fake_ptts_state", &f->state);
    sym(f->api.lib, "fake_ptts_reset", &f->reset);
    sym(f->api.lib, "fake_ptts_set_voices", &f->setVoices);
    sym(f->api.lib, "fake_ptts_set_languages", &f->setLanguages);
    sym(f->api.lib, "fake_ptts_close_gate", &f->closeGate);
    sym(f->api.lib, "fake_ptts_open_gate", &f->openGate);
    sym(f->api.lib, "fake_ptts_wait_speaks", &f->waitSpeaks);
    return f;
  }();
  return *f;
}

// Fresh fake state + a fresh Core bound to the fake.
std::unique_ptr<Core> newCore(Platform platform = Platform::Android,
                              CoreLimits limits = CoreLimits()) {
  fake().reset();
  auto core = std::make_unique<Core>(platform, limits);
  core->setApi(fake().api);
  return core;
}

int64_t createOk(Core& core, const std::string& lang = "en") {
  LoadResult lr;
  std::string err;
  const Err e = core.create("/models/phonon", PTTS_UNIT_CPU, lang, &lr, &err);
  CHECK_EQ(e, Err::None);
  CHECK(err.empty());
  return lr.handleId;
}

struct Synth {
  Err err;
  SynthResult r;
  std::string msg;
};

Synth synth(Core& core, int64_t handle, int64_t id, const std::string& text = "Hello there.",
            const std::string& voice = "", const std::string& lang = "") {
  Synth s;
  s.err = core.synthesize(handle, id, text, voice, lang, &s.r, &s.msg);
  return s;
}

template <typename F>
auto onWorker(Worker& worker, F fn) -> std::future<decltype(fn())> {
  auto task = std::make_shared<std::packaged_task<decltype(fn())()>>(std::move(fn));
  auto fut = task->get_future();
  CHECK(worker.post([task] { (*task)(); }));
  return fut;
}

bool ready(std::future<Synth>& f, int ms = 0) {
  return f.wait_for(std::chrono::milliseconds(ms)) == std::future_status::ready;
}

}  // namespace

TEST(api_loads_all_symbols) {
  PttsApi api;
  std::string err;
  CHECK_EQ(phonon_load_api(&api, FAKE_PTTS_LIB, &err), ApiStatus::Ok);
  CHECK(api.complete());
  CHECK(api.lib != nullptr);
  CHECK(err.empty());
  CHECK_EQ(std::string(api_status_reason(ApiStatus::Ok)), std::string("ok"));
  phonon_unload_api(&api);
  CHECK(!api.complete());
  CHECK(api.lib == nullptr);
}

TEST(api_missing_symbol_is_symbols_missing_without_abort) {
  PttsApi api;
  std::string err;
  const ApiStatus st = phonon_load_api(&api, FAKE_PTTS_NOSYM_LIB, &err);
  CHECK_EQ(st, ApiStatus::SymbolsMissing);
  CHECK_EQ(std::string(api_status_reason(st)), std::string("symbols-missing"));
  CHECK(err.find("ptts_set_language") != std::string::npos);
  CHECK(err.find("ptts_speak") == std::string::npos);
  // The table is untouched and the library was closed again.
  CHECK(!api.complete());
  CHECK(api.lib == nullptr);
  // A Core given an incomplete table stays unloaded and reports Unsupported.
  Core core;
  PttsApi partial;
  partial.create = fake().api.create;
  core.setApi(partial);
  CHECK(!core.libraryLoaded());
  std::string msg;
  CHECK_EQ(core.create("/m", PTTS_UNIT_CPU, "en", nullptr, &msg), Err::Unsupported);
}

TEST(api_missing_library_is_library_missing) {
  PttsApi api;
  std::string err;
  const ApiStatus st = phonon_load_api(&api, "/nonexistent/libptts_ffi.so", &err);
  CHECK_EQ(st, ApiStatus::LibraryMissing);
  CHECK_EQ(std::string(api_status_reason(st)), std::string("library-missing"));
  CHECK(!err.empty());
  CHECK(!api.complete());
}

TEST(create_without_library_is_unsupported) {
  Core core;
  std::string err;
  LoadResult lr;
  CHECK_EQ(core.create("/m", PTTS_UNIT_CPU, "en", &lr, &err), Err::Unsupported);
  CHECK(!err.empty());
  CHECK(!core.diagnostics().handleOpen);
}

TEST(create_reports_voices_languages_and_default) {
  auto core = newCore();
  LoadResult lr;
  std::string err;
  CHECK_EQ(core->create("/models/phonon", PTTS_UNIT_CPU, "en", &lr, &err), Err::None);
  CHECK_EQ(lr.handleId, int64_t{1});
  CHECK_EQ(lr.voices.size(), size_t{3});
  CHECK_EQ(lr.voices[0], std::string("alba"));
  CHECK_EQ(lr.voices[2], std::string("marius"));
  CHECK_EQ(lr.languages.size(), size_t{2});
  CHECK_EQ(lr.languages[1], std::string("fr"));
  CHECK_EQ(lr.defaultVoice, std::string("default"));  // cpu.rs: "default" wins
  CHECK_EQ(lr.sampleRate, 24000);
  CHECK(lr.loadMs >= 0);
  CHECK_EQ(std::string(fake().s().last_dir), std::string("/models/phonon"));
  CHECK_EQ(std::string(fake().s().last_new_lang), std::string("en"));
  CHECK(core->diagnostics().handleOpen);

  // Core ML picks the first voice instead.
  auto apple = newCore(Platform::Apple);
  fake().s().cpu_only = 0;
  LoadResult la;
  CHECK_EQ(apple->create("/b", PTTS_UNIT_ANE, "en", &la, &err), Err::None);
  CHECK_EQ(la.defaultVoice, std::string("alba"));
}

TEST(create_destroy_and_stale_handle_ids) {
  auto core = newCore();
  const int64_t h1 = createOk(*core);
  CHECK_EQ(fake().s().live_handles, 1);

  // create again: the old handle is freed first, the id moves on.
  const int64_t h2 = createOk(*core);
  CHECK(h2 > h1);
  CHECK_EQ(fake().s().frees, 1);
  CHECK_EQ(fake().s().live_handles, 1);

  int64_t id = core->allocRequestId();
  Synth stale = synth(*core, h1, id);
  CHECK_EQ(stale.err, Err::InvalidHandle);
  CHECK(!stale.msg.empty());
  CHECK_EQ(stale.r.bufferId, int64_t{0});
  CHECK_EQ(fake().s().speaks, 0);
  CHECK_EQ(core->destroy(h1), Err::InvalidHandle);

  CHECK_EQ(core->destroy(h2), Err::None);
  CHECK_EQ(fake().s().live_handles, 0);
  CHECK(!core->diagnostics().handleOpen);
  CHECK_EQ(core->destroy(h2), Err::InvalidHandle);
  id = core->allocRequestId();
  CHECK_EQ(synth(*core, h2, id).err, Err::InvalidHandle);

  const int64_t h3 = createOk(*core);
  CHECK(h3 > h2);
  id = core->allocRequestId();
  CHECK_EQ(synth(*core, h3, id).err, Err::None);
}

TEST(create_cancels_everything_issued_before) {
  auto core = newCore();
  const int64_t h1 = createOk(*core);
  const int64_t before = core->allocRequestId();
  Synth kept = synth(*core, h1, core->allocRequestId());
  CHECK(kept.r.bufferId > 0);
  const int64_t h2 = createOk(*core);
  CHECK(core->isCancelled(before));
  // The old store went with the old handle.
  CHECK_EQ(core->liveBuffers(), size_t{0});
  CHECK(!core->copyBuffer(kept.r.bufferId, nullptr));
  // Later ids are not poisoned.
  Synth next = synth(*core, h2, core->allocRequestId());
  CHECK(!next.r.cancelled);
  CHECK(next.r.bufferId > 0);
}

TEST(destroy_frees_handle_and_clears_store) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  Synth s = synth(*core, h, core->allocRequestId());
  CHECK_EQ(core->liveBuffers(), size_t{1});
  CHECK_EQ(core->destroy(h), Err::None);
  CHECK_EQ(core->liveBuffers(), size_t{0});
  CHECK(!core->takeBuffer(s.r.bufferId, nullptr));
}

TEST(core_destructor_frees_open_handle) {
  {
    auto core = newCore();
    createOk(*core);
    CHECK_EQ(fake().s().live_handles, 1);
  }
  CHECK_EQ(fake().s().live_handles, 0);
}

TEST(load_failure_message_is_read_on_the_creating_thread) {
  auto core = newCore();
  Worker worker;
  auto fut = onWorker(worker, [&] {
    Synth out;
    LoadResult lr;
    out.err = core->create("fail:config.json: no such file", PTTS_UNIT_CPU, "en", &lr, &out.msg);
    return out;
  });
  Synth res = fut.get();
  CHECK_EQ(res.err, Err::LoadFailed);
  // Upstream keeps it thread-local: only the synth thread could have read this message.
  CHECK_EQ(res.msg, std::string("config.json: no such file"));
  CHECK(fake().api.last_error(nullptr) == nullptr);  // this (test) thread has none
  CHECK(!core->diagnostics().handleOpen);
  CHECK_EQ(core->diagnostics().busy, std::string("idle"));
  CHECK_EQ(std::string(err_code(res.err)), std::string("PHONON_LOAD_FAILED"));
}

TEST(load_failure_bad_language_and_unit) {
  auto core = newCore();
  std::string err;
  CHECK_EQ(core->create("/m", PTTS_UNIT_CPU, "klingon", nullptr, &err), Err::LoadFailed);
  CHECK(err.find("klingon") != std::string::npos);
  CHECK_EQ(core->create("/m", PTTS_UNIT_ANE, "en", nullptr, &err), Err::LoadFailed);
  CHECK(err.find("Apple only") != std::string::npos);
}

TEST(request_ids_start_at_one_and_are_monotonic) {
  Core core;
  CHECK_EQ(core.lastIssuedId(), int64_t{0});
  CHECK_EQ(core.allocRequestId(), int64_t{1});
  CHECK_EQ(core.allocRequestId(), int64_t{2});
  CHECK_EQ(core.lastIssuedId(), int64_t{2});
  CHECK_EQ(core.cancelWatermark(), int64_t{0});
  CHECK(core.isCancelled(0));  // 0 is never issued
  CHECK(!core.isCancelled(1));
}

TEST(request_ids_concurrent_alloc_unique) {
  Core core;
  constexpr int kThreads = 8, kPer = 2000;
  std::vector<std::vector<int64_t>> got(kThreads);
  std::vector<std::thread> threads;
  for (int t = 0; t < kThreads; ++t) {
    threads.emplace_back([&, t] {
      for (int i = 0; i < kPer; ++i) got[t].push_back(core.allocRequestId());
    });
  }
  for (auto& th : threads) th.join();
  std::vector<bool> seen(kThreads * kPer + 1, false);
  bool ok = true;
  for (auto& v : got) {
    for (size_t i = 0; i < v.size(); ++i) {
      if (v[i] < 1 || v[i] > kThreads * kPer || seen[v[i]]) ok = false;
      if (v[i] >= 1 && v[i] <= kThreads * kPer) seen[v[i]] = true;
      if (i > 0 && v[i] <= v[i - 1]) ok = false;  // monotonic per thread
    }
  }
  CHECK(ok);
  CHECK_EQ(core.lastIssuedId(), int64_t{kThreads * kPer});
}

TEST(cancel_current_then_prefetch_stops_both) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  const int64_t current = core->allocRequestId();
  const int64_t prefetch = core->allocRequestId();
  core->cancelUpTo(current);
  core->cancelUpTo(prefetch);
  CHECK(core->isCancelled(current));
  CHECK(core->isCancelled(prefetch));
  Synth a = synth(*core, h, current);
  Synth b = synth(*core, h, prefetch);
  CHECK_EQ(a.err, Err::None);
  CHECK(a.r.cancelled);
  CHECK(b.r.cancelled);
  CHECK_EQ(a.r.bufferId, int64_t{0});
  CHECK_EQ(fake().s().speaks, 0);
}

TEST(cancel_order_does_not_matter_watermark_never_moves_back) {
  Core core;
  const int64_t a = core.allocRequestId();
  const int64_t b = core.allocRequestId();
  core.cancelUpTo(b);
  core.cancelUpTo(a);  // late "cancel current" must not resurrect b
  CHECK_EQ(core.cancelWatermark(), b);
  CHECK(core.isCancelled(a));
  CHECK(core.isCancelled(b));
  core.cancelUpTo(-5);
  CHECK_EQ(core.cancelWatermark(), b);
}

TEST(cancel_of_unissued_id_does_not_poison_future_ids) {
  Core core;
  const int64_t a = core.allocRequestId();
  core.cancelUpTo(1000);  // never issued: clamped to the last issued id
  CHECK_EQ(core.cancelWatermark(), a);
  CHECK(core.isCancelled(a));
  CHECK(!core.isCancelled(core.allocRequestId()));
}

TEST(cancel_concurrent_fetch_max) {
  Core core;
  for (int i = 0; i < 1000; ++i) core.allocRequestId();
  std::vector<std::thread> threads;
  for (int t = 0; t < 8; ++t) {
    threads.emplace_back([&, t] {
      for (int i = 1; i <= 1000; ++i) core.cancelUpTo((i * 7 + t * 131) % 1000 + 1);
    });
  }
  for (auto& th : threads) th.join();
  CHECK_EQ(core.cancelWatermark(), int64_t{1000});
}

TEST(cancel_all_does_not_poison_the_next_request) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  const int64_t old = core->allocRequestId();
  core->cancelAll();
  CHECK(core->isCancelled(old));
  const int64_t next = core->allocRequestId();
  CHECK(!core->isCancelled(next));
  Synth s = synth(*core, h, next);
  CHECK_EQ(s.err, Err::None);
  CHECK(!s.r.cancelled);
  CHECK(s.r.bufferId > 0);
  CHECK_EQ(s.r.samples, int64_t{kSpeakSamples});
  CHECK_EQ(fake().s().speaks, 1);
  // cancelAll with nothing issued since is a no-op for later ids too.
  core->cancelAll();
  core->cancelAll();
  CHECK(!core->isCancelled(core->allocRequestId()));
}

TEST(cancel_of_queued_request_never_calls_speak) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  Worker worker;
  fake().closeGate();
  const int64_t running = core->allocRequestId();
  const int64_t queued = core->allocRequestId();
  auto f1 = onWorker(worker, [&] { return synth(*core, h, running); });
  CHECK(fake().waitSpeaks(1, 5000));  // #1 is inside ptts_speak, blocked
  auto f2 = onWorker(worker, [&] { return synth(*core, h, queued); });
  CHECK(!ready(f2, 20));
  CHECK_EQ(core->diagnostics().busy, std::string("speaking"));

  core->cancelUpTo(queued);  // stop: max(inflight)
  fake().openGate();
  Synth r1 = f1.get();
  Synth r2 = f2.get();
  CHECK(r1.r.cancelled);
  CHECK_EQ(fake().s().last_frames_delivered, 0);  // stopped at the first frame
  CHECK_EQ(fake().s().last_stopped_by_callback, 1);
  CHECK(r2.r.cancelled);
  CHECK_EQ(r2.err, Err::None);
  CHECK_EQ(fake().s().speaks, 1);  // the queued one never reached ptts
  CHECK_EQ(fake().s().set_voices, 0);
  CHECK_EQ(core->liveBuffers(), size_t{0});
  CHECK_EQ(core->diagnostics().busy, std::string("idle"));
}

namespace {
struct CancelAt {
  Core* core;
  int64_t id;
  int frame;
};
void cancel_at_frame(int index, void* arg) {
  auto* c = static_cast<CancelAt*>(arg);
  if (index == c->frame) c->core->cancelUpTo(c->id);
}
}  // namespace

TEST(cancel_mid_speak_stops_at_next_frame) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  const int64_t id = core->allocRequestId();
  CancelAt ca{core.get(), id, 1};
  fake().s().frames_per_speak = 10;
  fake().s().on_frame = &cancel_at_frame;
  fake().s().on_frame_arg = &ca;
  Synth s = synth(*core, h, id);
  CHECK_EQ(s.err, Err::None);
  CHECK(s.r.cancelled);
  CHECK_EQ(s.r.bufferId, int64_t{0});
  CHECK_EQ(fake().s().last_frames_delivered, 2);
  CHECK_EQ(fake().s().last_stopped_by_callback, 1);
  CHECK_EQ(core->liveBuffers(), size_t{0});
}

TEST(cancel_after_last_frame_discards_audio) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  const int64_t id = core->allocRequestId();
  CancelAt ca{core.get(), id, kFrames - 1};
  fake().s().on_frame = &cancel_at_frame;
  fake().s().on_frame_arg = &ca;
  Synth s = synth(*core, h, id);
  CHECK(s.r.cancelled);
  CHECK_EQ(fake().s().last_frames_delivered, kFrames);
  CHECK_EQ(core->liveBuffers(), size_t{0});
}

TEST(cancel_before_conditioning_skips_set_voice) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  const int64_t id = core->allocRequestId();
  core->cancelUpTo(id);
  Synth s = synth(*core, h, id, "Hi.", "alba", "fr");
  CHECK(s.r.cancelled);
  CHECK_EQ(fake().s().set_voices, 0);
  CHECK_EQ(fake().s().set_languages, 0);
}

TEST(request_ids_survive_simulated_reload) {
  // Two RN "modules" in sequence talk to the same process-wide Core.
  struct FakeModule {
    Core& core = Core::get();
    std::vector<int64_t> issued;
    int64_t alloc() {
      issued.push_back(core.allocRequestId());
      return issued.back();
    }
    void invalidate() { core.cancelAll(); }
  };
  int64_t lastOld = 0;
  {
    FakeModule m1;
    m1.alloc();
    m1.alloc();
    lastOld = m1.alloc();
    m1.invalidate();
  }
  FakeModule m2;  // reload: JS counters restart, native does not
  const int64_t first = m2.alloc();
  CHECK(first > lastOld);
  CHECK(!Core::get().isCancelled(first));
  CHECK(Core::get().isCancelled(lastOld));
  CHECK_EQ(&m2.core, &Core::get());
}

TEST(unknown_request_id_is_internal) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  CHECK_EQ(synth(*core, h, 0).err, Err::Internal);
  CHECK_EQ(synth(*core, h, 99).err, Err::Internal);  // never issued
  CHECK_EQ(fake().s().speaks, 0);
}

TEST(voice_and_language_applied_only_on_change) {
  auto core = newCore();
  const int64_t h = createOk(*core, "en");
  auto& s = fake().s();

  Synth r = synth(*core, h, core->allocRequestId(), "One.", "", "");
  CHECK_EQ(r.err, Err::None);
  CHECK(!r.r.voiceChanged);
  CHECK_EQ(s.set_voices, 0);  // '' skips set_voice on a fresh handle
  CHECK_EQ(s.set_languages, 0);

  r = synth(*core, h, core->allocRequestId(), "Two.", "", "en");  // same as create
  CHECK(!r.r.voiceChanged);
  CHECK_EQ(s.set_languages, 0);

  r = synth(*core, h, core->allocRequestId(), "Three.", "default", "en");  // already default
  CHECK(!r.r.voiceChanged);
  CHECK_EQ(s.set_voices, 0);

  r = synth(*core, h, core->allocRequestId(), "Four.", "alba", "en");
  CHECK(r.r.voiceChanged);
  CHECK_EQ(s.set_voices, 1);
  CHECK_EQ(std::string(s.last_voice), std::string("alba"));

  r = synth(*core, h, core->allocRequestId(), "Five.", "alba", "en");
  CHECK(!r.r.voiceChanged);
  CHECK_EQ(s.set_voices, 1);

  r = synth(*core, h, core->allocRequestId(), "Six.", "alba", "fr");
  CHECK(r.r.voiceChanged);
  CHECK_EQ(s.set_languages, 1);
  CHECK_EQ(std::string(s.last_language), std::string("fr"));
  CHECK_EQ(s.set_voices, 1);

  r = synth(*core, h, core->allocRequestId(), "Seven.", "alba", "");  // '' keeps fr
  CHECK(!r.r.voiceChanged);
  CHECK_EQ(s.set_languages, 1);

  // Back to '' after an explicit voice: switch back to upstream's default.
  r = synth(*core, h, core->allocRequestId(), "Eight.", "", "fr");
  CHECK(r.r.voiceChanged);
  CHECK_EQ(s.set_voices, 2);
  CHECK_EQ(std::string(s.last_voice), std::string("default"));
  CHECK_EQ(std::string(s.last_text), std::string("Eight."));
}

TEST(unknown_voice_and_language_are_mapped) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  Synth v = synth(*core, h, core->allocRequestId(), "Hi.", "zed", "");
  CHECK_EQ(v.err, Err::VoiceNotFound);
  CHECK_EQ(v.msg, std::string("no voice named \"zed\""));  // upstream's message, via last_error(h)
  CHECK_EQ(std::string(err_code(v.err)), std::string("PHONON_VOICE_NOT_FOUND"));
  CHECK_EQ(fake().s().speaks, 0);

  Synth l = synth(*core, h, core->allocRequestId(), "Hi.", "", "xx");
  CHECK_EQ(l.err, Err::LanguageUnsupported);
  CHECK(l.msg.find("xx") != std::string::npos);
  CHECK_EQ(fake().s().speaks, 0);

  // The failed switches did not change state: '' and 'en' are still current.
  Synth ok = synth(*core, h, core->allocRequestId(), "Hi.", "", "en");
  CHECK_EQ(ok.err, Err::None);
  CHECK(!ok.r.voiceChanged);
}

TEST(model_without_voices_speaks_unconditioned) {
  auto core = newCore();
  const char* const none[] = {nullptr};
  fake().setVoices(none);
  LoadResult lr;
  std::string err;
  CHECK_EQ(core->create("/ckpt", PTTS_UNIT_CPU, "en", &lr, &err), Err::None);
  CHECK(lr.voices.empty());
  CHECK_EQ(lr.defaultVoice, std::string());
  Synth s = synth(*core, lr.handleId, core->allocRequestId());
  CHECK_EQ(s.err, Err::None);
  CHECK(s.r.bufferId > 0);
  CHECK_EQ(fake().s().set_voices, 0);
}

TEST(synthesize_result_fields) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  const int64_t id = core->allocRequestId();
  const double enq = monotonic_ms() - 5;
  SynthResult r;
  std::string err;
  CHECK_EQ(core->synthesize(h, id, "Hello.", "", "", &r, &err, enq), Err::None);
  CHECK_EQ(r.requestId, id);
  CHECK(r.bufferId > 0);
  CHECK_EQ(r.samples, int64_t{kSpeakSamples});
  CHECK_EQ(r.sampleRate, 24000);
  CHECK_EQ(r.ttfaMs, 12.5);
  CHECK_EQ(r.totalMs, 40.0);
  CHECK(r.queuedMs >= 5);
  CHECK(r.finishedAtMs >= r.startedAtMs);
  CHECK(!r.cancelled);
  std::vector<float> pcm;
  CHECK(core->copyBuffer(r.bufferId, &pcm));
  CHECK_EQ(pcm.size(), size_t{kSpeakSamples});
  CHECK_EQ(pcm[0], 0.25f);
  CHECK_EQ(pcm.back(), 0.25f);
}

TEST(empty_audio_has_no_buffer) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  fake().s().frames_per_speak = 0;
  Synth s = synth(*core, h, core->allocRequestId(), "");
  CHECK_EQ(s.err, Err::None);
  CHECK(!s.r.cancelled);
  CHECK_EQ(s.r.bufferId, int64_t{0});
  CHECK_EQ(s.r.samples, int64_t{0});
  CHECK_EQ(core->liveBuffers(), size_t{0});
}

TEST(speak_failure_uses_handle_error) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  Synth s = synth(*core, h, core->allocRequestId(), "fail please");
  CHECK_EQ(s.err, Err::SpeakFailed);
  CHECK_EQ(s.msg, std::string("speak failed: fail please"));
  CHECK_EQ(s.r.bufferId, int64_t{0});
  CHECK_EQ(core->liveBuffers(), size_t{0});
}

TEST(callback_exception_returns_false_and_process_survives) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  fake().s().frames_per_speak = 6;
  int calls = 0;
  core->setFrameHook(
      [&] {
        if (++calls == 2) throw std::runtime_error("hook exploded");
      },
      1);
  Synth s = synth(*core, h, core->allocRequestId());
  CHECK_EQ(s.err, Err::CallbackFailed);
  CHECK_EQ(s.msg, std::string("hook exploded"));
  CHECK_EQ(fake().s().last_stopped_by_callback, 1);
  CHECK_EQ(fake().s().last_frames_delivered, 1);  // frame 2 was refused
  CHECK_EQ(core->liveBuffers(), size_t{0});
  CHECK_EQ(std::string(err_code(s.err)), std::string("PHONON_CALLBACK_FAILED"));

  // bad_alloc and non-std exceptions too.
  core->setFrameHook([] { throw std::bad_alloc(); }, 1);
  s = synth(*core, h, core->allocRequestId());
  CHECK_EQ(s.err, Err::CallbackFailed);
  CHECK_EQ(s.msg, std::string("out of memory"));
  core->setFrameHook([] { throw 42; }, 1);
  s = synth(*core, h, core->allocRequestId());
  CHECK_EQ(s.err, Err::CallbackFailed);

  // The core keeps working afterwards.
  core->setFrameHook(nullptr, 0);
  s = synth(*core, h, core->allocRequestId());
  CHECK_EQ(s.err, Err::None);
  CHECK(s.r.bufferId > 0);
}

TEST(callback_allocation_limit_fails_cleanly) {
  CoreLimits limits;
  limits.maxBytes = kFrame * sizeof(float) * 2;  // two frames per request at most
  auto core = newCore(Platform::Android, limits);
  const int64_t h = createOk(*core);
  Synth s = synth(*core, h, core->allocRequestId());
  CHECK_EQ(s.err, Err::CallbackFailed);
  CHECK(s.msg.find("limit") != std::string::npos);
  CHECK_EQ(fake().s().last_frames_delivered, 2);
}

TEST(frame_hook_runs_every_n_frames) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  fake().s().frames_per_speak = 40;
  int drains = 0;
  core->setFrameHook([&] { ++drains; }, 16);
  Synth s = synth(*core, h, core->allocRequestId());
  CHECK_EQ(s.err, Err::None);
  CHECK_EQ(drains, 2);
}

TEST(buffer_copy_is_non_consuming_take_consumes_release_idempotent) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  Synth a = synth(*core, h, core->allocRequestId());
  Synth b = synth(*core, h, core->allocRequestId());
  CHECK(b.r.bufferId > a.r.bufferId);
  std::vector<float> x, y;
  CHECK(core->copyBuffer(a.r.bufferId, &x));
  CHECK(core->copyBuffer(a.r.bufferId, &y));
  CHECK(x == y);
  CHECK_EQ(core->liveBuffers(), size_t{2});

  std::vector<float> played;
  CHECK(core->takeBuffer(a.r.bufferId, &played));
  CHECK_EQ(played.size(), size_t{kSpeakSamples});
  CHECK(!core->takeBuffer(a.r.bufferId, &played));  // → PHONON_INVALID_BUFFER upstairs
  CHECK(!core->releaseBuffer(a.r.bufferId));
  CHECK_EQ(core->liveBuffers(), size_t{1});

  CHECK(core->releaseBuffer(b.r.bufferId));
  CHECK(!core->releaseBuffer(b.r.bufferId));
  CHECK(!core->releaseBuffer(12345));
  CHECK(!core->copyBuffer(b.r.bufferId, &x));
  CHECK_EQ(core->liveBuffers(), size_t{0});
}

TEST(buffer_limit_when_full_of_live_buffers) {
  CoreLimits limits;
  limits.maxBuffers = 3;
  auto core = newCore(Platform::Android, limits);
  const int64_t h = createOk(*core);
  std::vector<Synth> live;
  for (int i = 0; i < 3; ++i) live.push_back(synth(*core, h, core->allocRequestId()));
  for (auto& s : live) CHECK(s.r.bufferId > 0);
  const int speaksBefore = fake().s().speaks;
  Synth full = synth(*core, h, core->allocRequestId());
  CHECK_EQ(full.err, Err::BufferLimit);
  CHECK_EQ(std::string(err_code(full.err)), std::string("PHONON_BUFFER_LIMIT"));
  CHECK_EQ(full.r.bufferId, int64_t{0});
  CHECK_EQ(fake().s().speaks, speaksBefore);  // refused before synthesizing
  // Nothing live was evicted.
  for (auto& s : live) CHECK(core->copyBuffer(s.r.bufferId, nullptr));
  CHECK_EQ(core->orphanBuffers(), size_t{0});
}

TEST(buffer_eviction_only_takes_orphans) {
  CoreLimits limits;
  limits.maxBuffers = 3;
  auto core = newCore(Platform::Android, limits);
  const int64_t h = createOk(*core);
  Synth a = synth(*core, h, core->allocRequestId());
  Synth b = synth(*core, h, core->allocRequestId());
  core->cancelUpTo(a.r.requestId);  // a is now an orphan; b is still wanted
  CHECK_EQ(core->orphanBuffers(), size_t{1});
  Synth c = synth(*core, h, core->allocRequestId());
  CHECK_EQ(core->liveBuffers(), size_t{3});  // under the cap: nothing evicted yet
  Synth d = synth(*core, h, core->allocRequestId());
  CHECK_EQ(d.err, Err::None);
  CHECK(!core->copyBuffer(a.r.bufferId, nullptr));  // the orphan went
  CHECK(core->copyBuffer(b.r.bufferId, nullptr));
  CHECK(core->copyBuffer(c.r.bufferId, nullptr));
  CHECK(core->copyBuffer(d.r.bufferId, nullptr));
  CHECK_EQ(core->orphanBuffers(), size_t{0});
  // Full of live buffers again.
  CHECK_EQ(synth(*core, h, core->allocRequestId()).err, Err::BufferLimit);
}

TEST(buffer_byte_cap_evicts_orphans_then_fails) {
  CoreLimits limits;
  limits.maxBytes = kSpeakSamples * sizeof(float) * 2 + 16;  // two buffers fit
  auto core = newCore(Platform::Android, limits);
  const int64_t h = createOk(*core);
  Synth a = synth(*core, h, core->allocRequestId());
  Synth b = synth(*core, h, core->allocRequestId());
  CHECK(a.r.bufferId > 0 && b.r.bufferId > 0);
  Synth c = synth(*core, h, core->allocRequestId());
  CHECK_EQ(c.err, Err::BufferLimit);  // synthesized, but no room: audio dropped
  CHECK_EQ(c.r.bufferId, int64_t{0});
  CHECK_EQ(c.r.samples, int64_t{0});
  CHECK_EQ(core->liveBuffers(), size_t{2});
  core->cancelUpTo(a.r.requestId);
  Synth d = synth(*core, h, core->allocRequestId());
  CHECK_EQ(d.err, Err::None);
  CHECK(!core->copyBuffer(a.r.bufferId, nullptr));
  CHECK(core->copyBuffer(b.r.bufferId, nullptr));
}

TEST(release_orphans_frees_cancelled_buffers_only) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  Synth a = synth(*core, h, core->allocRequestId());
  Synth b = synth(*core, h, core->allocRequestId());
  core->cancelUpTo(a.r.requestId);
  CHECK_EQ(core->releaseOrphans(), size_t{1});
  CHECK_EQ(core->liveBuffers(), size_t{1});
  CHECK(core->copyBuffer(b.r.bufferId, nullptr));
  core->cancelAll();  // invalidate
  CHECK_EQ(core->orphanBuffers(), size_t{1});
  CHECK_EQ(core->releaseOrphans(), size_t{1});
  CHECK_EQ(core->diagnostics().liveBuffers, size_t{0});
}

TEST(float_to_pcm16_clamp_gain_and_nan) {
  const float nan = std::numeric_limits<float>::quiet_NaN();
  const float inf = std::numeric_limits<float>::infinity();
  const float in[] = {0.0f, 1.0f, -1.0f, 2.0f, -2.0f, 0.5f, -0.5f, nan, inf, -inf, 1e-6f};
  constexpr size_t n = sizeof(in) / sizeof(in[0]);
  int16_t out[n];
  float_to_pcm16(in, n, 1.0f, out);
  const int16_t want[n] = {0, 32767, -32768, 32767, -32768, 16383, -16384, 0, 32767, -32768, 0};
  for (size_t i = 0; i < n; ++i) CHECK_EQ(out[i], want[i]);

  const float g[] = {0.5f, -0.5f, 0.75f, inf};
  int16_t go[4];
  float_to_pcm16(g, 4, 2.0f, go);
  CHECK_EQ(go[0], int16_t{32767});
  CHECK_EQ(go[1], int16_t{-32768});
  CHECK_EQ(go[2], int16_t{32767});  // 1.5 clamps
  CHECK_EQ(go[3], int16_t{32767});
  float_to_pcm16(g, 4, 0.0f, go);
  CHECK_EQ(go[0], int16_t{0});
  CHECK_EQ(go[3], int16_t{0});  // inf × 0 = NaN → 0
  float_to_pcm16(g, 2, 0.5f, go);
  CHECK_EQ(go[0], int16_t{8191});  // 0.25 × 32767 = 8191.75, truncated
  CHECK_EQ(go[1], int16_t{-8192});
  float_to_pcm16(nullptr, 0, 1.0f, nullptr);  // n == 0 touches nothing
}

TEST(compute_unit_mapping) {
  std::string eff;
  // Android: always CPU, whatever JS asked for.
  CHECK_EQ(map_compute_unit(Platform::Android, "neuralEngine", &eff), uint32_t{PTTS_UNIT_CPU});
  CHECK_EQ(eff, std::string("cpu"));
  CHECK_EQ(map_compute_unit(Platform::Android, "cpu", &eff), uint32_t{PTTS_UNIT_CPU});
  CHECK_EQ(map_compute_unit(Platform::Android, "", &eff), uint32_t{PTTS_UNIT_CPU});
  CHECK_EQ(map_compute_unit(Platform::Android, "gpu", nullptr), uint32_t{PTTS_UNIT_CPU});
  CHECK_EQ(map_compute_unit(Platform::Apple, "neuralEngine", &eff), uint32_t{PTTS_UNIT_ANE});
  CHECK_EQ(eff, std::string("neuralEngine"));
  CHECK_EQ(map_compute_unit(Platform::Apple, "cpu", &eff), uint32_t{PTTS_UNIT_CPU});
  CHECK_EQ(eff, std::string("cpu"));
  CHECK_EQ(map_compute_unit(Platform::Apple, "", &eff), uint32_t{PTTS_UNIT_ANE});
  CHECK_EQ(eff, std::string("neuralEngine"));

  // End to end on Android: the unit reaching ptts_new is CPU.
  auto core = newCore();
  LoadResult lr;
  std::string err;
  const uint32_t unit = map_compute_unit(Platform::Android, "neuralEngine", nullptr);
  CHECK_EQ(core->create("/m", unit, "en", &lr, &err), Err::None);
  CHECK_EQ(fake().s().last_unit, uint32_t{PTTS_UNIT_CPU});
}

TEST(parse_nul_list_and_default_voice) {
  CHECK(parse_nul_list(nullptr).empty());
  CHECK(parse_nul_list("\0").empty());
  auto v = parse_nul_list("a\0bc\0\0");
  CHECK_EQ(v.size(), size_t{2});
  CHECK_EQ(v[1], std::string("bc"));
  CHECK_EQ(upstream_default_voice(Platform::Android, {}), std::string());
  CHECK_EQ(upstream_default_voice(Platform::Android, {"a", "b"}), std::string("a"));
  CHECK_EQ(upstream_default_voice(Platform::Android, {"a", "default"}), std::string("default"));
  CHECK_EQ(upstream_default_voice(Platform::Apple, {"a", "default"}), std::string("a"));
}

TEST(error_codes) {
  CHECK_EQ(std::string(err_code(Err::None)), std::string());
  CHECK_EQ(std::string(err_code(Err::Unsupported)), std::string("PHONON_UNSUPPORTED"));
  CHECK_EQ(std::string(err_code(Err::LoadFailed)), std::string("PHONON_LOAD_FAILED"));
  CHECK_EQ(std::string(err_code(Err::InvalidHandle)), std::string("PHONON_INVALID_HANDLE"));
  CHECK_EQ(std::string(err_code(Err::InvalidBuffer)), std::string("PHONON_INVALID_BUFFER"));
  CHECK_EQ(std::string(err_code(Err::BufferLimit)), std::string("PHONON_BUFFER_LIMIT"));
  CHECK_EQ(std::string(err_code(Err::SpeakFailed)), std::string("PHONON_SPEAK_FAILED"));
  CHECK_EQ(std::string(err_code(Err::VoiceNotFound)), std::string("PHONON_VOICE_NOT_FOUND"));
  CHECK_EQ(std::string(err_code(Err::LanguageUnsupported)),
           std::string("PHONON_LANGUAGE_UNSUPPORTED"));
  CHECK_EQ(std::string(err_code(Err::CallbackFailed)), std::string("PHONON_CALLBACK_FAILED"));
  CHECK_EQ(std::string(err_code(Err::Internal)), std::string("PHONON_INTERNAL"));
  CHECK_EQ(std::string(busy_name(Busy::Compiling)), std::string("compiling"));
}

TEST(diagnostics_and_busy) {
  auto core = newCore();
  CoreDiagnostics d = core->diagnostics();
  CHECK(d.libraryLoaded);
  CHECK(!d.handleOpen);
  CHECK_EQ(d.busy, std::string("idle"));
  const int64_t h = createOk(*core);
  const int64_t a = core->allocRequestId();
  synth(*core, h, a);
  core->allocRequestId();
  core->cancelUpTo(a);
  d = core->diagnostics();
  CHECK(d.handleOpen);
  CHECK_EQ(d.lastIssuedId, a + 1);
  CHECK_EQ(d.cancelWatermark, a);
  CHECK_EQ(d.liveBuffers, size_t{1});
  CHECK_EQ(d.orphanBuffers, size_t{1});

  // A platform-set phase survives create's own "loading" and is cleared afterwards.
  core->setBusy(Busy::Compiling);
  CHECK_EQ(core->diagnostics().busy, std::string("compiling"));
  createOk(*core);
  CHECK_EQ(core->diagnostics().busy, std::string("idle"));
}

TEST(set_api_ignored_while_handle_open) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  PttsApi empty;
  core->setApi(empty);  // incomplete: ignored
  CHECK(core->libraryLoaded());
  core->setApi(fake().api);  // handle open: ignored, still works
  CHECK_EQ(synth(*core, h, core->allocRequestId()).err, Err::None);
}

TEST(stress_cancel_while_synthesizing) {
  auto core = newCore();
  const int64_t h = createOk(*core);
  fake().s().frames_per_speak = 8;
  fake().s().frame_size = 64;
  Worker worker;
  std::atomic<bool> stop{false};
  std::vector<int64_t> ids;
  std::vector<std::future<Synth>> futs;
  for (int i = 0; i < 200; ++i) {
    const int64_t id = core->allocRequestId();
    futs.push_back(onWorker(worker, [&core, h, id] { return synth(*core, h, id, "x"); }));
  }
  std::thread canceller([&] {
    int64_t i = 0;
    while (!stop.load()) {
      core->cancelUpTo(i += 3);
      std::this_thread::yield();
    }
  });
  int cancelled = 0, played = 0;
  for (auto& f : futs) {
    Synth s = f.get();
    CHECK(s.err == Err::None || s.err == Err::BufferLimit);
    if (s.r.cancelled) {
      ++cancelled;
      CHECK_EQ(s.r.bufferId, int64_t{0});
    } else if (s.r.bufferId > 0) {
      ++played;
      core->takeBuffer(s.r.bufferId, nullptr);
    }
  }
  stop = true;
  canceller.join();
  CHECK_EQ(cancelled + played <= 200, true);
  core->cancelAll();
  core->releaseOrphans();
  CHECK_EQ(core->liveBuffers(), size_t{0});
}

TEST(worker_runs_jobs_in_order_with_hook) {
  std::vector<int> order;
  std::vector<std::string> trace;
  std::mutex mu;
  bool allOnWorker = true;
  {
    Worker::Options opts;
    opts.name = "phonon-synth-test-long-name";
    Worker worker(opts);
    CHECK(worker.running());
    CHECK(!worker.isWorkerThread());
    worker.setJobHook([&](const Worker::Job& job) {
      {
        std::lock_guard<std::mutex> lock(mu);
        trace.push_back("begin");
      }
      job();
      std::lock_guard<std::mutex> lock(mu);
      trace.push_back("end");
    });
    for (int i = 0; i < 50; ++i) {
      CHECK(worker.post([&, i] {
        std::lock_guard<std::mutex> lock(mu);
        order.push_back(i);
        trace.push_back("job");
        if (!worker.isWorkerThread()) allOnWorker = false;
      }));
    }
    CHECK(!worker.post(Worker::Job()));  // empty job refused
  }  // destructor drains then joins
  CHECK_EQ(order.size(), size_t{50});
  bool inOrder = true;
  for (int i = 0; i < 50 && i < static_cast<int>(order.size()); ++i) {
    if (order[i] != i) inOrder = false;
  }
  CHECK(inOrder);
  CHECK(allOnWorker);
  CHECK_EQ(trace.size(), size_t{150});
  bool wrapped = true;
  for (size_t i = 0; i + 2 < trace.size(); i += 3) {
    if (trace[i] != "begin" || trace[i + 1] != "job" || trace[i + 2] != "end") wrapped = false;
  }
  CHECK(wrapped);
}

TEST(worker_thread_has_8mb_stack_and_name) {
  Worker worker;
  auto fut = onWorker(worker, [] {
    size_t stack = 0;
#if defined(__APPLE__)
    stack = pthread_get_stacksize_np(pthread_self());
#else
    pthread_attr_t attr;
    if (pthread_getattr_np(pthread_self(), &attr) == 0) {
      pthread_attr_getstacksize(&attr, &stack);
      pthread_attr_destroy(&attr);
    }
#endif
    char name[32] = {0};
    pthread_getname_np(pthread_self(), name, sizeof(name));
    return std::make_pair(stack, std::string(name));
  });
  auto res = fut.get();
  CHECK(res.first >= (8u << 20));
  CHECK_EQ(res.second, std::string("phonon-synth"));
}

TEST(worker_survives_throwing_job_and_hook) {
  Worker worker;
  CHECK(worker.post([] { throw std::runtime_error("job failed"); }));
  auto ok = onWorker(worker, [] { return 7; });
  CHECK_EQ(ok.get(), 7);
  worker.setJobHook([](const Worker::Job&) { throw 1; });
  CHECK(worker.post([] {}));
  worker.setJobHook(nullptr);
  auto after = onWorker(worker, [] { return 8; });
  CHECK_EQ(after.get(), 8);
  CHECK_EQ(worker.pending(), size_t{0});
}

TEST(shared_worker_and_core_are_singletons) {
  CHECK_EQ(&Worker::shared(), &Worker::shared());
  CHECK_EQ(&Core::get(), &Core::get());
  auto fut = onWorker(Worker::shared(), [] { return Worker::shared().isWorkerThread(); });
  CHECK(fut.get());
}

TEST(real_lib) {
  const char* lib = std::getenv("PHONON_REAL_LIB");
  const char* model = std::getenv("PHONON_MODEL_DIR");
  if (lib == nullptr || model == nullptr) {
    std::printf("    skipped (set PHONON_REAL_LIB and PHONON_MODEL_DIR)\n");
    return;
  }
  PttsApi api;
  std::string err;
  CHECK_EQ(phonon_load_api(&api, lib, &err), ApiStatus::Ok);
  if (!api.complete()) {
    std::fprintf(stderr, "    %s\n", err.c_str());
    return;
  }
  Core core;
  core.setApi(api);
  Worker worker;
  auto load = onWorker(worker, [&] {
    LoadResult lr;
    std::string e;
    // A missing folder fails with upstream's message, read on this thread.
    Err bad = core.create("/nonexistent-phonon", PTTS_UNIT_CPU, "en", &lr, &e);
    std::printf("    bad dir: %s %s\n", err_code(bad), e.c_str());
    CHECK_EQ(bad, Err::LoadFailed);
    CHECK(!e.empty() && e != "ptts_new failed");
    e.clear();
    Err ok = core.create(model, map_compute_unit(Platform::Android, "neuralEngine", nullptr),
                         "en", &lr, &e);
    CHECK_EQ(ok, Err::None);
    if (ok != Err::None) std::fprintf(stderr, "    create: %s\n", e.c_str());
    return lr;
  });
  LoadResult lr = load.get();
  std::printf("    loaded in %.0f ms, %zu voices, default '%s', %zu languages\n", lr.loadMs,
              lr.voices.size(), lr.defaultVoice.c_str(), lr.languages.size());
  if (lr.handleId == 0) return;

  const int64_t id = core.allocRequestId();
  auto run = onWorker(worker, [&] { return synth(core, lr.handleId, id, "Hello from Phonon."); });
  Synth s = run.get();
  CHECK_EQ(s.err, Err::None);
  std::printf("    synth: %lld samples, ttfa %.0f ms, total %.0f ms %s\n",
              static_cast<long long>(s.r.samples), s.r.ttfaMs, s.r.totalMs, s.msg.c_str());
  CHECK(s.r.samples > 24000 / 2);
  std::vector<float> pcm;
  CHECK(core.takeBuffer(s.r.bufferId, &pcm));
  float peak = 0;
  for (float v : pcm) peak = std::max(peak, std::fabs(v));
  CHECK(peak > 0.01f);

  // Cancel mid-utterance: stops at the next frame.
  const int64_t id2 = core.allocRequestId();
  auto run2 = onWorker(worker, [&] {
    return synth(core, lr.handleId, id2,
                 "This is a much longer sentence that should take a while to synthesize, "
                 "so that a cancel arrives while frames are still being produced.");
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  const double t0 = monotonic_ms();
  core.cancelUpTo(id2);
  Synth c = run2.get();
  std::printf("    cancel: cancelled=%d after %.0f ms\n", c.r.cancelled ? 1 : 0,
              monotonic_ms() - t0);
  CHECK(c.r.cancelled);
  CHECK_EQ(core.liveBuffers(), size_t{0});

  // Unknown voice comes back with upstream's message.
  auto run3 = onWorker(worker, [&] {
    return synth(core, lr.handleId, core.allocRequestId(), "Hi.", "no-such-voice", "");
  });
  Synth v = run3.get();
  CHECK_EQ(v.err, Err::VoiceNotFound);
  std::printf("    unknown voice: %s\n", v.msg.c_str());
  auto fin = onWorker(worker, [&] { return core.destroy(lr.handleId); });
  CHECK_EQ(fin.get(), Err::None);
}

int main(int argc, char** argv) { return harness::run_all(argc > 1 ? argv[1] : nullptr); }
