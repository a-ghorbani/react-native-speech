# Phonon engine integration: design

Status: **revision 2** (architect pass after three critic reviews; see Appendix A). Branch
`feat/phonon-engine` in worktree `/home/aghorbani/Dev/react-native-speech-phonon`. The branch has
been fast-forwarded to `origin/main` = **`bdbeb2c` (v2.6.0)**, which includes #26 (first-clause
stream flush, `FirstChunkMode`, `SelfTestPanel`). All size baselines are pinned to the
**merge-base commit** of the PR, never to a moving "origin/main".

Upstream: `gradium-ai/xn-ptts`, tag **v0.4.0**, peeled commit
**`f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa`**. The scratchpad clone is at `6f42148` (after the
tag) and its `libptts_ffi.so` is unstripped (11.2 MB, has `.symtab`): a spike artifact only. CI
rebuilds from `f07d795`; all size numbers come from CI artifacts.

Summary of decisions:

| Topic | Decision |
|---|---|
| JS surface | `TTSEngine.PHONON = 'phonon'`, `PhononEngine implements TTSEngineInterface<PhononConfig>`, wired into `Speech` like the other neural engines. All native access goes through `src/engines/phonon/NativePhonon.ts` (the jest seam). |
| Bridge | Codegen TurboModule methods on `RNSpeech`. PCM stays in a **native buffer store**; JS passes `bufferId`s. Cancel and id allocation are **synchronous** (value-returning) JSI calls. |
| Request ids & cancel | Ids are issued natively from one process-wide counter. Cancel is a monotonic **watermark** (`fetch_max`), checked before conditioning, before `ptts_speak` and in every frame callback. No sticky `-1`. |
| Native core | Shared C++ in `cpp/phonon/` (function table, request/cancel state, buffer store, error mapping, iOS worker). Host tests live **outside** `cpp/` in `test/phonon-core/` so neither CMake, the podspec glob nor npm can pick them up. |
| Lifetime | Native Phonon state (bridge, synth thread, handle) is a **process-wide singleton** that survives RN reloads. `invalidate` only calls `cancelAll()` and returns; it never destroys or joins. |
| Android loading | Shim `librnspeech_phonon.so` (built only for arm64-v8a/x86_64). `getSupport` does cheap checks only (ABI, translation, HWCAP, memory, shim load). `dlopen(libptts_ffi.so)` happens lazily in `phononCreate`, and only after the HWCAP gate. The HWCAP mask is generated from the build's feature list. |
| Generic (non-dotprod) build | Not shipped in v1; soname hook kept. |
| Persisted capability | A load/symbol failure is recorded as a negative capability record keyed by (device fingerprint, OS build, lib release, model stamp). Afterwards `getSupport` returns `supported:false` and the engine is hidden. Re-evaluated when any key changes. |
| Opt-in | Android: `RNSpeech_phononEnabled=true` (gradle property **or** `rootProject.ext`, via the existing `getExtOrDefault`). iOS: `ENV['RN_SPEECH_PHONON']='1'`. Flag off → no Phonon native binary, shim, Kotlin bridge or ObjC code; stubs report `not-compiled`. |
| "Zero size" definition | Flag off: **zero native binaries and zero model data**, dex delta ≤ 8 KB, JS bundle delta reported against a ~40 KB budget (the engine TS is always bundled; unavoidable without a separate entry point). |
| Binaries | Built/repackaged by our GH Actions `phonon-binaries.yml`, released as `phonon-bin-v0.4.0-r<N>` (`make_latest=false`), sha256-pinned in `phonon.lock.json`, fetched at consumer build time. No Rust for consumers. |
| iOS binary | Repackaged xcframework: each slice prelinked with `ld -r` exporting only the 8 `ptts_*` symbols, bitcode stripped, no headers/modulemap, plus an `ios-x86_64-simulator` **stub** slice. Frameworks: CoreML, CoreVideo (no Accelerate, no weak-link). |
| iOS model | Core ML bundle **precompiled in CI** (`.mlmodelc`), mirrored unzipped to an HF repo we control, downloaded per file and verified against `bundle.json` sha256. No zip library. |
| Threads | Android: process-wide Kotlin `object` with one 8 MB-stack synth thread. `RAYON_NUM_THREADS` sizes **both** rayon and xn's own spinning worker pool, fixed for the process lifetime. iOS: shared C++ pthread worker (8 MB stack) with `@autoreleasepool` per job and per N frames; no rayon on the Core ML path. |
| Hang safety | JS watchdog on every `phononSynthesize`: `max(10 s, 4 × expected)`. On timeout the engine is marked broken for the process and reports `ERR_PHONON_TIMEOUT`. |
| Speed / pitch | Not in the v0.4.0 FFI; ignored with one warning each (R1). |

---

## 1. Architecture

### 1.1 Layering

```
JS  Speech.ts ──► PhononEngine (src/engines/phonon/PhononEngine.ts)
                    │  chunking (TextChunker / EngineStreamSession, firstChunk aware)
                    │  generation counter, watchdog, progress events
                    ▼
    NativePhonon.ts  (only module that touches TurboSpeech.phonon*; jest.mock target)
    NeuralAudioPlayer.playBuffer()  (playback; keeps isCurrentlyPlaying in sync)
                    ▼  TurboModule (RNSpeech)
Android  RNSpeechModule.kt ─► phonon/PhononBridge (Kotlin object: synth thread, probe, capability store)
                                 └─► JNI librnspeech_phonon.so ─dlopen (lazy, after HWCAP gate)─► libptts_ffi.so
iOS      RNSpeech.mm ─► ios/phonon/RNSpeechPhonon.mm (support, capability store, autorelease hook)
                                 ▼
         cpp/phonon/PhononCore.{h,cpp}   request ids, cancel watermark, buffer store, error mapping
         cpp/phonon/PhononApi.{h,cpp}    function table: dlsym (Android) / direct symbols (iOS)
         cpp/phonon/PhononWorker.{h,cpp} serial pthread worker, 8 MB stack, per-job hook (iOS only user)
                                 ▼
         libptts_ffi.so (Android)  |  prelinked libptts_ffi.a in PhononCore.xcframework (iOS, static)
Playback: buffer → existing neural player (AudioTrack / AVAudioPlayerNode) via a shared PCM entry point.
```

### 1.2 Why TurboModule methods and not JSI

Unchanged rationale: coarse calls (tens–hundreds of ms), PCM never reaches JS on the default
path, and the repo has no C++ TurboModule plumbing. The two latency-sensitive calls
(`phononAllocRequestId`, `phononCancel*`) are made **synchronous** by returning a value, which
codegen turns into a blocking JSI call on the JS thread (the repo already does this with
`dictLookup: (word) => string | null`). They only touch atomics.

### 1.3 TurboModule spec additions (`src/NativeSpeech.ts`)

Present in every build (codegen needs a static spec); flag-off implementations are stubs.

```ts
export interface PhononSupportInfo {
  supported: boolean;
  /** 'ok' | 'not-compiled' | 'unsupported-abi' | 'translated-abi' | 'missing-cpu-features'
   *  | 'library-missing' | 'symbols-missing' | 'load-failed' | 'os-too-old' | 'low-memory'
   *  | 'forced' (debug override) | 'error' */
  reason: string;
  detail: string;
  abi: string;              // shim compile-time ABI on Android ('arm64-v8a'|'x86_64'), 'ios-arm64', ...
  osVersion: string;
  libraryVersion: string;   // '0.4.0-r1' from phonon.lock.json, '' if not compiled
  isSimulator: boolean;
  pageSize: number;         // sysconf(_SC_PAGESIZE) (Android), 16384 (iOS)
}
export interface PhononLoadResult {
  handleId: number;
  voices: string[];
  languages: string[];
  defaultVoice: string;     // what upstream picks when no voice is set ('' = unconditioned)
  sampleRate: number;       // 24000
  loadMs: number;
  compiled: boolean;        // iOS: true if this load had to compile Core ML; Android: false
  numThreads: number;       // effective RAYON_NUM_THREADS (Android); 0 on iOS
  computeUnit: string;      // effective: 'cpu' on Android; 'neuralEngine'|'cpu' on iOS
}
export interface PhononSynthResult {
  requestId: number;
  bufferId: number;         // 0 when cancelled or empty
  samples: number;
  sampleRate: number;
  ttfaMs: number;           // PttsResult.ttfa_ms (includes normalization + conditioning + prefill)
  totalMs: number;
  queuedMs: number;         // time spent waiting on the synth thread
  voiceChanged: boolean;    // voice or language differed from the previous speak
  cancelled: boolean;
  startedAtMs: number;      // native monotonic clock, for [BENCH] timelines
  finishedAtMs: number;
}
export interface PhononLoadOptions {
  language: string;         // en|fr|de|es|pt|none
  numThreads: number;       // 0 = native default policy (Android only)
  computeUnit: string;      // 'neuralEngine' | 'cpu' (iOS); Android always uses PTTS_UNIT_CPU
}
export interface PhononPlayConfig extends AudioPlayerConfig { volume?: number }
export interface PhononDiagnostics {
  memKb: number; peakMemKb: number;   // Android: VmRSS/VmHWM. iOS: phys_footprint / ledger peak
  threads: number;                    // /proc/self/status Threads (Android); task_threads count (iOS)
  libraryLoaded: boolean; handleOpen: boolean; liveBuffers: number; orphanBuffers: number;
  busy: string;                       // 'idle' | 'loading' | 'compiling' | 'speaking'
  lastIssuedId: number; cancelWatermark: number;
}

// in Spec:
phononGetSupport: () => Promise<PhononSupportInfo>;
phononNeedsCompile: (modelDir: string) => Promise<boolean>;     // iOS: any .mlpackage without .mlmodelc
phononCreate: (modelDir: string, options: PhononLoadOptions) => Promise<PhononLoadResult>;
phononAllocRequestId: () => number;                              // SYNC; process-wide, monotonic
phononSynthesize: (handleId: number, requestId: number, text: string,
                   voice: string, language: string) => Promise<PhononSynthResult>;
phononCancel: (upToRequestId: number) => boolean;                // SYNC; fetch_max(watermark, id)
phononCancelAll: () => boolean;                                  // SYNC; watermark = lastIssuedId
phononPlayBuffer: (bufferId: number, config: PhononPlayConfig) => Promise<void>;  // consumes buffer
phononCopyBuffer: (bufferId: number) => Promise<string>;         // base64 LE float32, non-consuming
phononReleaseBuffer: (bufferId: number) => boolean;              // SYNC, idempotent
phononDestroy: (handleId: number) => Promise<void>;              // enqueued; never blocks caller
phononGetDiagnostics: () => Promise<PhononDiagnostics>;
```

Notes:
* `voice` and `language` are per call and applied on the synth thread right before `ptts_speak`,
  only when they differ. `voice=''` means "do not call `ptts_set_voice`", so upstream's default
  applies (builder voice → `default` → first by name; or unconditioned if there are no voices).
  On Android `ptts_set_voice` only stores the name (cpu.rs `set_voice`); conditioning cost
  (40–370 ms) lands inside `ttfaMs`. The switch cost is measured in S7 as
  `ttfaMs(first after switch) − ttfaMs(same voice)`; there is no separate `voiceMs`.
