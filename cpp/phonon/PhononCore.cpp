// PhononCore.cpp — see PhononCore.h and docs/phonon/DESIGN.md §1.4.
#include "PhononCore.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <new>

namespace rnspeech::phonon {

namespace {

// Frame-callback context. Lives on the synth thread's stack for one ptts_speak call.
struct SpeakCtx {
  std::vector<float>* sink;
  const Core* core;
  int64_t requestId;
  size_t maxSamples;
  const std::function<void()>* hook;  // nullptr when no hook
  unsigned hookEvery;
  unsigned frames;
  bool failed;
  bool cancelled;
  std::string error;
};

// Called by Rust (ptts_speak) on the synth thread. Must never unwind into Rust frames: the
// whole body is guarded and every failure becomes `return false` (stop generation).
extern "C" bool rnspeech_phonon_on_frame(const float* pcm, size_t n, void* user) noexcept {
  auto* ctx = static_cast<SpeakCtx*>(user);
  try {
    if (ctx->failed) return false;
    if (ctx->core->isCancelled(ctx->requestId)) {
      ctx->cancelled = true;
      return false;
    }
    if (n > 0) {
      if (pcm == nullptr || n > ctx->maxSamples - std::min(ctx->maxSamples, ctx->sink->size())) {
        ctx->failed = true;
        ctx->error = pcm == nullptr ? "null frame" : "audio exceeds the buffer limit";
        return false;
      }
      ctx->sink->insert(ctx->sink->end(), pcm, pcm + n);
    }
    ++ctx->frames;
    if (ctx->hook != nullptr && ctx->hookEvery > 0 && ctx->frames % ctx->hookEvery == 0) {
      (*ctx->hook)();
    }
    return true;
  } catch (const std::bad_alloc&) {
    ctx->failed = true;
    ctx->error = "out of memory";
  } catch (const std::exception& e) {
    ctx->failed = true;
    try {
      ctx->error = e.what();
    } catch (...) {
    }
  } catch (...) {
    ctx->failed = true;
  }
  return false;
}

// Sets the phase only when idle, so a platform-set phase (iOS "compiling" around a create)
// wins; always returns to idle.
class BusyScope {
 public:
  BusyScope(std::atomic<int>* slot, Busy busy) : slot_(slot) {
    int idle = static_cast<int>(Busy::Idle);
    slot_->compare_exchange_strong(idle, static_cast<int>(busy));
  }
  ~BusyScope() { slot_->store(static_cast<int>(Busy::Idle)); }
  BusyScope(const BusyScope&) = delete;
  BusyScope& operator=(const BusyScope&) = delete;

