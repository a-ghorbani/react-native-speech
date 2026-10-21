# Changelog

## Unreleased

### Added

- **Phonon engine (`TTSEngine.PHONON`, opt-in).** Gradium's Phonon
  (`gradium-ai/xn-ptts` v0.4.0) as a native neural engine: CPU on
  Android (arm64 with dotprod/fp16, or x86_64), Core ML on iOS 18+.
  Enable it with `RNSpeech_phononEnabled=true` (Android, AGP ≥ 8.5.1)
  and `ENV['RN_SPEECH_PHONON'] = '1'` (iOS Podfile); the build fetches
  sha256-pinned binaries from `phonon.lock.json`, with local overrides
  (`RNSpeech_phononLibDir`, `RN_SPEECH_PHONON_XCFRAMEWORK`). Flag off,
  apps get no Phonon binary or native code; the engine reports
  `not-compiled`. Flag on adds ~7.6 MB installed per Android ABI. The
  library downloads no models; Phonon 31m and the voices are
  Apache-2.0, Phonon 40m is **CC BY-NC 4.0** (non-commercial). No
  speed or pitch control (ignored with a warning). See
  [docs/PHONON_GUIDE.md](docs/PHONON_GUIDE.md).
- **`Speech.getEngineSupport(engine)`**: never throws; reports whether an
  engine can run on this build and device, with a reason (for Phonon:
  `not-compiled`, `missing-cpu-features`, `os-too-old`, `low-memory`,
  ...). Unsupported devices are detected without loading the Phonon
  library, and load failures are remembered per device so the engine
  stays hidden.
- `PhononError` / `PhononUnsupportedError` with stable `ERR_PHONON_*`
  codes, and the Phonon types (`PhononConfig`, `PhononVoice`,
  `PhononSupportInfo`, ...).

### Fixed

- **A rejected `Speech.initialize()` no longer switches the current
  engine.** The previous engine stays current when the new one fails to
  initialize (all engines).
- **CamelCase / PascalCase tokens are split before phonemization.**
  `PrismML` → `Prism ML`, `XMLParser` → `XML Parser`, `iOS` → `i OS`.
  Conservative two-rule splitter — `iPhone`, `McDonald`, `JavaScript`,
  `MacBook` etc. are intentionally left alone. Affects both Kokoro
  (`TextNormalizer`) and Kitten (`TextPreprocessor`).
- **Lowercased acronyms no longer leak as literal letters.** When the
  G2P fallback echoes its input (e.g. `ml` → `ml`) or returns
  ASCII-only noise (`xlm` → `ksm`), the phonemizer now spells the
  token out via dict letter lookups (`ml` → `ɛm ɛl`) — preventing
  silence-between-letters in the audio model.
- **Hermes debug bytecode failure on `phonemize` is now non-fatal.**
  When the 4.3MB en-g2p bundle exceeds Hermes' on-the-fly bytecode
  encoder (debug builds), `getHans00` warns once and falls back to
  dict-only letter spellout for short OOV tokens, instead of crashing
  synthesis. Release builds are unaffected.
- **Android 16 KB page-size alignment** for the library's `native_dict.so`
  via `target_link_options(... -Wl,-z,max-page-size=16384)`. Required
  for the library to load on Android 15+ devices that use 16 KB pages.
  AGP 8.12+ injects this for app modules but not library modules, so it
  has to be set explicitly here. See README "Known limitations" for the
  matching `onnxruntime-react-native` patch consumers need to apply.

### Behavior change to flag

The splitter changes audio for any input containing camelCase /
PascalCase. If you depended on the previous pronunciation, opt out
per-engine:

- **Kitten:** construct the engine with a custom preprocessor:
  `new TextPreprocessor({splitCamelCase: false})` (this requires
  customizing the engine wiring; see `KittenEngine.ts`).
- **Kokoro:** the splitter is hardcoded into `TextNormalizer.normalize`
  step 10 — currently no runtime opt-out. File an issue if you need one.

## 2.0.0 — 2026-04-14

First release under `@pocketpalai/react-native-speech`. Transitions the
library from an OS-native TTS wrapper to a multi-engine on-device neural
TTS platform. Breaking vs. the `@mhpdev/react-native-speech@1.x` line.

### Breaking

- **Package renamed** to `@pocketpalai/react-native-speech`. Android
  package: `com.mhpdev.speech` → `com.pocketpalai.speech`. JNI symbols,
  iOS bundle id, and `os_log` subsystem moved in lockstep.
