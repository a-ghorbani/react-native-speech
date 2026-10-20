// PhononCore.h — platform-neutral Phonon state shared by Android (JNI) and iOS (ObjC++).
//
// Owns: process-wide request ids and the cancel watermark, the one live ptts handle, the PCM
// buffer store and the error mapping. The platform layers own threads, promises and playback.
// See docs/phonon/DESIGN.md §1.4.
//
// Threading:
//  * allocRequestId / cancel* / isCancelled are lock-free and callable from any thread
//    (the JS thread calls them synchronously).
//  * create / synthesize / destroy belong on the synth thread. They are also serialized by an
//    internal mutex, so misuse cannot race the handle, but a caller must still never run them
//    on the JS thread.
//  * The buffer store is mutex protected and callable from any thread.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "PhononApi.h"

namespace rnspeech::phonon {

constexpr int32_t kSampleRate = 24000;

enum class Err {
  None,
  Unsupported,
  LoadFailed,
  InvalidHandle,
  InvalidBuffer,
  BufferLimit,
  SpeakFailed,
  VoiceNotFound,
  LanguageUnsupported,
  CallbackFailed,
  Internal,
};

// Native rejection code, e.g. "PHONON_LOAD_FAILED" ("" for Err::None). DESIGN.md §1.8.
const char* err_code(Err err);

enum class Busy { Idle, Loading, Compiling, Speaking };

// "idle" | "loading" | "compiling" | "speaking".
const char* busy_name(Busy busy);

enum class Platform { Android, Apple };

// The one place a JS compute unit becomes a PTTS_UNIT_*. Android always gets PTTS_UNIT_CPU
// (upstream cpu.rs rejects anything else). Apple: "cpu" → CPU, anything else (including "" and
// "neuralEngine") → ANE. `effective` receives the unit actually used ("cpu"|"neuralEngine").
uint32_t map_compute_unit(Platform platform, const std::string& requested,
                          std::string* effective);

// Split a ptts NUL-separated list ("a\0b\0\0"). nullptr → empty.
std::vector<std::string> parse_nul_list(const char* blob);

// The voice upstream speaks with when ptts_set_voice was never called (voices are sorted).
// CPU (synth.rs default_voice): "default" if present, else the first. Core ML (coreml.rs): the
// first. No voices → "" (unconditioned).
std::string upstream_default_voice(Platform platform, const std::vector<std::string>& voices);

// Matches src/utils/AudioConverter.ts float32ToInt16: gain, clamp to [-1, 1], negative × 32768,
// positive × 32767, truncation toward zero; NaN → 0.
void float_to_pcm16(const float* in, size_t n, float gain, int16_t* out) noexcept;

// Monotonic clock in milliseconds (steady_clock), shared by Core timings and platform queues.
double monotonic_ms();

struct LoadResult {
  int64_t handleId = 0;
  std::vector<std::string> voices;
  std::vector<std::string> languages;
  std::string defaultVoice;
  int32_t sampleRate = kSampleRate;
  double loadMs = 0;
};

struct SynthResult {
  int64_t requestId = 0;
  int64_t bufferId = 0;  // 0 when cancelled or empty
  int64_t samples = 0;
  int32_t sampleRate = kSampleRate;
  double ttfaMs = 0;
  double totalMs = 0;
  double queuedMs = 0;
  bool voiceChanged = false;
  bool cancelled = false;
  double startedAtMs = 0;
  double finishedAtMs = 0;
};

struct CoreDiagnostics {
  bool libraryLoaded = false;
  bool handleOpen = false;
  size_t liveBuffers = 0;
  size_t orphanBuffers = 0;
  std::string busy;
  int64_t lastIssuedId = 0;
  int64_t cancelWatermark = 0;
};

struct CoreLimits {
  size_t maxBuffers = 16;
  size_t maxBytes = 96u << 20;
  // Upper bound for the pre-reserved sink (samples). 30 s of audio.
  size_t maxReserveSamples = 30 * kSampleRate;
};

class Core {
 public:
  // The process-wide instance. Deliberately leaked: it outlives RN reloads and is never
  // destroyed, so no exit-time destructor can race the synth thread.
  static Core& get();

  // Independent instances exist for tests only.
  explicit Core(Platform platform = kHostPlatform, CoreLimits limits = CoreLimits());
  ~Core();
  Core(const Core&) = delete;
  Core& operator=(const Core&) = delete;

