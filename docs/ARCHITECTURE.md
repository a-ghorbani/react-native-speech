# Architecture

Concise notes for integrators and maintainers. For API usage, see [USAGE.md](USAGE.md).

## Engines

The library exposes five TTS engines behind a unified `Speech` façade:

| Engine | Kind | Sample rate | Sessions | Notes |
|--------|------|-------------|----------|-------|
| `OS_NATIVE` | Platform TTS (AVSpeechSynthesizer / Android TTS) | device-default | — | always available |
| `KOKORO` | Neural, ONNX | 24 kHz | 1 | multi-language via dict; BPE tokenizer |
| `SUPERTONIC` | Neural, ONNX (4 models) | 44.1 kHz | 4 | ultra-fast; byte tokens |
| `KITTEN` | Neural, ONNX | 24 kHz | 1 | StyleTTS 2; IPA tokens |
| `PHONON` | Neural, native (Rust `libptts_ffi`: CPU on Android, Core ML on iOS) | 24 kHz | — | opt-in at build time; see [PHONON_GUIDE.md](PHONON_GUIDE.md) |

All neural engines implement `TTSEngineInterface<TConfig>`. Config is per-engine (`KokoroConfig`, `SupertonicConfig`, `KittenConfig`, `PhononConfig`).

### Phonon (native engine)

Phonon does not use ONNX. `PhononEngine` (JS) chunks text and drives a native pipeline through TurboModule methods; all native access goes through `src/engines/phonon/NativePhonon.ts`.

- **PCM stays native.** Native synthesizes each chunk into a buffer store and returns a `bufferId`; JS plays it with `phononPlayBuffer` (the same native neural player as the ONNX engines). PCM crosses into JS only when `onAudioChunk` asks for it.
- **Request ids and cancel.** Ids come from one process-wide native counter. Cancel is a monotonic watermark (`phononCancel(upTo)`, synchronous), checked before conditioning, before synthesis and in every frame callback. A result from an older JS generation is released, never played.
- **Threads.** Android: one 8 MB-stack synth thread in a process-wide Kotlin `object`; `RAYON_NUM_THREADS` sizes rayon and xn's spinning pool once per process. iOS: a shared C++ pthread worker (8 MB stack) with an autorelease pool per job.
- **Lifetime.** Native state is a process-wide singleton that survives RN reloads; module invalidation only cancels.
- **Loading.** Android probes cheaply (ABI, translation, `AT_HWCAP`, memory, JNI shim) and `dlopen`s `libptts_ffi.so` lazily in `phononCreate`, only after the HWCAP gate. iOS links a prelinked static `PhononCore.xcframework`.
- **Watchdog.** Every native synthesis races `max(10 s, 4 × expected)`; a timeout marks the engine broken for the process.

Shared C++ lives in `cpp/phonon/` (function table, request/cancel state, buffer store, error mapping, iOS worker); its host tests live in `test/phonon-core/`. The full design is [phonon/DESIGN.md](phonon/DESIGN.md).

## Threading model

- **JS bridge:** `Speech.*` entry points are `async` and return Promises. Engine instances and the audio player live in JS.
- **ONNX inference:** `session.run(feeds)` is awaited on the JS thread. `onnxruntime-react-native` dispatches the actual math to a native thread; tensor marshaling on return happens on the JS thread. For streaming use-cases, avoid chunking finer than ~100 ms on low-end Android, where marshaling dominates.
- **Audio playback:** handled in native code. iOS uses `AVAudioEngine` + `AVAudioPlayerNode`; Android uses the neural audio player in `RNSpeechModule`. Audio callbacks (`onStart`, `onProgress`, etc.) cross back into JS via the Turbo Module event emitter.
- **Audio focus / interruption:** subscribed in native code on both platforms. An `onAudioInterruption` JS event surfaces focus transitions so the app can react (for example, update UI state).
- **Native dict (`cpp/native_dict.*`):** mmap-backed, `MAP_PRIVATE | PROT_READ`. Lookups run on whichever thread called the Turbo Module — typically JS. Single-instance global per platform; swapping dicts replaces the singleton atomically under a mutex.

## Lifecycle

```
initialize(config) → isReady() → synthesize(...) → [release() | destroy()]
```

- `initialize()` loads model files, builds tokenizer, attaches phonemizer, and opens ONNX sessions. Cold-start is logged as `engine_init_ms=...` at info level. Re-init is idempotent: if already initialized, the call is a no-op.
- `release()` releases ONNX sessions (and any native buffers) but keeps the engine instance reusable — call `initialize()` again to reuse.
- `destroy()` tears down the engine permanently.

## Memory

Neural TTS is memory-heavy. Rough steady-state per engine (excluding OS TTS):

| Engine | Typical RSS during synthesis |
|--------|------------------------------|
| Kokoro | 150–250 MB |
| Supertonic | 150–250 MB (4 models, but small) |
| Kitten | 80–150 MB |
| Phonon | to be measured on the device matrix (upstream reports ~95 MB while speaking on iOS) |

Minimum device recommendation: 3 GB RAM phone. On 2 GB devices (iPhone SE) one neural engine at a time and prompt `release()` between usages are mandatory.

`release()` frees the ONNX session's native memory via `session.release()`. Actual RSS drop depends on `onnxruntime-react-native`'s implementation; verify on device with Xcode Instruments (Allocations template) or Android Profiler if tuning.

## Phonemization

Default stack (Kokoro + Kitten):

```
text → TextNormalizer → chunker → (dict lookup → hans00 G2P fallback) → post-process → tokens
```

- No data is shipped in the library. Consumer apps supply the mmap `.bin` dict path via `NativeDict` API.
- Without a dict, the hans00 G2P library (MIT) is the sole backend. Quality is lower for English proper nouns but adequate for common words.
- Supertonic bypasses phonemization — it uses a byte-level tokenizer directly.

See [PHONEMIZATION.md](PHONEMIZATION.md) for details and the `scripts/build-dict.mjs` tool.

## Native dict parser security

The EPD1 binary parser (`cpp/native_dict.cpp`) treats input as **untrusted** — consumer apps may load dicts downloaded from the network. The parser:

- Uses overflow-safe bounds checks on all header fields.
- Runs a one-time post-open validation pass (monotonic offsets, size bounds, alignment-agnostic reads via `memcpy`).
- Caps `n_entries_` at 10M.

A fuzz target lives at `cpp/tests/fuzz_native_dict.cpp` covering truncated, oversize, wrong-magic, and adversarial blobs. Run locally with `g++ -std=c++17 -I cpp/ cpp/native_dict.cpp cpp/tests/fuzz_native_dict.cpp -o /tmp/fuzz && /tmp/fuzz`.

## Benchmarks

`scripts/benchmark-*.sh` + `benchmarks/schema.json` + `example/src/views/BenchmarkView.tsx` produce reproducible traces. xctrace + Perfetto are wired into the trace extractor at `scripts/extract-trace-table.py`. See engine-specific notes in the memory/profiling docs (internal).

Cold-start can be read out of the runtime log (`[Kokoro][Engine] engine_init_ms=...`) or the xctrace `engine_init` signpost.