- **`TTSEngineInterface` is now generic** (`TTSEngineInterface<TConfig>`).
  Each engine implements with its concrete config type. `initialize`
  signature changed from `config?: any` to `config?: TConfig`.
- **`Speech.initialize(config)`** takes a discriminated union
  `SpeechInitConfig` keyed on `engine`. `[key: string]: any` escape
  hatch removed.
- **Pocket engine removed.** Apps using `engine: 'pocket'` must migrate
  to another engine.
- **`src/NeuralAudioPlayer.ts` renamed** to `src/NativeAudioPlayer.ts`
  (Turbo Module shim). The orchestrator at
  `src/engines/NeuralAudioPlayer.ts` kept its name.
- **`src/types/react-native-fs.d.ts` removed.** Consumers that imported
  our parallel types should import from `@dr.pogodin/react-native-fs`
  directly.
- **Per-engine class exports tagged `@internal`.** `KokoroEngine`,
  `SupertonicEngine`, `KittenEngine`, `OSEngine` remain exported but
  their shape is no longer covered by the same semver guarantees as
  the default `Speech` API.

### Added

- **Neural TTS engines**: Kokoro, Supertonic, Kitten. All run on
  `onnxruntime-react-native` (optional peer dep). On-device synthesis,
  no network I/O.
- **Phonemization stack** — dict+hans00 G2P pipeline. Library ships no
  data; consumer apps supply mmap EPD1 dicts via the `NativeDict` API.
  Default phonemizer is `phonemize` (MIT, hans00 G2P) requiring no dict.
- **Native dict Turbo Module** — `cpp/native_dict.cpp` mmap-backed
  parser hardened against untrusted input (overflow-safe bounds,
  post-open validation pass, `madvise(MADV_RANDOM)`, fuzz harness at
  `cpp/tests/fuzz_native_dict.cpp`).
- **`onAudioInterruption` JS event** — surfaces iOS
  `AVAudioSessionInterruptionNotification` and Android
  `AudioFocusManager` transitions to JS. Pauses OS TTS and the neural
  audio player on focus loss.
- **Chunked progress tracking** — `ChunkProgressEvent` for per-sentence
  progress on neural engines.
- **Benchmark infra** — `scripts/benchmark-*.sh`, `benchmarks/schema.json`,
  `benchmark-compare.py`, `extract-trace-table.py`. Native tracing via
  `os_signpost` (iOS) and `android.os.Trace`.
- **Cold-start instrumentation** — each neural engine logs
  `engine_init_ms=<n>` on init success.
- **`docs/ARCHITECTURE.md`**, **`docs/LICENSES.md`**, **`MIGRATION.md`**,
  expanded `docs/USAGE.md` with per-engine quickstarts.
- **Hermes-safe UTF-8 decoder** (`src/utils/utf8.ts`) replaces
  `TextDecoder` which is unavailable on Hermes.

### Fixed

- `VoiceLoader.ts` no longer crashes on Hermes (TextDecoder → manual
  UTF-8 decode, 8 unit tests).
- Native dict parser bounds checks are overflow-safe
  (`off > size || len > size - off`), post-open validation rejects
  malformed dicts, `memcpy` avoids alignment hazards.
- Android `AudioFocusManager` reacts to focus loss (pause, not just a
  boolean flip).
- iOS sets a default `AVAudioSessionCategoryPlayback` at init so
  interruption notifications fire reliably.
- Kitten `ESPEAK_LANGUAGE` constant renamed to `PHONEMIZER_LANGUAGE`;
  espeak-ng is no longer a dependency.

### Removed

- `third-party/phonemizer-dicts/` (TSV espeak-ng-derived, GPL risk in
  MIT repo; `.bin` lives in `huggingface.co/datasets/palshub`).
- Pocket engine (`src/engines/pocket/`, `src/types/Pocket.ts`, example
  `PocketModelManager.ts`).
- Dead `src/engines/kokoro/utils/AssetLoader.ts`.
- `package-lock.json` (yarn repo), `benchmark-trace-table.csv`, and
  three transient planning docs (`KOKORO_REFACTORING_PLAN.md`,
  `SUPERTONIC_REFACTORING_PLAN.md`, `MLX_KOKORO_IMPLEMENTATION.md`).

### Internal

- Test coverage expanded from 6 suites / 255 tests to 9 suites / 294
  tests. Kitten, Supertonic, and Kokoro BPE now have unit tests.
- 65 `console.*` calls migrated to `createComponentLogger` with levels
  (`debug` gated behind `__DEV__`).
- Zero `any` in `src/` (was 28).