* `phononPlayBuffer` shares one internal entry point with the base64 player:
  Android `playPcm16(bytes, sampleRate, channels, ducking, promise)`, iOS
  `-playFloatSamples:count:config:resolve:reject:`. Gain and clamp are applied natively during the
  float → int16 conversion. It **takes** (moves out) the buffer; a missing id rejects
  `PHONON_INVALID_BUFFER`.
* `phononCopyBuffer` never releases. Play is the only consuming operation; everything else goes
  through `phononReleaseBuffer`.

### 1.4 Shared native core (`cpp/phonon/`)

```cpp
// PhononApi.h — function table over the vendored ptts.h
struct PttsApi { /* create, speak, voices, set_voice, languages, set_language, last_error, free */ };
bool phonon_load_api(PttsApi *out, const char *soname, std::string *err);   // never aborts

// PhononCore.h
namespace rnspeech::phonon {
enum class Err { None, Unsupported, LoadFailed, InvalidHandle, InvalidBuffer, BufferLimit,
                 SpeakFailed, VoiceNotFound, LanguageUnsupported, CallbackFailed, Internal };
class Core {                          // process singleton
 public:
  static Core &get();
  // ---- any thread, lock-free ----
  int64_t allocRequestId();           // ++nextId_ (atomic, starts at 1, never reset)
  void cancelUpTo(int64_t id);        // atomic fetch_max(watermark_, id)
  void cancelAll();                   // cancelUpTo(nextId_.load())
  bool isCancelled(int64_t id) const; // id <= watermark_
  // ---- synth thread only ----
  Err create(const std::string &dir, uint32_t unit, const std::string &lang, LoadResult *, std::string *);
  Err synthesize(int64_t handleId, int64_t requestId, const std::string &text,
                 const std::string &voice, const std::string &lang, SynthResult *, std::string *);
  Err destroy(int64_t handleId);
  // ---- buffer store, mutex, any thread ----
  bool takeBuffer(int64_t id, std::vector<float> *out);   // play path
  bool copyBuffer(int64_t id, std::vector<float> *out) const;
  bool releaseBuffer(int64_t id);                          // idempotent
  void markOrphansUpTo(int64_t requestId);                 // called by cancel*: buffers of cancelled ids
  size_t liveBuffers() const; size_t orphanBuffers() const;
};
void float_to_pcm16(const float *in, size_t n, float gain, int16_t *out) noexcept;
}
```

* **Request ids and cancel (watermark).** `nextId_` is process-wide and never resets, so a JS
  reload (which restarts any JS counter) cannot collide with in-flight native ids; JS always gets
  ids from `phononAllocRequestId()`. `cancelUpTo(id)` is `fetch_max`, so "cancel current, then
  cancel prefetch" stops both, and order does not matter. `cancelAll()` cancels everything
  issued so far and **does not poison** later ids. A request is checked for cancellation at three
  points on the synth thread: when dequeued (returns `cancelled:true` without touching ptts),
  before `set_voice/set_language`, and before `ptts_speak`; then once per frame inside the
  callback. **Cancel latency bound:** for a running request it is at most
  normalization + voice conditioning + prefill + one frame (upstream cpu.rs runs these before
  the first frame; 40–370 ms conditioning on CPU, one 80 ms frame on Core ML). For a queued
  request it is immediate. The stop target (≤ 150 ms to `onStopped`) is a *playback* target;
  synth-cancel latency is recorded separately (S6).
* **Frame callback.** `extern "C"` trampoline, `noexcept`, whole body in `try/catch(...)`. `user`
  points at a stack `SpeakCtx {std::vector<float>* sink; const Core* core; int64_t requestId;
  bool failed;}`. The sink is pre-reserved from a length estimate
  (`text.size() × 24000 × 0.09` samples, capped). On any exception it sets `failed=true` and
  returns false; `synthesize` then reports `CallbackFailed`. C++ exceptions never unwind through
  Rust frames.
* **Buffer store.** Caps: 16 live buffers / 96 MB. Buffers belonging to request ids
  `<= watermark` are marked orphaned when a cancel arrives or when a synth completes after its id
  was cancelled. When a cap is hit, **only orphaned buffers are evicted**; if there are none the
  new synth fails with `PHONON_BUFFER_LIMIT` (never evicts a buffer that is about to play).
  `releaseBuffer` is idempotent. `destroy` clears the store.
* **Errors.** `ptts_new` errors via `last_error(nullptr)` on the same thread; speak errors via
  `last_error(h)`. Codes map to `PHONON_<ERR>` rejections with upstream's message.
* **Handle lifecycle.** One live handle per process; no `(dir,unit,lang)` dedupe. `create` frees
  any existing handle first (on the synth thread, after `cancelAll()`). `handleId` is monotonic;
  stale ids get `PHONON_INVALID_HANDLE`.
* **Compute unit.** Android JNI hard-codes `unit = PTTS_UNIT_CPU (0)` regardless of options
  (upstream cpu.rs rejects anything else). iOS maps `'neuralEngine'→PTTS_UNIT_ANE`,
  `'cpu'→PTTS_UNIT_CPU` in exactly one function. Both are host-tested.

### 1.5 Threading and lifetime

**Process-wide state.** `PhononBridge` (Android) is a Kotlin `object`; the iOS worker and Core are
C++ singletons. An RN reload creates a new `RNSpeechModule`, but it talks to the same bridge,
thread and handle, so upstream's one-thread-per-handle rule always holds.

**`invalidate()`** (both platforms) calls `cancelAll()`, drops pending promises of the old
module (they are never resolved into a dead JS runtime), releases unplayed buffers, and returns
immediately. It does **not** destroy the handle (re-creation costs up to 630 ms on Android, seconds
on iOS) and never joins or waits for the synth thread. `phononDestroy` likewise enqueues and
returns; the next `create` is serialized behind any in-flight compile/speak.

| Platform | Synth thread |
|---|---|
| Android | `PhononBridge` owns `ThreadPoolExecutor(1,1)`; its `ThreadFactory` builds `Thread(null, r, "phonon-synth", 8L shl 20)` and sets `THREAD_PRIORITY_AUDIO`. |
| iOS | `cpp/phonon/PhononWorker`: one `pthread` with an 8 MB stack and QoS `userInitiated`, a mutex/condvar job queue. iOS installs a per-job hook that wraps each job in `@autoreleasepool`; the frame trampoline also drains a pool every 16 frames (objc2/Core ML create autoreleased objects per prediction, and a non-GCD thread never drains on its own). |

**Android worker pools (rayon + xn).** `RAYON_NUM_THREADS` is read once by **both** the rayon
global pool and xn's own pool (`xn-0.2.11/src/utils.rs`, `threadpool.rs`). xn spawns
`xn-worker-{i}` threads with `std::thread` that never exit, run at normal priority, and spin
`XN_SPIN_BUDGET` iterations (default 5000) before parking. Consequences, all documented:
* Both pools are fixed for the process lifetime; `destroy` and `ptts_free` do not reclaim threads.
  S8 checks that the thread count is flat after the first init.
* `THREAD_PRIORITY_AUDIO` only applies to the calling thread (participant 0). Workers may sit on
  little cores; the thread-count default counts big cores only.
* A panic in an xn worker is outside ptts-ffi's `catch_unwind`, so a barrier could wait forever.
  The JS watchdog (1.6) turns that into `ERR_PHONON_TIMEOUT` and marks the engine broken for the
  process (later calls reject immediately; `getSupport` still reports the device as supported,
  because a restart recovers).
* Policy `PhononThreads.resolve(requested, cpuMaxFreqs: List<Long>?, availableProcessors)` (pure
  Kotlin, no Android APIs): `requested>0` → clamp to [1, cores]; else count CPUs with max freq
  ≥ 70 % of the highest, clamp [2,4]; unreadable sysfs → `min(4, cores/2)`. `XN_SPIN_BUDGET` is
  set from `PhononConfig.spinBudget` (default: upstream default unless WP9 data says otherwise).
  Both are applied with `Os.setenv` before the first create. A later create asking for a
  different count logs a warning; the effective value is returned.
* WP9 sweeps threads {2,3,4,6} × spin budget {default, 200}, recording RTF, first audio and idle
  CPU time between chunks (`/proc/<pid>/stat` utime delta over a 2 s idle window).

**iOS.** There is no rayon on the Core ML path (ptts-coreml has no rayon dependency; Mimi runs on
its own thread with `CpuOnly`). No thread policy, no iOS sweep, `numThreads=0`.
`computeUnit:'cpu'` only affects the flow LM.

### 1.6 JS engine (`src/engines/phonon/PhononEngine.ts`)

```ts
export class PhononEngine implements TTSEngineInterface<PhononConfig> {
  readonly name = TTSEngine.PHONON;
  static getSupport(): Promise<PhononSupportInfo>;   // never throws; caches only successful resolutions
  initialize(config?: PhononConfig): Promise<void>;  // getSupport → (needsCompile?) → create
  isReady(): Promise<boolean>;
  synthesize(input: SpeechInput, options?: PhononSynthesisOptions): Promise<void>;
  synthesizeStream(options?: PhononSynthesisOptions): EngineStreamHandle;
  getAvailableVoices(language?: string): Promise<string[]>;
  getVoicesWithMetadata(language?: string): PhononVoice[];
  setChunkProgressCallback(cb: ChunkProgressCallback | null): void;
  stop(): Promise<void>; destroy(): Promise<void>; release(): Promise<ReleaseResult>;
  getLastMetrics(): PhononChunkMetrics | null;
}
```

* **getSupport.** If `typeof TurboSpeech.phononGetSupport !== 'function'` (new JS on old native,
  e.g. OTA) → `not-compiled`. Everything is in try/catch; a rejection returns
  `{supported:false, reason:'error'}` **without caching**, so a transient failure is retried.
* **Generation.** Each `synthesize()`/`synthesizeStream()` call bumps `this.generation`. Chunk
  results are compared to the generation captured at call time, never to the shared
  `stopRequested`, so a late result from an old call is always discarded (released) even if the
  flag was reset by a newer call.
* **Re-entry.** `synthesize()` and `synthesizeStream()` first call `await this.stop()` (which
  cancels natively) and await the previous loop/session before resetting state.
* **synthesizeChunk(text, gen):**
  1. `id = NativePhonon.allocRequestId()`; push to `this.inflight`.
  2. `res = await withWatchdog(NativePhonon.synthesize(handle, id, text, voice, lang), budget)`
     where `budget = max(10_000, 4 × estimateMs(text))`.
  3. If `res.cancelled || gen !== this.generation`: `releaseBuffer(res.bufferId)`, return empty.
  4. If `onAudioChunk` is set: `pcm = decode(await copyBuffer(id))` (no volume yet).
  Returns `PhononChunk {requestId, bufferId, samples, sampleRate, durationSec, pcm?}`.
* **postProcess(chunk)** (immediately before play, same as Supertonic): apply volume to the JS
  copy and call `onAudioChunk`. Only played audio is observed.
* **play(chunk):** `neuralAudioPlayer.playBuffer(chunk.bufferId, sampleRate, options)`, which
  sets and clears `isCurrentlyPlaying` exactly like `play()`, so `neuralAudioPlayer.stop()` and
  `pause()` work for Phonon.
* **stop():** set `stopRequested`, bump `generation`, `NativePhonon.cancelUpTo(max(inflight))`
  (sync), resolve the stop signal, cancel the active session, `neuralAudioPlayer.stop()`
  fire-and-forget.