 private:
  std::atomic<int>* slot_;
};

std::string handle_error(const PttsApi& api, const PttsHandle* h, const char* fallback) {
  const char* msg = api.last_error(h);
  return msg != nullptr && *msg != '\0' ? std::string(msg) : std::string(fallback);
}

}  // namespace

const char* err_code(Err err) {
  switch (err) {
    case Err::None:
      return "";
    case Err::Unsupported:
      return "PHONON_UNSUPPORTED";
    case Err::LoadFailed:
      return "PHONON_LOAD_FAILED";
    case Err::InvalidHandle:
      return "PHONON_INVALID_HANDLE";
    case Err::InvalidBuffer:
      return "PHONON_INVALID_BUFFER";
    case Err::BufferLimit:
      return "PHONON_BUFFER_LIMIT";
    case Err::SpeakFailed:
      return "PHONON_SPEAK_FAILED";
    case Err::VoiceNotFound:
      return "PHONON_VOICE_NOT_FOUND";
    case Err::LanguageUnsupported:
      return "PHONON_LANGUAGE_UNSUPPORTED";
    case Err::CallbackFailed:
      return "PHONON_CALLBACK_FAILED";
    case Err::Internal:
      return "PHONON_INTERNAL";
  }
  return "PHONON_INTERNAL";
}

const char* busy_name(Busy busy) {
  switch (busy) {
    case Busy::Idle:
      return "idle";
    case Busy::Loading:
      return "loading";
    case Busy::Compiling:
      return "compiling";
    case Busy::Speaking:
      return "speaking";
  }
  return "idle";
}

uint32_t map_compute_unit(Platform platform, const std::string& requested,
                          std::string* effective) {
  if (platform == Platform::Android || requested == "cpu") {
    if (effective != nullptr) *effective = "cpu";
    return PTTS_UNIT_CPU;
  }
  if (effective != nullptr) *effective = "neuralEngine";
  return PTTS_UNIT_ANE;
}

std::vector<std::string> parse_nul_list(const char* blob) {
  std::vector<std::string> out;
  if (blob == nullptr) return out;
  while (*blob != '\0') {
    std::string item(blob);
    blob += item.size() + 1;
    out.push_back(std::move(item));
  }
  return out;
}

std::string upstream_default_voice(Platform platform, const std::vector<std::string>& voices) {
  if (voices.empty()) return std::string();
  if (platform == Platform::Android &&
      std::find(voices.begin(), voices.end(), "default") != voices.end()) {
    return "default";
  }
  return voices.front();
}

void float_to_pcm16(const float* in, size_t n, float gain, int16_t* out) noexcept {
  for (size_t i = 0; i < n; ++i) {
    float v = in[i] * gain;
    if (std::isnan(v)) {
      out[i] = 0;
      continue;
    }
    v = std::max(-1.0f, std::min(1.0f, v));
    out[i] = static_cast<int16_t>(v < 0 ? v * 32768.0f : v * 32767.0f);
  }
}

double monotonic_ms() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------------------------------------

Core& Core::get() {
  static Core* instance = new Core();
  return *instance;
}

Core::Core(Platform platform, CoreLimits limits) : platform_(platform), limits_(limits) {}

Core::~Core() {
  std::lock_guard<std::mutex> lock(synthMutex_);
  freeHandleLocked();
}

void Core::setApi(const PttsApi& api) {
  std::lock_guard<std::mutex> lock(synthMutex_);
  if (handle_ != nullptr || !api.complete()) return;
  api_ = api;
  apiSet_.store(true);
}

bool Core::libraryLoaded() const { return apiSet_.load(); }

int64_t Core::allocRequestId() { return lastIssuedId_.fetch_add(1) + 1; }

void Core::cancelUpTo(int64_t id) {
  // fetch_max: order of concurrent cancels never matters, the watermark only moves forward.
  // Clamped to the last issued id, so a bogus id from JS cannot poison future requests.
  id = std::min(id, lastIssuedId_.load());
  int64_t cur = watermark_.load();
  while (id > cur && !watermark_.compare_exchange_weak(cur, id)) {
  }
}

void Core::cancelAll() { cancelUpTo(lastIssuedId_.load()); }

bool Core::isCancelled(int64_t id) const { return id <= watermark_.load(); }

int64_t Core::lastIssuedId() const { return lastIssuedId_.load(); }

int64_t Core::cancelWatermark() const { return watermark_.load(); }

void Core::setFrameHook(std::function<void()> hook, unsigned everyFrames) {
  std::lock_guard<std::mutex> lock(synthMutex_);
  frameHook_ = std::move(hook);
  frameHookEvery_ = everyFrames;
}

void Core::setBusy(Busy busy) { busy_.store(static_cast<int>(busy)); }

void Core::freeHandleLocked() {
  if (handle_ != nullptr) {
    api_.free(handle_);
    handle_ = nullptr;
  }
  handleId_ = 0;
  handleOpen_.store(false);
  voices_.clear();
  defaultVoice_.clear();
  currentVoice_.clear();
  currentLang_.clear();
  std::lock_guard<std::mutex> store(storeMutex_);
  buffers_.clear();
}

Err Core::create(const std::string& dir, uint32_t unit, const std::string& lang,
                 LoadResult* out, std::string* err) {
  try {
    return createImpl(dir, unit, lang, out, err);
  } catch (const std::exception& e) {
    if (err != nullptr) *err = e.what();
  } catch (...) {
    if (err != nullptr) *err = "unknown exception";
  }
  return Err::Internal;
}

Err Core::createImpl(const std::string& dir, uint32_t unit, const std::string& lang,
                     LoadResult* out, std::string* err) {
  std::lock_guard<std::mutex> lock(synthMutex_);
  if (!apiSet_.load()) {
    if (err != nullptr) *err = "Phonon library not loaded";
    return Err::Unsupported;
  }
  // One live handle per process: stop everything issued so far, then free the old handle.
  cancelAll();
  freeHandleLocked();

  BusyScope busy(&busy_, Busy::Loading);
  const double t0 = monotonic_ms();
  PttsHandle* h = api_.create(dir.c_str(), unit, lang.c_str());
  if (h == nullptr) {
    // ptts_new errors are thread-local upstream: read them here, on the same thread.
    if (err != nullptr) *err = handle_error(api_, nullptr, "ptts_new failed");
    return Err::LoadFailed;
  }
  handle_ = h;
  handleId_ = ++nextHandleId_;
  handleOpen_.store(true);
  voices_ = parse_nul_list(api_.voices(h));
  defaultVoice_ = upstream_default_voice(platform_, voices_);
  currentVoice_ = defaultVoice_;
  currentLang_ = lang;

  if (out != nullptr) {
    out->handleId = handleId_;
    out->voices = voices_;
    out->languages = parse_nul_list(api_.languages(h));
    out->defaultVoice = defaultVoice_;
    out->sampleRate = kSampleRate;
    out->loadMs = monotonic_ms() - t0;
  }
  return Err::None;
}

Err Core::destroy(int64_t handleId) {
  std::lock_guard<std::mutex> lock(synthMutex_);
  if (handle_ == nullptr || handleId != handleId_) return Err::InvalidHandle;
  freeHandleLocked();
  return Err::None;
}

Err Core::synthesize(int64_t handleId, int64_t requestId, const std::string& text,
                     const std::string& voice, const std::string& lang, SynthResult* out,
                     std::string* err, double enqueuedAtMs) {
  SynthResult r;
  r.requestId = requestId;
  r.startedAtMs = monotonic_ms();
  r.queuedMs = enqueuedAtMs > 0 ? std::max(0.0, r.startedAtMs - enqueuedAtMs) : 0;
  Err e;
  try {
    e = synthesizeImpl(handleId, requestId, text, voice, lang, &r, err);
  } catch (const std::exception& ex) {
    if (err != nullptr) *err = ex.what();
    e = Err::Internal;
  } catch (...) {
    if (err != nullptr) *err = "unknown exception";
    e = Err::Internal;
  }
  if (e != Err::None || r.cancelled) {
    r.bufferId = 0;
    r.samples = 0;
  }
  r.finishedAtMs = monotonic_ms();
  if (out != nullptr) *out = r;
  return e;
}

Err Core::synthesizeImpl(int64_t handleId, int64_t requestId, const std::string& text,
                         const std::string& voice, const std::string& lang, SynthResult* r,
                         std::string* err) {
  auto fail = [err](Err code, std::string msg) {
    if (err != nullptr) *err = std::move(msg);
    return code;
  };
  if (requestId <= 0 || requestId > lastIssuedId_.load()) {
    return fail(Err::Internal, "unknown request id " + std::to_string(requestId));
  }
  // Check 1: on dequeue. A queued request that was cancelled never touches ptts.
  if (isCancelled(requestId)) {
    r->cancelled = true;
    return Err::None;
  }

  std::lock_guard<std::mutex> lock(synthMutex_);
  if (handle_ == nullptr || handleId != handleId_) {
    return fail(Err::InvalidHandle, "stale or destroyed handle " + std::to_string(handleId));
  }
  {
    std::lock_guard<std::mutex> store(storeMutex_);
    evictOrphansLocked(0);
    if (buffers_.size() >= limits_.maxBuffers) {
      return fail(Err::BufferLimit, "buffer store full (" + std::to_string(buffers_.size()) +
                                        " unplayed buffers)");
    }
  }

  // Check 2: before conditioning.
  if (isCancelled(requestId)) {
    r->cancelled = true;
    return Err::None;
  }
  if (!lang.empty() && lang != currentLang_) {
    if (!api_.set_language(handle_, lang.c_str())) {
      return fail(Err::LanguageUnsupported, handle_error(api_, handle_, "set_language failed"));
    }
    currentLang_ = lang;
    r->voiceChanged = true;
  }
  // "" means upstream's default. On a fresh handle that is already active, so no set_voice;
  // after an explicit voice it switches back.
  const std::string& wanted = voice.empty() ? defaultVoice_ : voice;
  if (wanted != currentVoice_) {
    if (!api_.set_voice(handle_, wanted.c_str())) {
      return fail(Err::VoiceNotFound, handle_error(api_, handle_, "set_voice failed"));
    }
    currentVoice_ = wanted;
    r->voiceChanged = true;
  }

  // Check 3: right before ptts_speak.
  if (isCancelled(requestId)) {
    r->cancelled = true;
    return Err::None;
  }

  BusyScope busy(&busy_, Busy::Speaking);
  std::vector<float> sink;
  const size_t maxSamples = limits_.maxBytes / sizeof(float);
  // ~90 ms of audio per character, capped.
  const double estimate = static_cast<double>(text.size()) * kSampleRate * 0.09;
  try {
    sink.reserve(static_cast<size_t>(
        std::min<double>(estimate, static_cast<double>(std::min(limits_.maxReserveSamples,
                                                                maxSamples)))));
  } catch (const std::bad_alloc&) {
    // Not fatal: the callback grows the sink, and reports a failed allocation itself.
  }

  SpeakCtx ctx{&sink, this, requestId, maxSamples, frameHook_ ? &frameHook_ : nullptr,
               frameHookEvery_, 0, false, false, std::string()};
  PttsResult pr{};
  const bool ok = api_.speak(handle_, text.c_str(), &rnspeech_phonon_on_frame, &ctx, &pr);
  if (ctx.failed) {
    return fail(Err::CallbackFailed,
                ctx.error.empty() ? std::string("frame callback failed") : ctx.error);
  }
  if (!ok) return fail(Err::SpeakFailed, handle_error(api_, handle_, "ptts_speak failed"));
  r->ttfaMs = pr.ttfa_ms;
  r->totalMs = pr.total_ms;

  // Check 4 (after the per-frame checks): a late cancel discards the audio.
  if (ctx.cancelled || isCancelled(requestId)) {
    r->cancelled = true;
    return Err::None;
  }
  if (sink.empty()) return Err::None;

  const size_t bytes = sink.size() * sizeof(float);
  const int64_t samples = static_cast<int64_t>(sink.size());
  int64_t bufferId;
  {
    std::lock_guard<std::mutex> store(storeMutex_);
    evictOrphansLocked(bytes);
    if (buffers_.size() >= limits_.maxBuffers || bytesLocked() + bytes > limits_.maxBytes) {
      return fail(Err::BufferLimit, "buffer store full (" + std::to_string(bytesLocked()) +
                                        " bytes unplayed)");
    }
    bufferId = ++nextBufferId_;
    buffers_.push_back(Buffer{bufferId, requestId, std::move(sink)});
  }
  // Cancel raced the store: drop it now rather than leaving an orphan for eviction.
  if (isCancelled(requestId)) {
    releaseBuffer(bufferId);
    r->cancelled = true;
    return Err::None;
  }
  r->bufferId = bufferId;
  r->samples = samples;
  return Err::None;
}

// ---- buffer store ---------------------------------------------------------------------------

bool Core::isOrphan(const Buffer& b) const { return isCancelled(b.requestId); }

size_t Core::bytesLocked() const {
  size_t total = 0;
  for (const Buffer& b : buffers_) total += b.samples.size() * sizeof(float);
  return total;
}

void Core::evictOrphansLocked(size_t extraBytes) {
  // Oldest first. Never evicts a live (non-orphan) buffer: that one is about to play.
  for (auto it = buffers_.begin(); it != buffers_.end();) {
    const bool full = buffers_.size() >= limits_.maxBuffers ||
                      bytesLocked() + extraBytes > limits_.maxBytes;
    if (!full) return;
    if (isOrphan(*it)) {
      it = buffers_.erase(it);
    } else {
      ++it;
    }
  }
}

bool Core::takeBuffer(int64_t bufferId, std::vector<float>* out) {
  std::lock_guard<std::mutex> lock(storeMutex_);
  for (auto it = buffers_.begin(); it != buffers_.end(); ++it) {
    if (it->id == bufferId) {
      if (out != nullptr) *out = std::move(it->samples);
      buffers_.erase(it);
      return true;
    }
  }
  return false;
}

bool Core::copyBuffer(int64_t bufferId, std::vector<float>* out) const {
  std::lock_guard<std::mutex> lock(storeMutex_);
  for (const Buffer& b : buffers_) {
    if (b.id == bufferId) {
      if (out != nullptr) *out = b.samples;
      return true;
    }
  }
  return false;
}

bool Core::releaseBuffer(int64_t bufferId) {
  std::lock_guard<std::mutex> lock(storeMutex_);
  for (auto it = buffers_.begin(); it != buffers_.end(); ++it) {
    if (it->id == bufferId) {
      buffers_.erase(it);
      return true;
    }
  }
  return false;
}

size_t Core::releaseOrphans() {
  std::lock_guard<std::mutex> lock(storeMutex_);
  const size_t before = buffers_.size();
  buffers_.erase(std::remove_if(buffers_.begin(), buffers_.end(),
                                [this](const Buffer& b) { return isOrphan(b); }),
                 buffers_.end());
  return before - buffers_.size();
}

size_t Core::liveBuffers() const {
  std::lock_guard<std::mutex> lock(storeMutex_);
  return buffers_.size();
}

size_t Core::orphanBuffers() const {
  std::lock_guard<std::mutex> lock(storeMutex_);
  return static_cast<size_t>(std::count_if(buffers_.begin(), buffers_.end(),
                                           [this](const Buffer& b) { return isOrphan(b); }));
}

CoreDiagnostics Core::diagnostics() const {
  CoreDiagnostics d;
  d.libraryLoaded = libraryLoaded();
  d.handleOpen = handleOpen_.load();
  d.liveBuffers = liveBuffers();
  d.orphanBuffers = orphanBuffers();
  d.busy = busy_name(static_cast<Busy>(busy_.load()));
  d.lastIssuedId = lastIssuedId();
  d.cancelWatermark = cancelWatermark();
  return d;
}

}  // namespace rnspeech::phonon