  // Install the resolved function table (after phonon_load_api / phonon_bind_static_api).
  // Call once, before the first create; later calls are ignored while a handle is open.
  void setApi(const PttsApi& api);
  bool libraryLoaded() const;

  // ---- any thread, lock-free ----
  int64_t allocRequestId();            // starts at 1, never reset
  void cancelUpTo(int64_t id);         // watermark = max(watermark, min(id, lastIssuedId))
  void cancelAll();                    // cancelUpTo(lastIssuedId)
  bool isCancelled(int64_t id) const;  // id <= watermark
  int64_t lastIssuedId() const;
  int64_t cancelWatermark() const;

  // ---- synth thread only ----
  // Frees any existing handle first (after cancelAll). `unit` is a PTTS_UNIT_* from
  // map_compute_unit. Errors: Unsupported (no library), LoadFailed (ptts_new NULL, message
  // from ptts_last_error(NULL) read on this thread).
  Err create(const std::string& dir, uint32_t unit, const std::string& lang, LoadResult* out,
             std::string* err);
  // `voice` "" = upstream default voice; `lang` "" = keep the current language.
  // `enqueuedAtMs` (monotonic_ms) when the platform queued the job; 0 = not tracked.
  Err synthesize(int64_t handleId, int64_t requestId, const std::string& text,
                 const std::string& voice, const std::string& lang, SynthResult* out,
                 std::string* err, double enqueuedAtMs = 0);
  Err destroy(int64_t handleId);

  // iOS: called inside the frame callback every `everyFrames` frames (drains an autorelease
  // pool). An exception thrown by the hook fails the request with CallbackFailed.
  void setFrameHook(std::function<void()> hook, unsigned everyFrames);

  // Platform-reported phase (iOS sets Compiling before a create that must compile Core ML).
  // Core only sets its own phases (loading/speaking) while idle, and returns to idle after
  // each create/synthesize.
  void setBusy(Busy busy);

  // ---- buffer store, mutex, any thread ----
  bool takeBuffer(int64_t bufferId, std::vector<float>* out);  // play path (consumes)
  bool copyBuffer(int64_t bufferId, std::vector<float>* out) const;
  bool releaseBuffer(int64_t bufferId);  // idempotent; false if unknown
  // A buffer is orphaned once its request id is <= the cancel watermark, so cancel* orphans
  // buffers implicitly. This frees all of them (invalidate path). Returns the number freed.
  size_t releaseOrphans();
  size_t liveBuffers() const;
  size_t orphanBuffers() const;

  CoreDiagnostics diagnostics() const;

#if defined(__APPLE__)
  static constexpr Platform kHostPlatform = Platform::Apple;
#else
  static constexpr Platform kHostPlatform = Platform::Android;
#endif

 private:
  struct Buffer {
    int64_t id;
    int64_t requestId;
    std::vector<float> samples;
  };
  Err createImpl(const std::string& dir, uint32_t unit, const std::string& lang,
                 LoadResult* out, std::string* err);
  Err synthesizeImpl(int64_t handleId, int64_t requestId, const std::string& text,
                     const std::string& voice, const std::string& lang, SynthResult* r,
                     std::string* err);
  // Synth-mutex held. Frees the handle and clears the buffer store.
  void freeHandleLocked();
  bool isOrphan(const Buffer& b) const;
  // Store-mutex held. Frees orphans until `extraBytes` more fit and a slot is free.
  void evictOrphansLocked(size_t extraBytes);
  size_t bytesLocked() const;

  const Platform platform_;
  const CoreLimits limits_;

  std::atomic<int64_t> lastIssuedId_{0};
  std::atomic<int64_t> watermark_{0};
  std::atomic<int> busy_{static_cast<int>(Busy::Idle)};
  std::atomic<bool> handleOpen_{false};
  std::atomic<bool> apiSet_{false};

  // Synth-thread state, guarded by synthMutex_.
  std::mutex synthMutex_;
  PttsApi api_;
  PttsHandle* handle_ = nullptr;
  int64_t handleId_ = 0;
  int64_t nextHandleId_ = 0;
  std::vector<std::string> voices_;
  std::string defaultVoice_;
  std::string currentVoice_;
  std::string currentLang_;
  std::function<void()> frameHook_;
  unsigned frameHookEvery_ = 0;

  mutable std::mutex storeMutex_;
  std::vector<Buffer> buffers_;
  int64_t nextBufferId_ = 0;
};

}  // namespace rnspeech::phonon