* **Voice:** `options.voiceId ?? config.defaultVoice ?? ''`. `''` lets native pick upstream's
  default (reported as `defaultVoice`). A non-empty unknown id rejects `ERR_PHONON_VOICE` listing
  valid ids. `voices=[]` is allowed (unconditioned speech). Voices downloaded after init need a
  re-init (documented; the example does it).
* **Language:** normalize `'en-US'`/`'en_GB'` → `'en'`; not in `languages` and not `'none'` →
  `ERR_PHONON_LANGUAGE`.
* `speed`≠1 and `pitch` warn once per instance. `PhonemeInput` rejected. Default
  `maxChunkSize` 250. `firstChunk` (`'sentence'|'clause'`) is honored for both paths, like
  Supertonic in 2.6.0 (`createMarkdownStreamBuffer({firstChunk})`, `StreamingChunker`).
* **[BENCH] per chunk:** `{event:'PHONON_CHUNK', path:'synth'|'stream', requestId, chars,
  ttfaMs, totalMs, queuedMs, startedAtMs, finishedAtMs, playStartTs, playEndTs, voiceChanged}`
  for both paths (S4/S6 use these, not EngineStreamSession logs).

**`EngineStreamSession` changes (additive, backward compatible).** Generic
`EngineStreamSession<TAudio = AudioBuffer>` with optional hooks:
* `hasAudio?: (a: TAudio) => boolean` (default `a.samples.length > 0`).
* `discard?: (a: TAudio) => void` — attached **to the synth promise itself**:
  `p.then(a => { if (this.cancelled || raceLost) discard(a) })`, and applied to
  `prefetchPromise` on every early return of `runLoop`, plus skipped empty chunks.
* `onCancel?: () => void` — called synchronously at the start of `cancel()`, before
  `stopPlayback`. Phonon passes `() => NativePhonon.cancelUpTo(max(inflight))`.

**`Speech.ts` wiring.** Add the Phonon branches wherever the other neural engines appear
(initialize, createSpeechStream, stop, release, pause, resume, getVoicesWithMetadata,
setChunkProgressCallback). **Fix for all engines:** `Speech.currentEngine` is assigned only after
the engine initializes successfully; on failure the previous value is kept. New API:

```ts
/** Never throws; never loads native engine code. */
static getEngineSupport(engine: TTSEngine): Promise<{supported: boolean; reason: string; detail?: string}>;
```

os-native/kokoro/supertonic/kitten → `{supported:true, reason:'ok'}`; phonon delegates to
`PhononEngine.getSupport()`. `src/index.tsx` exports `PhononEngine` and the Phonon types next
to the 2.6.0 exports. `jest/index.js` gains `getEngineSupport` (phonon → `not-compiled`).

### 1.7 Types (`src/types/Phonon.ts`)

```ts
export type PhononLanguage = 'en' | 'fr' | 'de' | 'es' | 'pt' | 'none';
export type PhononComputeUnit = 'neuralEngine' | 'cpu';   // single enum end to end
export interface PhononConfig {
  /** Android: checkpoint folder. iOS: the INNER bundle folder that holds bundle.json
   *  (e.g. .../phonon-31m-en-coreml/), writable, excluded from backup. */
  modelPath: string;
  language?: PhononLanguage;         // default 'en'
  defaultVoice?: string;             // default: upstream's default voice
  numThreads?: number;               // Android only; 0/undefined = policy
  spinBudget?: number;               // Android only; XN_SPIN_BUDGET
  computeUnit?: PhononComputeUnit;   // iOS only; default 'neuralEngine'
  maxChunkSize?: number;             // default 250
  voicesMetadataPath?: string;       // voices.jsonl subset for display names
}
export interface PhononVoice { id: string; name: string; language?: string; locale?: string;
  gender?: string; description?: string; }
export interface PhononSynthesisOptions extends SynthesisOptions {}
```

### 1.8 Error mapping

| Native code | JS `Error.code` | When |
|---|---|---|
| `PHONON_NOT_COMPILED` / `PHONON_UNSUPPORTED` | `ERR_PHONON_UNSUPPORTED` | flag off / probe or capability record negative (reason in message) |
| `PHONON_LOAD_FAILED` | `ERR_PHONON_LOAD` | `ptts_new` NULL; also written to the capability store (2.4) |
| `PHONON_INVALID_HANDLE` | `ERR_PHONON_NOT_INITIALIZED` | stale/destroyed handle (swallowed while stopping) |
| `PHONON_INVALID_BUFFER` | `ERR_PHONON_INTERNAL` | play of an unknown buffer (should never happen; logged) |
| `PHONON_BUFFER_LIMIT` | `ERR_PHONON_BUFFER_LIMIT` | store full of non-orphan buffers |
| `PHONON_VOICE_NOT_FOUND` / `PHONON_LANGUAGE_UNSUPPORTED` | `ERR_PHONON_VOICE` / `ERR_PHONON_LANGUAGE` | |
| `PHONON_SPEAK_FAILED` / `PHONON_CALLBACK_FAILED` | `ERR_PHONON_SYNTH` | |
| (JS watchdog) | `ERR_PHONON_TIMEOUT` | engine marked broken for the process |
| `PHONON_INTERNAL` | `ERR_PHONON_INTERNAL` | JNI/ObjC exception |

Cancellation is not an error (`cancelled:true`). `src/engines/phonon/errors.ts` exports
`toPhononError(e)` and `PhononUnsupportedError`.

### 1.9 Phase 2 (WP11): frame-streamed first chunk

Unchanged in intent: a native SPSC ring feeding a streaming AudioTrack / chained
`AVAudioPCMBuffer`s for the first chunk, `phononSpeakStreaming(...)`. It uses the same request-id
and watermark rules. Gated on WP9 baselines.

---

## 2. Capability detection (never SIGILL, never a dialog)

### 2.1 Android `PhononBridge.getSupport()` (cheap; result cached per process)

1. `BuildConfig.RN_SPEECH_PHONON == false` → `not-compiled` (stub source set has only this).
2. Debug override: `BuildConfig.RN_SPEECH_PHONON_FORCE_REASON` (only in **debug** BuildConfig;
   always `""` in release) non-empty → `supported:false, reason:<value>` (`detail:'forced'`).
3. Capability store (2.4) has a negative record for the current key → that reason.
4. Memory: `ActivityManager.MemoryInfo.totalMem < 3 GiB` → `low-memory` (pure Kotlin, before
   any native load).
5. `System.loadLibrary("rnspeech_phonon")` in try/catch(`UnsatisfiedLinkError`). The shim is
   only built for arm64-v8a and x86_64 (`if(ANDROID_ABI MATCHES "arm64-v8a|x86_64")` in CMake).
   Failure → `unsupported-abi` if `!Process.is64Bit()`, else `library-missing` (this includes a
   consumer on AGP < 8.5.1 running on a 16 KB-page kernel, where the non-16 KB-aligned libs fail
   to load; documented as an expected outcome).
6. `nativeAbi()` (compile-time: `#if __aarch64__ "arm64-v8a"` / `__x86_64__ "x86_64"`) must be in
   `BuildConfig.RN_SPEECH_PHONON_ABIS`, else `unsupported-abi`.
7. Translation: if `nativeAbi()=="arm64-v8a"` and (`Build.SUPPORTED_ABIS[0]` starts with `x86`
   or `ro.dalvik.vm.native.bridge` is set and not `"0"`) → `translated-abi` (ChromeOS
   ndk_translation/houdini, Waydroid, WSA).
8. HWCAP: `PhononCpu.evaluate(nativeHwcap(), nativeHwcap2(), requiredMask)` where
   `requiredMask` comes from the generated header `phonon_required_hwcaps.h` (2.3). Missing →
   `missing-cpu-features` with `detail` listing names.
9. `ok`.

`phononCreate` re-runs the cached probe (rejects `PHONON_UNSUPPORTED` without native work if it
failed), then on the synth thread: `dlopen("libptts_ffi.so", RTLD_NOW|RTLD_LOCAL)` and
`phonon_load_api()`. dlopen failure → `library-missing`, missing symbol → `dlclose` +
`symbols-missing`; both are written to the capability store, so from then on the engine is hidden.
**`dlopen` therefore happens only when the user actually picks Phonon**, never on UI mount, and
never before the HWCAP gate (`.init_array` of `libptts_ffi` never runs on unsupported CPUs).

### 2.2 iOS `RNSpeechPhonon +support`

1. `#if !RN_SPEECH_PHONON` → `not-compiled`.
2. Debug override: env `RN_SPEECH_PHONON_FORCE_REASON` or Info.plist key
   `RNSpeechPhononForceReason`, honored only in `DEBUG` builds.
3. Capability store negative record → that reason (typically `load-failed`).
4. `@available(iOS 18.0, *)` else `os-too-old`.
5. x86_64 simulator → `unsupported-abi` (the xcframework's x86_64 slice is a stub, 3.3).
6. `physicalMemory < 3 GiB` → `low-memory` (a floor only; upstream reports ~95 MB while
   speaking, the Android RSS numbers do not apply).
7. `ok`. Optional hw.machine allowlist (A14+) is **not** enabled by default (owner decision D4).
   Docs state that hardware support is verified only on A15 plus the simulator.

### 2.3 HWCAP gate generated from build features

`scripts/phonon/build-android.sh` takes `ARM64_FEATURES` (default `+dotprod,+fp16`, same as
upstream), writes it to `BUILDINFO.json`, and the zip ships `include/phonon_required_hwcaps.h`
mapping each feature to `<asm/hwcap.h>` macros (`HWCAP_ASIMDDP`, `HWCAP_FPHP`, `HWCAP_ASIMDHP`;
unknown feature → build failure). `phonon.lock.json` records the feature list and the shim build
checks it matches. `verify-android-so.sh` disassembles the arm64 `.so` and fails on any
instruction from an extension not in the list (patterns: `casa|casal|ldadd|swp|ldapr` (LSE/RCpc),
`sqrdmlah|sqrdmlsh` (RDM), `smmla|ummla|usmmla|usdot` (i8mm), `bfdot|bfmmla|bfcvt` (bf16),
any `z[0-9]+`/`p[0-9]+` SVE registers). The spike disassembly is clean today (sdot=318, udot=2).

### 2.4 Persisted capability store

A tiny JSON file (Android: `noBackupFilesDir/rnspeech-phonon-cap.json`; iOS:
`Library/Application Support/rnspeech-phonon-cap.json`, excluded from backup) records
`{key, reason, detail, at}` where `key = (Build.FINGERPRINT | hw.machine + OS build,
libraryVersion, modelStamp)`. Written on `library-missing`, `symbols-missing` and `load-failed`.
For `load-failed`, it is written only when the failure is not a path/config error (upstream
message classified: missing file / bad path → not persisted; Core ML compile / ANE plan failure →
persisted). On iOS, a `PHONON_LOAD_FAILED` first triggers one recovery attempt (delete every
`*.mlmodelc` under `modelPath`, retry once) before persisting. Any key change re-enables the
probe. `Speech.resetEngineSupport(TTSEngine.PHONON)` clears it (example: hidden debug button).

### 2.5 No generic (non-dotprod) build in v1

Unchanged reasoning (shrinking fleet, ~7.6 MB more per arm64 install, test cost). The soname hook
stays; WP9 optionally records a local generic-build RTF on the OnePlus 6.

---

## 3. Opt-in packaging

### 3.1 `phonon.lock.json` (package root, listed in `package.json#files`)

```json
{
  "upstream": { "repo": "gradium-ai/xn-ptts", "tag": "v0.4.0",
                "commit": "f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa" },
  "arm64Features": "+dotprod,+fp16",
  "binaries": {
    "release": "phonon-bin-v0.4.0-r1",
    "android": { "asset": "phonon-android-0.4.0-r1.zip", "sha256": "PLACEHOLDER", "abis": ["arm64-v8a", "x86_64"] },
    "ios":     { "asset": "phonon-ios-0.4.0-r1.xcframework.zip", "sha256": "PLACEHOLDER" }
  }
}
```

While a sha is `PLACEHOLDER`, both Gradle and the podspec **fall back to flag-off with a
warning** (unless `RNSpeech_phononLibDir` / `RN_SPEECH_PHONON_XCFRAMEWORK` points at local
binaries). This lets WP1/WP4/WP5 land before WP2 publishes.

### 3.2 Android

Consumer `android/gradle.properties` (or `rootProject.ext.RNSpeech_phononEnabled = true`):
```properties
RNSpeech_phononEnabled=true
RNSpeech_phononAbis=arm64-v8a            # default; add x86_64 for emulators
RNSpeech_phononLibDir=/abs/path/jniLibs  # offline override, skips download
# debug-only, for evidence runs:
RNSpeech_phononForceReason=low-memory
```
Requirements: **AGP ≥ 8.5.1** (16 KB zip alignment of uncompressed libs). Expo needs a config
plugin to set the property/Podfile env (out of scope, documented).

`android/build.gradle`:
* Flags read with the existing `getExtOrDefault` helper (property or ext).
* `buildConfigField` `RN_SPEECH_PHONON`, `RN_SPEECH_PHONON_ABIS`; `RN_SPEECH_PHONON_FORCE_REASON`
  in `buildTypes.debug` only (release always `""`).
* CMake arg `-DRN_SPEECH_PHONON=ON|OFF`.
* `sourceSets.main.java.srcDirs += phononEnabled ? 'src/phonon/java' : 'src/phononStub/java'`.
* `testImplementation 'junit:junit:4.13.2'`, `testOptions.unitTests.returnDefaultValues = true`.
* `apply from: 'phonon.gradle'` when enabled.

`android/phonon.gradle`: an abstract `FetchPhononTask` (`@Input` release, sha, abis, libDir;
`@OutputDirectory` under `layout.buildDirectory.dir("phonon/jniLibs")`) that downloads into
`gradle.gradleUserHomeDir/caches/rnspeech-phonon/<release>/`, verifies sha256, and extracts only
the requested ABIs. Registered with
`androidComponents.onVariants { v -> v.sources.jniLibs?.addGeneratedSourceDirectory(task, FetchPhononTask::getOutputDir) }`
(no `preBuild.dependsOn`, no `$buildDir`). CI builds with `--configuration-cache`.

CMake: `rnspeech_phonon` target only when `RN_SPEECH_PHONON AND ANDROID_ABI MATCHES "arm64-v8a|x86_64"`,
linking `log` and `dl`, with `-Wl,-z,max-page-size=16384`. Because `ANDROID_STL=c++_shared` is
project-wide, the shim's NEEDED is `{libc, libm, libdl, liblog, libc++_shared}`
(`libc++_shared.so` already ships for native_dict). `verify-apk.sh` allows exactly this set.

* **Flag-off cost.** No shim, no jniLibs, no Phonon Kotlin (stub `PhononBridge` ~30 lines), ~12
  `override fun phonon*` delegations. Measured by `apk-size-report.sh` as three metrics:
  (a) native: set and sizes of `lib/**/*.so` **identical** to baseline, no `libptts_ffi` /
  `librnspeech_phonon`; (b) dex: delta ≤ 8 KB (`apkanalyzer dex packages`); (c) JS bundle
  (`assets/index.android.bundle`): delta reported, budget ~40 KB.
* **Flag-on cost.** With `extractNativeLibs=false` (default for minSdk ≥ 23), the `.so` is stored
  uncompressed: **~7.6 MB on device per ABI** (~2.5 MB Play download). `apk-size.json` records
  both `file-size` and `download-size`.
* **16 KB pages.** Both libs linked with max-page-size 16384; CI asserts LOAD `p_align ≥ 0x4000`
  and runtime-tests on the ps16k emulator (8.2).
* **R8.** `-keep class com.pocketpalai.speech.phonon.PhononNative { native <methods>; }`.

### 3.3 iOS

Consumer Podfile: `ENV['RN_SPEECH_PHONON'] = '1'` (optional
`ENV['RN_SPEECH_PHONON_XCFRAMEWORK']`).

`RNSpeech.podspec`:
```ruby
phonon = ENV['RN_SPEECH_PHONON'] == '1' && RNSpeechPhonon.lock_ready?(__dir__)   # placeholder → off + warn
excludes = ['ios/generated/**/*', 'ios/phonon/PhononCore.xcframework/**/*']
if phonon
  RNSpeechPhonon.ensure_xcframework!(__dir__)  # ios/phonon/fetch.rb: lock → cache → sha256 → copy
  s.vendored_frameworks = 'ios/phonon/PhononCore.xcframework'
  s.frameworks = 'AVFoundation', 'AudioToolbox', 'CoreML', 'CoreVideo'
  s.pod_target_xcconfig['GCC_PREPROCESSOR_DEFINITIONS'] += ' RN_SPEECH_PHONON=1'
else
  excludes += ['ios/phonon/**/*', 'cpp/phonon/**/*']
end
s.exclude_files = excludes
```
* Host tests live in `test/phonon-core/`, outside every glob.
* The repackaged xcframework has **no headers and no modulemap** (`-library` only); the single
  `ptts.h` is `cpp/phonon/ptts.h`. CI checks the flag-on build log has no `core_test` and the
  built products contain exactly one `ptts.h`.
* An `ios-x86_64-simulator` stub slice (8 `ptts_*` symbols; `ptts_new` returns NULL) means no
  `EXCLUDED_ARCHS` / `user_target_xcconfig` override; Intel-Mac simulator builds link and report
  `unsupported-abi`.
* `ios/phonon/PhononCore.xcframework/` is in `.gitignore` and excluded from `package.json#files`.
  It is copied from the cache at pod install (CocoaPods needs vendored paths inside the pod).
  Read-only stores (pnpm/Yarn PnP) must use `RN_SPEECH_PHONON_XCFRAMEWORK`; documented.
* `libptts_ffi.a` linking facts (verified on the release slice): no `_OBJC_CLASS_$` references, only
  CF*/CVPixelBuffer* C symbols (iOS 15-safe), no autolink commands, no Accelerate use. So no weak
  linking; the deployment target stays at `min_ios_version_supported`. The prelink step sets
  `-platform_version ios 15.1 18.0`, removing ~316 "built for newer iOS" warnings; every entry is
  behind `@available(iOS 18)`. CI asserts this with Xcode `nm -u`.

---

## 4. CI

### 4.1 `.github/workflows/phonon-binaries.yml`

Triggers: `workflow_dispatch` (`revision`) and tags `phonon-bin-v*`.

**Job `android` (ubuntu-24.04):**
1. Checkout upstream at `upstream.commit` (verify `rev-parse`).
2. Pinned Rust (`1.99.1`, targets aarch64/x86_64-linux-android), `cargo-ndk 4.1.2 --locked`, NDK
   `28.2.13676358`.
3. `scripts/phonon/build-android.sh` (reimplements upstream flags with `ARM64_FEATURES` from the
   lock, `-C strip=symbols`, `--remap-path-prefix`, `SOURCE_DATE_EPOCH`, `CARGO_INCREMENTAL=0`),
   generating `BUILDINFO.json` and `phonon_required_hwcaps.h`.
4. `verify-android-so.sh`: LOAD align ≥ 0x4000; NEEDED ⊆ {libc, libm, libdl, liblog}; exactly
   the 8 `ptts_*` dynamic symbols; **no `.symtab` / `.debug_*`**; size budgets arm64 ≤ 8.5 MB,
   x86_64 ≤ 9.5 MB; dotprod present; no disallowed-extension instructions (2.3).
   `--selftest` runs against a 4 KB-aligned dummy and must fail.
5. `cargo about` notices (MIT/Apache-2.0/BSD/ISC/Unicode/Zlib only).
6. Deterministic zip: `jniLibs/<abi>/libptts_ffi.so`, `include/{ptts.h,phonon_required_hwcaps.h}`,
   licenses, notices, `BUILDINFO.json`.
7. Reproducibility leg (warn-only).

**Job `ios` (macos-15):**
1. Download upstream `PhononCore.xcframework.zip`, verify sha
   `a10382948448087bc9f63231de3c2970d606979fd69bef7acb95d2dfa3a41cef`.
2. For each of `ios-arm64` and `ios-arm64-simulator`: `xcrun bitcode_strip -r`, then
   `xcrun ld -r -arch arm64 -platform_version ios[-simulator] 15.1 18.0
   -exported_symbols_list ptts.exp -o ptts.o <members>`, `libtool -static -o libptts_ffi.a ptts.o`.
3. Build the x86_64 simulator stub slice from `scripts/phonon/ptts_stub.c`.
4. `xcodebuild -create-xcframework -library ...` (no `-headers`).
5. Verify: `nm -gU` = exactly 8 symbols per slice; `nm -u` has no `_OBJC_CLASS_$`; no
   `__LLVM`/`__bitcode`; minos 15.1; `lipo -info`.
6. **Core ML precompile:** download `phonon-31m-en-coreml.zip` (pin sha), `xcrun coremlcompiler
   compile` each `.mlpackage`, produce a bundle with `.mlmodelc` dirs plus `bundle.json` and a
   per-file manifest (`path,size,sha256`) as a workflow artifact for the HF mirror (5).
7. Zip with ditto plus licenses/notices.

**Job `publish`:** GitHub release `phonon-bin-v<ver>-<rev>` with `make_latest: false` (does not
displace release-it's `v*` releases), `SHA256SUMS`, BUILDINFO; opens a PR updating
`phonon.lock.json` hashes (`peter-evans/create-pull-request` pinned by SHA). Write permissions
only on this job.

### 4.2 `ci.yml` changes (WP8)

* `turbo.json` `build:android` / `build:ios` inputs gain `cpp/**`, `phonon.lock.json`,
  `scripts/phonon/**`, `src/**`; env gains `RN_SPEECH_PHONON`, `ORG_GRADLE_PROJECT_RNSpeech_phononEnabled`.
* Existing `build-android` and `build-ios` jobs pin the flag **off** (`RN_SPEECH_PHONON=0`,
  `-PRNSpeech_phononEnabled=false`): they keep testing the zero-cost path.
* `test` job: also runs `scripts/test-phonon-core.sh` (ASan/UBSan) and the Kotlin JVM tests
  (`cd example/android && ./gradlew :pocketpalai_react-native-speech:testDebugUnitTest`), plus
  `npm pack --dry-run --json` asserting `phonon.lock.json`, `android/phonon.gradle`,
  `ios/phonon/fetch.rb` present; `test/`, `cpp/phonon/tests`, any `libptts_ffi*` and
  `PhononCore.xcframework` absent; tarball < N MB.
* `build-android-phonon` (no turbo cache): flag on, ABIs arm64-v8a,x86_64,
  `--configuration-cache`, R8 release; `verify-apk.sh`.
* `android-emulator-phonon` (ubuntu-latest + KVM, `reactivecircus/android-emulator-runner`):
  matrix {x86_64 API 35 `google_apis`, x86_64 API 35 `google_apis_ps16k`}. Installs the flag-on
  debug APK, triggers the self-test deep link with a CI-cached model, and asserts S1/S3/S6 on the
  4 KB image and S1 (`supported:true`, `pageSize:16384`) plus S3 on the 16 KB image.
* `android-flag-off-size`: merge-base vs head, three-metric `apk-size-report.sh`.
* `build-ios-phonon` (macos-15, Xcode with iOS 18 runtime; the job runs `xcrun simctl list
  runtimes` and fails if iOS 18 is missing): `RN_SPEECH_PHONON=1 pod install`, simulator build,
  `PhononTests` XCTest, `-all_load` link test, Release device build with
  `otool -l | grep -c __LLVM == 0` and `size -m` deltas into `ios-binary-size.json`. If an
  iOS 17 runtime exists, a launch smoke (`os-too-old`) runs **non-blocking**.

**Licenses.** Unchanged: MIT for us, both upstream license texts, generated notices in every zip,
`docs/phonon/THIRD_PARTY_NOTICES.md`, README note. Models are never bundled; 31m and voices are
Apache-2.0; 40m is CC BY-NC (example never defaults to it).

---

## 5. Model handling

| | Android | iOS |
|---|---|---|
| Format | checkpoint folder | Core ML bundle, **precompiled** (`.mlmodelc`) |
| Source (31m) | HF `gradium/phonon-31m-en` @ `52433c46…`: `config.json`, `tokenizer.json`, `model.q8.gguf` (64.5 MB), `default-voice.safetensors` | Our HF mirror (owner decision D1) of the CI-precompiled bundle; source zip `phonon-31m-en-coreml.zip` (137.1 MB zip, 170.3 MB unzipped: flow t1 55.4 MB, flow t48 55.4 MB, mimi 41.3 MB, host 8.3 MB, voices 9.7 MB, tokenizer 0.3 MB) |
| Voices | HF `gradium/phonon-voices` @ `da6c9ec0…` (`voices.jsonl` + chosen `voices/<id>.safetensors`, saved by display name) | in the bundle |
| Disk | ~66 MB + voices | precompiled: ~170 MB (no second copy). Fallback on-device compile: ~320 MB after compile, ~460 MB peak if zipped |
| Download | per file, temp dir, atomic rename | per file, each verified against `bundle.json`/manifest sha256, staging dir + atomic rename; free-space check (≥ 2× bundle + 100 MB) fails softly |
| First load | 60–630 ms | warm load measured in WP9; cold compile only on fallback (upstream: ~10 s on iPhone 16 Pro, more on A15); `phononNeedsCompile` drives a "Preparing model" state |

The library downloads no models. Must-verify in WP5: a host-compiled `.mlmodelc` loads on the A15
**ANE** (not just CPU). If not, the mirror ships `.mlpackage` and the device compiles, with the
crash-safe recovery from 2.4.

**`example/src/utils/PhononModelManager.ts`** (KittenModelManager pattern):
`downloadModel(variant, onProgress)`, `scanInstalledModel`, `isModelInstalled`, `deleteModel`,
`getDownloadedModelConfig()`. Default variant `31m-en`; 40m listed as "user-downloaded, CC
BY-NC" behind a toggle. Android: 4 files + `voices.jsonl`, curated 8 English voices. iOS: per-file
mirror into `Library/Application Support/phonon/phonon-31m-en-coreml/` (the inner folder is the
`modelPath`), `NSURLIsExcludedFromBackupKey`. No zip dependency.

---

## 6. Example app integration

* **Visibility logic** is a pure function `visibleEngines(all, supportMap)` plus a hook
  `useEngineSupport()` in `example/src/utils/engineSupport.ts`, unit-tested. `RootView` and
  `BenchmarkView` consume them. Phonon UI (chip, model card, downloads, voices) renders only if
  `supported`. Unsupported → nothing rendered, no Alert, one `console.log('[Phonon] hidden: <reason>')`.
* **No dialogs for Phonon.** The RootView init catch treats `ERR_PHONON_UNSUPPORTED` as "hide
  the engine and fall back to the previous engine" (no `Alert`). Thanks to the `Speech.initialize`
  fix the previous engine stays current.
* Init mirrors Kitten (download card → `Speech.initialize({engine: TTSEngine.PHONON, ...})`), with
  a "Preparing model" state when `phononNeedsCompile` is true. Diagnostics line `testID="phonon-diag"`
  shows reason, numThreads, loadMs, computeUnit.
* **BenchmarkView:** adds the installed Phonon model only when supported; `[BENCH]` gains
  `ttfaMs`, `queuedMs`, `voiceChanged`, `numThreads`, `computeUnit` (types + `benchmarks/schema.json`).
* **StreamingView:** engine-agnostic in 2.6.0; add the PHONON label and first-audio timing
  (already present after #26).
* **Self-test:** `example/src/selftest/phononSelfTest.ts` extends the existing `SelfTestPanel`
  `[SelfTest] <name> PASS|FAIL <detail>` convention (checks reusable by the panel). A deep link
  `speechexample://selftest/phonon?runs=5&threads=4&spin=200` triggers it (Android
  intent-filter, iOS URL type, `Linking` in `App.tsx`). It also writes `bench.jsonl`, a
  `selftest.json` summary, and screenshots (`react-native-view-shot`, example-only dependency)
  into `Documents/phonon-evidence/<runId>/`, so iOS evidence is pulled as files. On unsupported
  devices it records support, the direct `Speech.initialize({engine: PHONON})` rejection code,
  `libraryLoaded:false`, an OS-native speak smoke, and exits.
* **Flags.** The example turns the flag on only in the PR that lands real hashes (before that the
  placeholder fallback keeps it off). Flag-off builds: `-PRNSpeech_phononEnabled=false` /
  `RN_SPEECH_PHONON=0 pod install`.
* **iOS test target:** lower `SpeechExampleTests` `IPHONEOS_DEPLOYMENT_TARGET` from 26.0 to 15.1
  (both configurations), and add `PhononTests.m` there.

---

## 7. Work packages

**WP0 (done in this revision):** fast-forward to `bdbeb2c`. Recheck the §1.6 hooks against 2.6.0
`EngineStreamSession` (which now takes `firstChunk`).

Dependency graph: `WP1 → {WP4, WP5, WP6}`, `WP2 → WP8` (and real hashes for WP4/WP5 flag-on
release paths; local `LibDir`/`XCFRAMEWORK` overrides unblock development), `WP3 → {WP4, WP5}`,
`WP6 → WP7`, `{WP4, WP5, WP7} → WP8`, `{WP4, WP5, WP7, WP8} → WP9`, `WP9 → WP11`; WP10 any
time, finalized last.

**Parallel groups:**
* **G1** (start now, no shared files): WP1 (contract), WP2 (binaries CI), WP3 (C++ core).
* **G2** (after G1): WP4 (Android native, `android/**`), WP5 (iOS native, `ios/**`, podspec,
  `cpp/phonon/PhononWorker`), WP6 (JS engine, `src/**`).
* **G3:** WP7 (example) after WP6; device bring-up needs WP4/WP5.
* **G4:** WP8 (CI wiring), then WP9 (devices + evidence), WP10 (docs).
* **G5 (phase 2):** WP11.

### WP1 — Contract: spec, types, stubs
* Files: `src/NativeSpeech.ts`, `src/types/{Phonon.ts,Engine.ts,index.ts}`,
  `src/engines/phonon/NativePhonon.ts` (thin, guarded), `phonon.lock.json` (PLACEHOLDER),
  `package.json#files` (`phonon.lock.json`), `.gitignore` (xcframework), Android stub
  `PhononBridge.kt` + `RNSpeechModule.kt` delegations, `android/build.gradle` (flag via
  `getExtOrDefault`, BuildConfig incl. debug-only force reason, junit test deps), `ios/RNSpeech.mm`
  stubs, `jest/index.js`, `turbo.json` inputs/env.
* Acceptance: typecheck/lint/test green; codegen ok on both platforms (flag off);
  `getSupport` → `not-compiled`; sync methods return values (`phononCancel` → `false` in stub).
* Tests: `src/__tests__/phononSpec.test.ts`; `NativePhonon` guard (missing method → not-compiled).

### WP2 — Binaries CI + verification
* Files: `.github/workflows/phonon-binaries.yml`, `scripts/phonon/{build-android.sh,
  verify-android-so.sh, package-ios.sh, verify-ios-xcframework.sh, precompile-coreml.sh,
  ptts_stub.c, ptts.exp, about.hbs, about.toml}`, `cpp/phonon/ptts.h`,
  `docs/phonon/THIRD_PARTY_NOTICES.md`.
* Acceptance: run produces both zips + precompiled Core ML bundle artifact + SHA256SUMS +
  BUILDINFO; verify scripts pass (incl. extension scan, strip, budgets, 8 exported symbols, no
  bitcode, minos 15.1); release created with `make_latest=false`; lock PR with real hashes.
* Tests: verify scripts and their `--selftest` negatives (4 KB-aligned dummy; dummy with `.symtab`;
  dummy containing an `ldadd`).

### WP3 — Shared C++ core + host tests
* Files: `cpp/phonon/{PhononApi,PhononCore,PhononWorker}.{h,cpp}`,
  `test/phonon-core/{fake_ptts.c, core_test.cpp, CMakeLists.txt, README.md}`,
  `scripts/test-phonon-core.sh`.
* Acceptance (clang, ASan/UBSan, Linux+macOS): missing symbol → `symbols-missing`, no abort;
  create/destroy and stale ids; **cancel(current) then cancel(prefetch) stops both**; **cancelAll
  does not poison the next request**; cancel of a queued request returns `cancelled:true` without
  calling fake `ptts_speak`; ids stay monotonic across a simulated reload (new "module", same
  Core); voice/lang applied only on change and `voice=''` skips `set_voice`; buffer store:
  orphan-only eviction, `BUFFER_LIMIT` when full of live buffers, idempotent release; a callback
  that throws / fails allocation returns false and the process does not abort; `float_to_pcm16`
  clamp/gain; errors read on the same thread; compute-unit mapping (Android always CPU);
  `PhononWorker` runs jobs in order with the per-job hook invoked.
* Optional real-lib test on the aarch64 host (explicit target flags, never `native`).

### WP4 — Android integration
* Files: `android/phonon.gradle`, `android/build.gradle`, `android/proguard-rules.pro`,
  `android/src/main/cpp/{CMakeLists.txt, phonon/phonon_jni.cpp}`,
  `android/src/phonon/java/.../phonon/{PhononBridge.kt (object), PhononNative.kt, PhononCpu.kt,
  PhononThreads.kt, PhononCapabilityStore.kt}`, `RNSpeechModule.kt` (`playPcm16` refactor,
  `phononPlayBuffer`, non-blocking `invalidate`), `android/src/test/java/.../phonon/*Test.kt`,
  `scripts/test-android.sh` fix.
* Acceptance: example builds flag on/off (configuration cache on); Pixel 9: support ok, create
  (lazy dlopen) + synthesize, stop → `onStopped` ≤ 150 ms; OnePlus 6: `missing-cpu-features` and
  `/proc/<pid>/maps` has 0 `libptts_ffi` lines; R8 release works; logcat clean; force-reason
  override works in debug and is absent in release BuildConfig.
* Tests (JVM, pure functions): HWCAP matrix from the generated mask; translation detection;
  thread policy fixtures (Pixel 9, S23, SM8850, MT6899, SD845 cpufreq layouts, unreadable sysfs);
  capability-store key/round-trip; compute unit always CPU.

### WP5 — iOS integration
* Prerequisite: the lab checklist (8.6) answered.
* Files: `RNSpeech.podspec`, `ios/phonon/{fetch.rb, RNSpeechPhonon.h, RNSpeechPhonon.mm}`,
  `ios/RNSpeech.mm` (float play path, `phonon*`), `example/ios/SpeechExampleTests/PhononTests.m`,
  project deployment-target fix.
* Acceptance: `RN_SPEECH_PHONON=1 pod install` verifies/copies the xcframework; placeholder lock →
  off + warning; one `ptts.h`, no `core_test` in the build; arm64 simulator synthesizes;
  x86_64 simulator build links and reports `unsupported-abi`; flag-off app has no `ptts_`
  symbols; `-all_load` link ok; host-compiled `.mlmodelc` loads on A15 ANE (or fallback chosen);
  autorelease soak (200 utterances, `phys_footprint` slope ≤ 1 MB / 50); S11b (reload during
  compile: no hang, next create ok); iPhone passes §8.3 if iOS ≥ 18.
* Tests: XCTest support (simulator), compute-unit mapping, capability store, optional model smoke
  with `PHONON_TEST_MODEL_DIR`.

### WP6 — JS engine + Speech wiring
* Files: `src/engines/phonon/{PhononEngine.ts, constants.ts, errors.ts, voices.ts, index.ts}`,
  `src/engines/EngineStreamSession.ts` (generic + `hasAudio`/`discard`/`onCancel`),
  `src/engines/NeuralAudioPlayer.ts` (`playBuffer`), `src/Speech.ts` (Phonon branches,
  `getEngineSupport`, `currentEngine` fix), `src/index.tsx`, tests.
* Acceptance: existing suites green; phonon coverage ≥ 90 % lines; unsupported → `initialize`
  rejects without `phononCreate`; `getEngineSupport` never throws; rejected init leaves
  `Speech.getCurrentEngine()` unchanged (all engines).
* Tests (jest.mock `NativePhonon` with a deferred-controlled fake): ordered chunked playback with
  prefetch; stop between native resolve and JS continuation (buffer released, no play); stop
  during in-flight synth → `cancelUpTo(max inflight)`; `stream.cancel()` while synth #2 pending →
  `onCancel` called, no play afterwards; cancel while prefetch in flight → `discard` called,
  `liveBuffers==0`; re-entrant `synthesize()` cancels the previous one; two concurrent `speak()`;
  release during in-flight synth (INVALID_HANDLE swallowed); `reinitializeEngine` during a
  stream; `neuralAudioPlayer.stop()/pause()` call native during a pending `playBuffer`;
  watchdog timeout → `ERR_PHONON_TIMEOUT` and broken state; `onAudioChunk` fired in postProcess
  with volume, only for played chunks; voice `''` default, unknown voice, `voices=[]`; language
  normalization; speed/pitch warn once; PhonemeInput rejected; `firstChunk:'clause'`;
  getSupport guard/no-cache-on-reject/every reason → `supported:false`; Speech routing for
  stream/stop/release/pause/resume.

### WP7 — Example app
* Files: `example/src/utils/{PhononModelManager.ts, engineSupport.ts}`, `RootView`,
  `BenchmarkView`, `StreamingView`, `example/src/selftest/phononSelfTest.ts`, `App.tsx`,
  benchmark types/schema, manifest intent filter, Info.plist URL type, `example/package.json`
  (`"test": "jest"`, `react-native-view-shot`), flags (after real hashes).
* Acceptance: hidden when unsupported (no Alert anywhere), visible when supported; download →
  init → speak on Pixel 9 and simulator; self-test writes the full evidence set; example jest
  green.
* Tests: `example/src/utils/__tests__/{PhononModelManager,engineSupport}.test.ts` (mock RNFS:
  per-platform file lists, per-file sha mismatch → cleanup, atomic install, free-space fail-soft;
  visibility for every reason).

### WP8 — CI integration
* Files: `.github/workflows/ci.yml`, `turbo.json`, `scripts/phonon/{verify-apk.sh,
  apk-size-report.sh}`.
* Acceptance: jobs in 4.2 green; size job fails as intended with an injected dummy `.so` and with
  +10 KB of dex (one-off proof, linked in evidence); emulator jobs green on 4 KB and 16 KB images.

### WP9 — Device validation & evidence
* Files: `scripts/phonon/{collect-android-evidence.sh, collect-ios-evidence.sh, run-matrix.sh,
  summarize-evidence.py}`, `docs/phonon/evidence/**`.
* Acceptance: §8 complete, thread/spin defaults fixed from data, README table states what is
  verified and what is not (e.g. iOS ANE on hardware if the lab phone is < iOS 18).

### WP10 — Docs
`README.md`, `docs/USAGE.md` (flag, AGP ≥ 8.5.1, ~7.6 MB on-device per ABI, model download,
inner-folder modelPath, pnpm/read-only note, Expo note, limitations), `docs/ARCHITECTURE.md`,
`docs/LICENSES.md`, `docs/phonon/THIRD_PARTY_NOTICES.md`. CHANGELOG via release-it.

### WP11 — Frame-streamed first chunk (phase 2)
As 1.9; median stream first-audio −40 % vs WP9 baseline, no underrun gaps > 20 ms.

### Roles per WP (workflow)
Each WP runs implementer → critic (design conformance + edge cases) → reviewer (`/code-review`
at high) → tester (runs the WP's acceptance, attaches evidence). Device steps (WP4/WP5/WP7/WP9)
claim phones through agistry and release them after each run.

---

## 8. Test & evidence plan

### 8.1 Automated tests
| Layer | Where | Runs in |
|---|---|---|
| JS unit (mocked `NativePhonon`) | `src/engines/phonon/__tests__`, `src/engines/__tests__`, `src/__tests__` | `yarn test` (CI `test`) |
| Example unit | `example/src/utils/__tests__` | `yarn example test` (CI `test`) |
| C++ core (fake ptts, ASan/UBSan) | `test/phonon-core` | `scripts/test-phonon-core.sh` (CI `test`) |
| Kotlin JVM | `android/src/test/.../phonon` | `testDebugUnitTest` via example gradlew (CI `test`) |
| iOS XCTest | `example/ios/SpeechExampleTests/PhononTests.m` (target 15.1) | `scripts/test-ios.sh`, CI `build-ios-phonon` |
| Binary verification | `scripts/phonon/verify-*.sh` | `phonon-binaries.yml`, `ci.yml` |
| Package contents | `npm pack --dry-run --json` check | CI `test` |
| Emulators (x86_64, 4 KB + 16 KB) | self-test deep link | CI `android-emulator-phonon` |
| Device matrix | `run-matrix.sh`, `collect-*-evidence.sh` | agents (WP9) |

### 8.2 Device matrix
Claim via agistry before use. iOS via the ios-lab router agent.

| Device | Serial | Expected | Runs |
|---|---|---|---|
| Pixel 9 (Tensor G4) | 45300DLAQ004DH | supported | flag-on S1–S13, U3, F1 |
| MediaTek MT6899 | 4LJRSCBARCQO4PMB | supported | flag-on S1–S13, U3, U2 attempt, F1 |
| Galaxy S23 (SM8550) | R3CWC02QBNX | supported | flag-on S1–S13, U3, U2 attempt, F1 |
| SD 8 Elite Gen5 (SM8850, Android 16) | df8fc5ef | supported | flag-on S1–S13, U3, F1 |
| OnePlus 6 (SD845) | ba5702bf | **unsupported** (no asimddp) | U1, U2 (`--abi armeabi-v7a`), F1; optional negative control N1; optional generic-build data point |
| CI emulator x86_64 API 35 (4 KB) | CI | supported (slow) | S1, S3, S6 |
| CI emulator x86_64 API 35 ps16k (16 KB) | CI | supported, `pageSize=16384` | S1, S3 |
| iPhone 13 Pro (A15) | ios-lab | supported iff iOS ≥ 18 | S1–S12 (no S13), S11b, soak, F1; else U-iOS and "ANE unverified on hardware" |
| iOS Simulator 18.x arm64 | CI / lab | supported (CPU Core ML; exempt from RTF/first-audio thresholds) | S1, S3, S6 |
| iOS Simulator x86_64 (Intel host, if any) | lab | `unsupported-abi`, launches | U-iOS-x86 (optional) |
| iOS Simulator 17.x | CI / lab, if installed | `os-too-old`, launches | U-iOS (non-blocking) |

Every device records `getconf PAGE_SIZE` (and `pageSize` from support) in `device.json`. All 5
local phones are expected to be 4 KB; 16 KB is covered by the CI emulator only (no bootloader
unlock on shared lab phones).

### 8.3 Scenarios
* **S1 Support:** `supported:true`, reason/abi/pageSize; Demo screenshot with the Phonon chip.
* **S2 Init:** `loadMs`, `compiled`, voices, languages, `defaultVoice`. iOS reports **cold**
  (first ever / fallback compile) and **warm** separately; plus kill-during-compile → relaunch
  recovers (fallback path only).
* **S3 Short speak ×5:** ttfa, total, queued, samples, RTF, first-audio (speak → native onStart);
  median/p90.
* **S4 Long speak:** 6 sentences; progress in order; gap between `playEndTs` and next
  `playStartTs` ≤ 150 ms after the first (from `PHONON_CHUNK` lines).
* **S5 Stream:** 30 tok/s simulated LLM, 400 chars, `firstChunk:'clause'` and `'sentence'`;
  first-audio, gaps, `finalize` resolves.
* **S6 Stop:** stop at t=1.0 s. Stop → `onStopped` ≤ 150 ms; synth-cancel latency from native
  log (bound per 1.4); **no `onStart` and no `phononPlayBuffer` after the stop timestamp**;
  `liveBuffers==0` after 1 s; next speak works.
* **S7 Voice switch:** 3 voices; record `voiceChanged`, switch cost
  (`ttfaMs` after switch − same voice), voice ids from `getLastMetrics`; RMS/centroid recorded
  without pass threshold.
* **S8 Init/release ×10:** memory (RSS / phys_footprint) and **thread count** before/after each;
  pass: final mem ≤ initial + 40 MB, threads flat after first init, `liveBuffers==0`, no crash.
* **S9 Pause/resume** mid chunk (`pause()` returns true).
* **S10 Audio capture** → WAV, non-silent, duration ±30 %; one `sample.wav` per platform.
* **S11 Interruptions:** background/foreground; RN reload during synthesis (no crash, invalidate
  returns immediately, next speak works, request ids keep increasing).
* **S11b (iOS):** reload during first-load compile (fallback path) or during load: no hang,
  next create succeeds.
* **S12 Peak memory** after S3–S5 (+ `dumpsys meminfo` on Android).
* **S13 (Android only) sweep:** threads {2,3,4,6} × spin {default,200}, fresh process each, S3 ×5
  plus idle CPU time between chunks → `threads.json`.
* **Soak (iOS):** 200 short utterances, `phys_footprint` slope ≤ 1 MB / 50.
* **U1 Unsupported CPU (OnePlus 6, flag on):** `missing-cpu-features` (detail lists asimddp);
  direct `Speech.initialize({engine:PHONON})` rejects `ERR_PHONON_UNSUPPORTED`; diagnostics
  `libraryLoaded:false`; **process proof**: `run-as speech.example cat /proc/<pid>/maps | grep -c
  libptts_ffi` = 0; Demo/Benchmark screenshots show no Phonon UI; no Alert; logcat clean;
  OS-native speak works.
* **U2 Unsupported ABI:** 32-bit install → `unsupported-abi`, same checks (Pixel 9/SM8850 have no
  32-bit userspace; record the install failure).
* **U3 Forced reasons (every supported phone, debug build):** `RNSpeech_phononForceReason` ∈
  {`low-memory`, `library-missing`, `symbols-missing`, `load-failed`}: hidden UI, no Alert, direct
  init rejects with the code, other engines work, logcat clean. iOS: same via the plist key.
* **N1 Negative control (optional, OnePlus 6, debug-only build that skips the HWCAP gate, never
  shipped):** expect SIGILL tombstone on create. Stored separately; proves the gate is what
  prevents the crash.
* **U-iOS:** `os-too-old` (iOS 17 sim, if available) / `unsupported-abi` (x86_64 sim): app
  launches, no Phonon UI.
* **F1 Flag-off** (every phone): `not-compiled`, no Phonon UI, no Phonon libs, three-metric size
  report vs merge-base, other engines work.

Pass thresholds (supported, physical devices): RTF median ≤ 0.35; S3 first-audio median ≤ 800 ms;
S6 stop → `onStopped` ≤ 150 ms; no gaps > 150 ms in S4/S5; S8 bounds; logcat clean. Simulators
and emulators are exempt from RTF/first-audio thresholds. Numbers are always recorded.

### 8.4 Logcat "clean"
Unchanged definition (pid-filtered logcat + crash buffer + `dumpsys dropbox --print
data_app_native_crash` with no new entries; zero matches for
`FATAL EXCEPTION|Fatal signal|SIGILL|SIGSEGV|SIGABRT|UnsatisfiedLinkError|tombstone|ANR in speech.example|E/RNSpeech|E/Phonon|E ReactNativeJS`).
`I/Phonon: unsupported: <reason>` and `[Phonon] hidden:` are info-level and expected in U*/F1.

### 8.5 Evidence layout
```
docs/phonon/evidence/
  README.md                 # device × scenario → PASS/FAIL/NOT-RUN + key numbers, date, commit, lib release, what is unverified
  ci/                       # workflow run links, SHA256SUMS, verify-*.txt, nm/otool outputs, emulator logs (4 KB/16 KB)
  build/
    apk-size.json           # {mergeBase, flagOff, flagOn}: native .so list+sizes, dex size, JS bundle size, file-size and download-size
    apk-contents-{flag-on,flag-off}.txt
    readelf-libptts_ffi-{arm64,x86_64}.txt
    ios-binary-size.json    # size -m flag-off vs flag-on, __LLVM count
  android/<device-slug>/<flag-on|flag-off|flag-on-32bit|forced-<reason>|negative-control>/
    device.json             # model, soc, release, abilist, cpuinfo Features, PAGE_SIZE, serial, commit, apk sha256
    bench.jsonl  metrics.json  threads.json  logcat.txt  logcat-check.txt  maps-check.txt
    meminfo-{before,after}.txt  screenshots/{demo,benchmark,streaming}.png  sample.wav (one device)
  ios/<iphone13pro|simulator-18|simulator-17|simulator-x86_64>/<flavor>/
    device.json  bench.jsonl  selftest.json  metrics.json  screenshots/*.png  log.txt  soak.json
```
`collect-android-evidence.sh <serial> <slug> <flavor>`: install, clear logcat, `device.json`,
launch deep link, wait for `SELFTEST_DONE` (10 min), screenshots at `SCREENSHOT_READY` markers,
maps check, meminfo, logcat check, also `adb pull` of `phonon-evidence/` via `run-as`.

### 8.6 iOS lab hand-off (sent to the ios-lab router before WP5)
Checklist to answer: iPhone 13 Pro iOS version; Xcode version(s) and installed simulator
runtimes (`xcrun simctl list runtimes`); Intel or Apple-silicon Mac; signing team `MYXGXY23Y6`
and bundle id `com.pocketpalai.rn.speech` usable; device internet access for the model download;
can it run `xcrun devicectl device process launch --terminate-existing --payload-url
'speechexample://selftest/phonon?runs=5' <device> com.pocketpalai.rn.speech` and
`xcrun devicectl device copy from --device <id> --domain-type appDataContainer --domain-identifier
com.pocketpalai.rn.speech --source Documents/phonon-evidence --destination <dir>`.
Hand-off package: git ref (pushed branch), `RN_SPEECH_PHONON_XCFRAMEWORK` path or the release
asset once WP2 publishes, and `scripts/phonon/collect-ios-evidence.sh` which the lab agent runs
verbatim (build, install, launch, wait, copy files, `log collect --last 15m` filtered to the app
subsystem). Expected outputs: the `ios/` evidence tree above, returned as a tarball.

---

## 9. Risks & open questions

| # | Risk | Recommendation |
|---|---|---|
| R1 | No speed control in the v0.4.0 FFI. | Ignore + warn; upstream request for `ptts_set_condition`; source-build path in CI if needed. |
| R2 | iPhone 13 Pro iOS version unknown. | Lab checklist first. If < 18: no hardware evidence for iOS ANE; README says so explicitly. No upgrade without owner OK (D2). |
| R3 | iOS link safety on < 18 (was: weak linking). | Resolved by analysis (no `_OBJC_CLASS_$` refs, iOS 15-safe C symbols). Kept as CI assertions (`nm -u`, minos). |
| R4 | Spike `.so` from `6f42148`, unstripped. | CI rebuild from tag; spike numbers indicative only. |
| R5 | Consumer build fetches from GitHub. | Cache + sha; local overrides; clear error text; immutable `-rN`. |
| R6 | Rust stack depth on platform threads. | 8 MB dedicated threads. |
| R7 | Rayon **and xn** pools fixed at first init; xn workers spin and never exit. | Document; S8 thread count; S13 spin sweep; watchdog for worker panics. |
| R8 | Memory on low-RAM devices. | 3 GiB floor; release previous engine; S8. |
| R9 | Core ML compile time/disk. | CI precompile + per-file mirror; fallback compile with crash-safe recovery and persisted `load-failed`. |
| R10 | (resolved) First-clause flush (#26) merged in 2.6.0; branch fast-forwarded. | Phonon supports `firstChunk`. |
| R11 | Upstream 0.x API churn. | Pin commit, vendor `ptts.h`, symbol table check, lock-file PRs. |
| R12 | x86_64 in consumer APKs. | Default arm64-v8a only. |
| R13 | `.init_array` of `libptts_ffi` on unsupported CPUs. | Moot: dlopen only after the HWCAP gate and only on create. |
| R14 | Long inputs. | ≤ 250-char chunks. |
| R15 | Model licensing. | 31m default; 40m CC BY-NC opt-in; library never downloads. |
| R16 | ANE vs CPU default. | `neuralEngine` default; WP9 records both if the iPhone is supported. |
| R17 | (resolved) iOS zip dependency. | Per-file download with sha manifest; no zip lib. |
| R18 | QNN bundle upstream. | Out of scope. |
| R19 | Pause with prefetch. | Bounded by the buffer store. |
| R20 | Always-bundled JS (engine TS) and codegen methods when flag off. | Accepted; measured separately (JS ~40 KB budget, dex ≤ 8 KB, native identical). |
| R21 | Upstream abort paths outside `catch_unwind` (Core ML completion handler `.expect` in run.rs; xn worker panics). | Precompiled bundle avoids the on-device compile path; watchdog; file upstream issues. |
| R22 | Untested iOS 18 SoCs (A12/A13) may fail at load. | Persisted `load-failed` hides the engine after one failure; optional allowlist (D4). |
| R23 | Translated ARM on x86 Android (ChromeOS/WSA/Waydroid). | Reported `translated-abi`, hidden. |
| R24 | Consumers on AGP < 8.5.1 with 16 KB kernels. | dlopen/loadLibrary failure → `library-missing`, hidden; doc requires AGP ≥ 8.5.1. |

### Decisions needing the owner
* **D1:** HF repo (org/name) to host the precompiled iOS Core ML bundle mirror.
* **D2:** If the lab iPhone is on iOS < 18, may it be upgraded? Otherwise iOS hardware support
  ships "verified on simulator only".
* **D3:** Accept ~40 KB of always-bundled JS for flag-off consumers, or invest in a separate
  `@pocketpalai/react-native-speech/phonon` entry point (lazy require).
* **D4:** Enable a conservative iOS hw.machine allowlist (A14+) by default, or rely on the
  persisted load-failure record only (recommended).
* **D5:** OK to run CI emulator jobs (KVM, ~10–15 min per PR) and to publish
  `phonon-bin-*` releases (non-latest) on the main repo.
* **D6:** OK to run the one-off N1 SIGILL negative control on the shared OnePlus 6.

---

## Appendix A. Addressed critiques

android-build lens:
1. Cancel single atomic / JS ids reset — **accepted**: native process-wide ids, `fetch_max` watermark, checks before speak and on dequeue, latency bound restated (1.4, WP3 tests).
2. Stale base 2.5.2 — **accepted**: fast-forwarded to `bdbeb2c`; R10 resolved; baseline = merge-base.
3. ≤ 8 KB mixes JS growth — **accepted**: three metrics (native identical, dex ≤ 8 KB, JS ~40 KB budget).
4. No x86_64 emulator / 16 KB device — **accepted** (verified: no emulator/system-images on host): CI emulator jobs incl. ps16k; PAGE_SIZE in device.json; AGP ≥ 8.5.1 documented.
5. xn spinning pool omitted — **accepted** (verified in xn-0.2.11 threadpool.rs, `XN_SPIN_BUDGET` default 5000): documented, S8 thread count, S13 spin sweep, JS watchdog.
6. voiceMs ≈ 0 on Android — **accepted** (verified cpu.rs `set_voice` stores name): replaced by `voiceChanged` + S7 ttfa delta.
7. Hard-coded HWCAP gate — **accepted**: mask generated from features, disasm extension scan, `<asm/hwcap.h>` macros.
8. Shim needs libc++_shared — **accepted** (verified `ANDROID_STL=c++_shared` project-wide): NEEDED set fixed.
9. Spike .so unstripped — **accepted**: no .symtab/.debug, size budgets, CI-only sizes.
10. ABI detection too complex — **accepted**: shim only for 64-bit ABIs, compile-time ABI query.
11. phononCancel "sync" void — **accepted**: value-returning sync methods.
12. No Kotlin test infra — **accepted** (verified: no android/src/test, no gradlew, no junit): junit, returnDefaultValues, pure functions, script fix, CI.
13. Turbo inputs — **accepted** (verified turbo.json): inputs/env extended; phonon job uncached.
14. npm would ship C++ tests / lock — **accepted**: tests moved to `test/phonon-core/`; lock in files; `npm pack` check.
15. Gradle 9 / config cache — **accepted**: abstract task, `layout.buildDirectory`, `addGeneratedSourceDirectory`, `getExtOrDefault`, `--configuration-cache`; Expo note.
16. Trampoline / invalidate semantics — **accepted**: noexcept trampoline, process-wide `object`, invalidate = cancelAll only.
17. OnePlus evidence self-reported — **accepted**: `/proc/<pid>/maps` check; optional N1 negative control (D6).
18. Translated ARM — **accepted**: `translated-abi` reason.
19. APK size understated / Latest release — **accepted**: ~7.6 MB on device; file+download size; `make_latest=false`.
20. Always PTTS_UNIT_CPU — **accepted** (verified cpu.rs rejects others): hard-coded + test.

ios-coreml lens:
21. Podspec globs compile tests / duplicate ptts.h — **accepted** (verified podspec `cpp/**/*.{h,cpp}`): tests out of `cpp/`, excludes in both branches, headerless xcframework, CI checks.
22. XCTest target 26.0 vs Xcode 16.2 — **accepted** (verified pbxproj 26.0, ci.yml macos-14/16.2): target lowered to 15.1, runtime check, iOS 17 smoke non-blocking.
23. Core ML compile unaccounted / not crash-safe — **accepted**: CI precompile, `phononNeedsCompile`, delete-and-retry, cold/warm S2.
24. iOS disk numbers / zip dependency — **accepted**: table corrected; per-file manifest download; no zip lib; inner folder documented.
25. Autorelease on custom thread — **accepted**: pthread worker with per-job and per-16-frame pools; soak test.
26. iOS gating OS-only — **accepted**: persisted `load-failed` record; allowlist as D4; A15-only verification stated.
27. xcframework/tests published and committed — **accepted**: .gitignore, files exclusions, `npm pack` check, override for read-only stores.
28. Lab plan not actionable — **accepted**: §8.6 checklist, file-based evidence, collect-ios-evidence.sh.
29. Cancel can't interrupt compile; invalidate must not block — **accepted**: enqueue-and-return everywhere, `busy` diagnostics, S11b.
30. R3 already answered — **accepted** (taken from critic's nm analysis; re-asserted in CI): no weak-link, no Accelerate, prelink minos 15.1.
31. 324 unmangled symbols — **accepted**: `ld -r` prelink exporting 8 symbols; `-all_load` link test.
32. x86_64 simulator / EXCLUDED_ARCHS leak — **accepted**: stub x86_64 slice, no user_target_xcconfig.
33. iOS thread policy over-engineering — **accepted**: dropped; numThreads=0.
34. computeUnit enum mismatch — **accepted**: single `'neuralEngine'|'cpu'`, effective unit + isSimulator reported, sim exempt.
35. Callback noexcept / upstream abort path — **accepted**: noexcept trampoline, pre-reserve, R21.
36. Example flag-on before release / turbo — **accepted**: placeholder fallback, flag-on only with real hashes, existing jobs pinned off.
37. Bitcode — **accepted**: `bitcode_strip`, `__LLVM` assertion, size deltas.
38. phys_footprint — **accepted**: `memKb/peakMemKb` = phys_footprint on iOS.
39. Stale base (dup of 2) — **accepted**.

js-api-ux lens:
40. Overwritable cancel slot (dup of 1) — **accepted**: same fix, plus reset-across-reload test.
41. NeuralAudioPlayer stop/pause no-ops — **accepted** (verified `isCurrentlyPlaying` gating in NeuralAudioPlayer.ts): `playBuffer` sets the flag; jest tests.
42. Stream cancel / re-entry don't cancel native — **accepted** (verified EngineStreamSession.cancel only calls stopPlayback; Supertonic doesn't await): `onCancel` hook; stop + await on re-entry.
43. Leaked buffers / eviction of live buffer — **accepted**: discard on the promise, generation check, orphan-only eviction, `BUFFER_LIMIT`, idempotent release.
44. Stale base, SelfTestPanel — **accepted**: firstChunk support; self-test extends SelfTestPanel convention.
45. currentEngine set before init — **accepted** (verified Speech.ts:138): assigned after success for all engines; no Alert for Phonon.
46. Example test infra missing — **partially accepted**: `example/jest.config.js` does exist (RN preset), but there is no `test` script and no tests; RootView is untestable as-is → pure `visibleEngines`/`useEngineSupport` + `"test"` script.
47. Only 2 of 9 reasons proven — **accepted**: debug-only force-reason override, U3 on every supported phone, direct-init assertions, jest per reason.
48. ReadBuffer semantics / onAudioChunk timing — **accepted**: `phononCopyBuffer` non-consuming; onAudioChunk in postProcess.
49. Cancel not sync on Android (dup of 11) — **accepted**.
50. getEngineSupport robustness — **accepted**: method guard, cache only success, never throws.
51. Voice defaults — **accepted**: `''` → upstream default, `defaultVoice` reported, `voices=[]` allowed, re-init after downloads.
52. Probe dlopens on UI mount — **accepted**: dlopen moved to create; failures persisted.
53. Unmeasurable metrics — **accepted**: per-chunk `PHONON_CHUNK` [BENCH] lines; S6 assertions; S7 record-only.
54. Jest seam / deferreds — **accepted**: `NativePhonon.ts` seam, listed race cases.
55. Nits — **accepted**: `TTSEngine.PHONON`, handle dedupe dropped, unified compute unit, explicit "unverified" wording.

## Appendix B. Owner decisions (2026-10-20)

- **D1 iOS model hosting:** precompiled Core ML bundle is hosted on the palshub Hugging Face org (e.g. `palshub/phonon-31m-en-coreml`), Apache-2.0 with Gradium attribution.
- **D2 iPhone OS:** the lab iPhone 13 Pro runs iOS 26.7.1, so it is a *supported* iOS device. The ios-lab router confirmed availability is hours-scale and building this repo needs its operator's OK; the orchestrator sends the request (§8.6).
- **D3 JS bundle:** accept the ~40 KB always-bundled engine JS (no subpath entry).
- **D4 iOS allowlist:** no A14+ allowlist; rely on the persisted load-failure record only.
- **D5 CI:** add the emulator jobs and the `phonon-bin-*` release workflow (never marked Latest). The orchestrator asks the owner before the first real publish or push.
- **D6 N1:** the one-off SIGILL negative-control test on the OnePlus 6 is approved.

## Appendix C. Branch review changes (2026-10-21)

Decisions taken while fixing the branch review; where they differ from the sections above,
this appendix wins.

- **Load-failed record (2.4).** Both platforms store the failing model's folder (`modelPath`) in
  the record. The probe re-stamps that folder on every `getSupport`, so a re-downloaded or
  replaced model re-enables the engine without a create (Android no longer caches a
  `load-failed` probe; JS never caches `reason: 'load-failed'`). A model in a *different*
  folder does not clear the record by itself: `Speech.resetEngineSupport` does.
- **`Speech.resetEngineSupport` (2.4)** is implemented as `phononResetSupport(): Promise<boolean>`
  (Android `PhononBridge.resetSupport`, stub resolves `true`; iOS `+clearCapabilityRecord`).
  Other engines resolve `true` without native work.
- **Broken state under RN reload (1.5).** Instead of a native broken flag, `phononCreate` also
  runs under the JS watchdog (120 s; 600 s when `needsCompile`). A create queued behind a hung
  worker after a reload therefore rejects `ERR_PHONON_TIMEOUT` and marks the engine broken; a
  handle that arrives late is destroyed. Once broken, `release()`/`destroy()` fire the native
  destroy without waiting for it (it is queued behind the hung job and never settles).
- **Lifecycle serialization (1.6).** `initialize()` and `destroy()` run one at a time in call
  order. A concurrent `initialize()` now waits for the running one instead of rejecting
  "already loading"; `release()` still refuses while an initialize is queued or running.
- **Per-module promise dropping (1.5).** Android uses one `AtomicBoolean` token per
  `RNSpeechModule` (as iOS uses `_alive`): invalidating one module drops only its pending
  promises. `cancelAll()` stays process-wide.
- **`spinBudget` (1.5, 1.7)** is plumbed: `PhononLoadOptions.spinBudget?` (Android only, iOS
  ignores it), `config.spinBudget ?? 0` from `initialize()`. WP9's spin sweep can use it.
- **HWCAP gate fails closed (2.1 step 8).** A null requirement list from the shim, or an empty
  one on arm64 when the build has ARM64_FEATURES, reports `reason: 'error'`.
- **Shim ABIs (3.2).** `librnspeech_phonon.so` is built only for ABIs in `RNSpeech_phononAbis`
  (`-DRN_SPEECH_PHONON_ABIS` from `phonon.gradle`), not for every 64-bit app ABI.
- **Flag-off cost (3.2, R20, A.3).** The native libs are *not* identical to the baseline: the
  always-declared `phonon*` methods add TurboModule codegen glue to `libappmodules.so`
  (+6.6 KB measured locally). `apk-size-report.sh` gates it as a separate `codegen` budget of
  8 KB; every other native lib must stay identical. Local dex delta: +3.4 KB (budget 8 KB).
- **Android playback settles on stop.** A stopped or replaced AudioTrack now resolves its play
  promise (as iOS's player-node completion does), so `playEndTs` / `[BENCH] PHONON_CHUNK` are
  recorded for stopped chunks on both platforms.
- **Lock PR token (4.1).** `create-pull-request` uses the `PHONON_LOCK_PR_TOKEN` secret when set;
  otherwise CI must be triggered by hand on the lock PR (stated in the PR body and
  `scripts/phonon/README.md`).

## Appendix D. WP9 device harness (2026-10-21)

Found while building `collect-android-evidence.sh` and running it once on the SM8850; where they
differ from §8, this appendix wins.

- **U1 process proof (§8.3).** Uncompressed libraries (`extractNativeLibs=false`, §3.2) are
  mmapped from `base.apk`, so `/proc/<pid>/maps | grep -c libptts_ffi` is 0 even with the library
  loaded (measured: 0 on an initialized SM8850 run). The proof counts `base.apk` mappings whose
  file offset lies inside `lib/<abi>/libptts_ffi.so`'s stored range in the APK, plus named
  mappings; a supported, initialized run must see the library, otherwise the check is reported
  blind (FAIL).
- **Release builds have no `run-as`.** The self-test saves its own `/proc/self/maps` lines
  (`maps.txt`), copies `phonon-evidence/<runId>/` to the app's external files dir for `adb pull`,
  and installs a lab-pushed model with `modelFrom=<dir>`
  (`PhononModelManager.installFromDirectory`: the download's per-file size/sha256 checks,
  catalog, marker and atomic swap, no network). `download=1` stays the default path.
- **S11** is an opt-in self-test scenario (`scenarios=s11`): background/foreground is driven by
  the host on `S11_BACKGROUND_REQUEST`; the RN reload uses `DevSettings.reload()` (debug builds
  only; release records `S11_reload` as not run) and the next JS context finishes the run from a
  marker file (`resumePhononSelfTestAfterReload`), checking re-create, next speak and increasing
  request ids (`lastIssuedId`).
- **S13** is host-driven (a fresh process per threads x spin point); the self-test adds the
  process CPU over the S3 runs and over a 2 s idle window after them (`/proc/self/stat`) for the
  spin comparison.
- **N1** uses `RNSpeech_phononSkipHwcapGate=true` (debug BuildConfig only, release always
  `false`, default off): the probe reports `ok` without the HWCAP check; every other check runs.
