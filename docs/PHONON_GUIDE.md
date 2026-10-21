# Phonon engine guide

`TTSEngine.PHONON` runs [Gradium's Phonon](https://github.com/gradium-ai/xn-ptts) (`xn-ptts`
`v0.4.0`) on the device. Unlike the ONNX engines it is entirely native: a Rust library on the
CPU on Android, Core ML on iOS. It needs no `onnxruntime-react-native`.

The native part is **opt-in at build time**. An app that does not enable it gets no Phonon
binary, no model data and no Phonon native code; the engine then reports `not-compiled` and
cannot be initialized.

For API basics shared by every engine (events, `stop`, `pause`, streaming) see
[USAGE.md](USAGE.md). For the design rationale see [phonon/DESIGN.md](phonon/DESIGN.md).

## At a glance

| | Android | iOS |
|---|---|---|
| Runtime | `libptts_ffi.so` on the CPU (arm64 with dotprod, or x86_64) | Core ML (Neural Engine by default, or CPU) |
| Minimum OS | the library's own minimum | **iOS 18** at runtime (the library still deploys to 15.1; older iOS reports `os-too-old`) |
| Enable | `RNSpeech_phononEnabled=true` | `ENV['RN_SPEECH_PHONON'] = '1'` in the Podfile |
| App size when enabled | ~7.6 MB installed per ABI (~2.5 MB Play download) | the static library is measured per release in CI |
| App size when disabled | zero native binaries; budgets (not yet measured): dex delta ≤ 8 KB, ~40 KB of always-bundled JS | zero binaries, no Phonon sources compiled |
| Model (Phonon 31m) | checkpoint folder, ~66 MB plus voices | precompiled Core ML bundle, ~170 MB |
| Sample rate | 24 kHz | 24 kHz |
| Speed / pitch | not supported | not supported |

## Requirements and supported devices

Phonon is only offered where it can run. `Speech.getEngineSupport(TTSEngine.PHONON)` performs
cheap checks (no model load and, on Android, no load of the Phonon library itself), and the
engine refuses to initialize anywhere it says `supported: false`. An unsupported device never
crashes and never shows a dialog; hide the engine instead.

**Android**

* A 64-bit process: `arm64-v8a` (default) or `x86_64` (opt-in, mainly for emulators).
* On arm64, the CPU must have the **dotprod** (`asimddp`) and **fp16** (`fphp`, `asimdhp`)
  extensions. In practice that means Armv8.2-A big cores with dotprod: Cortex-A76 / Kryo 4xx
  and later (roughly Snapdragon 855, Tensor, Dimensity 1000 and newer). Older SoCs such as the
  Snapdragon 845 (Cortex-A75, no dotprod) report `missing-cpu-features`. The check reads
  `AT_HWCAP` before the library is loaded, so the library's code never runs on a CPU without
  those instructions.
* At least 3 GiB of RAM (`low-memory` below that).
* No ARM-on-x86 translation (ChromeOS, Waydroid, Windows Subsystem for Android report
  `translated-abi`).
* **Android Gradle Plugin ≥ 8.5.1** in the consuming app. Both Phonon libraries are linked for
  16 KB pages, but older AGP versions do not keep uncompressed libraries 16 KB-aligned in the
  APK; on a 16 KB-page device such an app reports `library-missing` (no crash).
* 32-bit-only devices and processes report `unsupported-abi`. No generic (non-dotprod) arm64
  build is shipped.

**iOS**

* iOS 18 or later. The library still supports iOS 15.1+ for the other engines; on iOS < 18
  Phonon reports `os-too-old`.
* At least 3 GiB of physical memory (`low-memory` below that; a floor, not a measured need).
* Apple-silicon simulators run Phonon on the CPU (Core ML). Intel-Mac (x86_64) simulators build
  and link, but report `unsupported-abi`.
* Hardware support is planned to be verified on an iPhone 13 Pro (A15). Other iOS 18 devices
  (A12/A13 included) are not blocked by an allowlist: if a model fails to load on one, the
  failure is recorded and the engine is hidden on that device from then on (see
  [Persisted load failures](#persisted-load-failures)).

**Verification status.** The device matrix (Pixel 9, Galaxy S23, Snapdragon 8 Elite Gen5,
MediaTek MT6899, OnePlus 6 as the unsupported control, CI emulators with 4 KB and 16 KB pages,
iPhone 13 Pro, iOS simulators) is defined in [phonon/DESIGN.md §8.2](phonon/DESIGN.md). Its
results are recorded under `docs/phonon/evidence/` once the validation run is complete; until
then treat the lists above as requirements, not as tested guarantees.

## Enabling Phonon

### Android

In the app's `android/gradle.properties`:

```properties
RNSpeech_phononEnabled=true
# Optional: ABIs to package (default arm64-v8a). Add x86_64 for emulators (+~7.6 MB installed).
RNSpeech_phononAbis=arm64-v8a
```

`rootProject.ext.RNSpeech_phononEnabled = true` in `android/build.gradle` works too. The build
downloads the release asset pinned in the package's `phonon.lock.json` once, checks its sha256,
caches it under `~/.gradle/caches/rnspeech-phonon/<release>/` and packages only the requested
ABIs. No Rust toolchain is needed. The download is a normal Gradle task and works with the
configuration cache.

Other properties:

| Property | Use |
|---|---|
| `RNSpeech_phononLibDir=/abs/path/jniLibs` | Use local binaries (`<dir>/<abi>/libptts_ffi.so`, with `phonon_required_hwcaps.h` in `<dir>/../include` or `<dir>/include`); skips the download. Offline builds and development. |
| `RNSpeech_phononBaseUrl=https://mirror/...` | Download the pinned asset from a mirror (`file://` works). The sha256 from the lock is still enforced. |
| `RNSpeech_phononForceReason=low-memory` | **Debug builds only**: make `getEngineSupport` report this reason, to test your unsupported path. Always empty in release builds. |

R8/ProGuard keep rules ship with the library; nothing to add.

### iOS

In the app's `ios/Podfile`, before `use_react_native!` / target definitions:

```ruby
ENV['RN_SPEECH_PHONON'] = '1'
```

then `pod install`. The pod fetches the pinned `PhononCore.xcframework` release asset, checks
its sha256, caches it in `~/Library/Caches/rnspeech-phonon` (override with
`RN_SPEECH_PHONON_CACHE`), and copies it into the pod. It links `CoreML` and `CoreVideo`; no
build-setting changes are needed in the app (no `EXCLUDED_ARCHS`, no weak linking).

| Variable | Use |
|---|---|
| `RN_SPEECH_PHONON_XCFRAMEWORK=/abs/PhononCore.xcframework` | Use a local framework directory, or a release zip containing one; skips the download (not sha-checked). |
| `RN_SPEECH_PHONON_RELEASE_URL=https://mirror/...` | Download the pinned asset from a mirror (`file://` works); the sha256 is still enforced. |
| `RN_SPEECH_PHONON_CACHE=/abs/dir` | Download cache location. |

**The package folder must be writable.** `pod install` copies the framework into the
installed package (`ios/phonon/PhononCore.xcframework`), because CocoaPods only vendors paths
inside the pod. This happens for the downloaded release and for `RN_SPEECH_PHONON_XCFRAMEWORK`
alike, so the override does not help with a read-only package store. pnpm's default
`node_modules` layout is writable; Yarn PnP needs `nodeLinker: node-modules` (which React Native
requires anyway). If `pod install` fails with a permission error under the package's
`ios/phonon/`, make that folder writable.

Debug builds can force a support reason with the environment variable
`RN_SPEECH_PHONON_FORCE_REASON` (scheme environment) or the Info.plist key
`RNSpeechPhononForceReason`; both are ignored in release builds.

### Expo

There is no config plugin yet. In a bare / prebuild project set the Gradle property and the
Podfile `ENV` line above yourself (or with a small custom config plugin that edits
`gradle.properties` and the Podfile). Expo Go is not supported, as for the rest of the library.

### Disabling

Leave the flag unset, or set `RNSpeech_phononEnabled=false` / `RN_SPEECH_PHONON=0`. The flag-off
build contains no Phonon binary, shim, Kotlin bridge or Objective-C code. The engine's JS
(budget about 40 KB, not yet measured) is always part of the bundle; it reports `not-compiled`.

### Before the first binary release

Until the library publishes its first `phonon-bin-*` release, `phonon.lock.json` holds
`PLACEHOLDER` hashes. While a hash is a placeholder, enabling the flag **builds without Phonon
and prints a warning**, unless a local override (`RNSpeech_phononLibDir`,
`RN_SPEECH_PHONON_XCFRAMEWORK`) is set. To build the binaries locally, follow
[scripts/phonon/README.md](../scripts/phonon/README.md#local-builds-and-the-dev-override);
from a checkout of this repo the example app has `yarn build:android:phonon` for the Android
side. A local build reports its `libraryVersion` as `<version>+local`.

## Models

The library downloads nothing: the app downloads the model files and passes a local folder.
[`example/src/utils/PhononModelManager.ts`](../example/src/utils/PhononModelManager.ts) is a
complete reference (per-file download into a staging folder, size and sha256 check, atomic
rename, free-space check).

### Android: checkpoint folder

Download these files from Hugging Face
[`gradium/phonon-31m-en`](https://huggingface.co/gradium/phonon-31m-en) (pin a revision; the
example uses `52433c46975bfa13144c56204c9f4ee1c5b148aa`) into one folder:

| File | Size |
|---|---|
| `config.json` | 2.8 KB |
| `tokenizer.json` | 278 KB |
| `model.q8.gguf` | 64.5 MB |
| `default-voice.safetensors` | 256 KB |

That folder is `modelPath`. Extra voices go into `<modelPath>/voices/<Name>.safetensors`; see
[Voices](#voices).

### iOS: precompiled Core ML bundle

iOS loads a Core ML bundle folder, not the checkpoint. Use the bundle **precompiled** to
`.mlmodelc` (about 170 MB unzipped), so the device does not compile anything:

* The precompiled bundle is produced by this repo's `phonon-binaries.yml` workflow and is
  mirrored unzipped on Hugging Face under the palshub org (`palshub/phonon-31m-en-coreml`),
  together with a `phonon-31m-en-coreml.manifest.tsv` (`path<TAB>size<TAB>sha256` per file).
  Download each listed file and verify it; no zip library is needed. Until that mirror is
  published, the example's iOS download needs a mirror passed to `setIosMirror`.
* Alternatively, upstream's release asset `phonon-31m-en-coreml.zip` (137 MB zip) contains
  uncompiled `.mlpackage`s. Phonon compiles them on the first load, which takes about 10 s on
  an iPhone 16 Pro and longer on older phones, and needs ~320 MB of disk afterwards.
  `phononNeedsCompile` (see below) tells you when to show a "Preparing model" state.

`modelPath` must be the **inner** folder that contains `bundle.json`, for example
`<Application Support>/phonon/phonon-31m-en-coreml/`, not the folder you unzipped into. The
folder must be writable (compiled models are written next to the sources) and should be
excluded from iCloud backup (`NSURLIsExcludedFromBackupKey`). Voices are part of the bundle.

### Licences

| Model | Source | Licence |
|---|---|---|
| Phonon 31m (`phonon-31m-en`, and its Core ML bundle) | Gradium, public on Hugging Face | Apache-2.0 |
| Voices (`gradium/phonon-voices`) | Gradium | Apache-2.0 (check the repo's model card) |
| Phonon 40m (`phonon-40m-en`, `-fr`, `-de`, `-es`, `-pt`, `-multilingual`) | Gradium, gated on Hugging Face | **CC BY-NC 4.0** |

> **Phonon 40m is non-commercial (CC BY-NC 4.0).** Do not ship it, or download it on behalf of
> users, in a commercial app. The library never downloads any model; the example app never
> downloads 40m either: it only lists a 40m checkpoint the user copied onto an Android device
> themselves, behind a "non-commercial" toggle. Check each model's Hugging Face page before
> redistribution.

See [LICENSES.md](LICENSES.md) for every engine's model licence and the native binaries'
third-party notices.

## Usage

```ts
import Speech, {TTSEngine} from '@pocketpalai/react-native-speech';

const support = await Speech.getEngineSupport(TTSEngine.PHONON);
if (!support.supported) {
  // e.g. 'not-compiled', 'missing-cpu-features', 'os-too-old': hide the engine.
  console.log(`[Phonon] hidden: ${support.reason}`);
} else {
  await Speech.initialize({
    engine: TTSEngine.PHONON,
    modelPath: '/data/user/0/.../phonon/31m-en', // Android: checkpoint folder
    // iOS: '/var/mobile/.../Application Support/phonon/phonon-31m-en-coreml'
    voicesMetadataPath: '/data/user/0/.../phonon/31m-en/voices.jsonl', // optional
  });

  // No voice id: the model's default voice. Named voices such as 'Zoey' need their voice
  // files (Android: voices/<Name>.safetensors from gradium/phonon-voices) or must exist in
  // the iOS bundle; check Speech.getVoices().
  await Speech.speak('Hello from Phonon.');
}
```

`getEngineSupport` never throws (an unexpected failure is `{supported: false, reason:
'error'}`) and is cached once it resolves. `Speech.initialize({engine: TTSEngine.PHONON})` on an
unsupported build or device rejects with `ERR_PHONON_UNSUPPORTED` without loading anything, and
the previously current engine stays current.

`speak`, `stop`, `pause`, `resume`, `isSpeaking`, `createSpeechStream` (including
`firstChunk: 'clause'`), `HighlightedText` / chunk progress, `onAudioChunk`, `volume` and audio
interruptions work as for the other neural engines. `Speech.release()` releases the model.

On iOS with an uncompiled bundle, the first `initialize` compiles the models (see above). You can
check beforehand with the advanced export. `PhononEngine` is an internal, advanced export
without a stability promise; this method may change or move in a later release:

```ts
import {PhononEngine} from '@pocketpalai/react-native-speech';
const willCompile = await PhononEngine.needsCompile(modelPath); // always false on Android
```

### Configuration (`PhononConfig`)

| Field | Platforms | Default | Meaning |
|---|---|---|---|
| `modelPath` | both | required | Android: checkpoint folder. iOS: inner Core ML bundle folder (holds `bundle.json`). |
| `language` | both | `'en'` | Text normalization language: `'en' \| 'fr' \| 'de' \| 'es' \| 'pt' \| 'none'`. Phonon 31m speaks English only; other languages need a 40m model (CC BY-NC). |
| `defaultVoice` | both | upstream's default voice | Voice used when `speak` gets no voice id. |
| `numThreads` | Android | policy | Worker threads; `0`/unset = the number of big cores, clamped to 2–4. Fixed for the process lifetime after the first `initialize` (see limits). |
| `spinBudget` | Android | upstream (5000) | **Accepted but ignored for now** (logs a warning): the native build does not pass it on yet. Reserved for `XN_SPIN_BUDGET`, how long idle workers spin before sleeping. |
| `computeUnit` | iOS | `'neuralEngine'` | `'neuralEngine'` or `'cpu'` for the flow model. The simulator always runs on the CPU. |
| `maxChunkSize` | both | `250` | Maximum characters per synthesized chunk. |
| `voicesMetadataPath` | both | none | A `voices.jsonl` (subset of the `gradium/phonon-voices` catalog) used for display names, gender, locale and description. |

### Voices

`Speech.getVoices()` returns the voice ids the loaded model reports, and
`getVoicesWithMetadata()` adds metadata from `voicesMetadataPath` when given.

* **Android.** The checkpoint's default voice is always available (pass `''` or no voice to
  use it). Every `<modelPath>/voices/<Name>.safetensors` file adds a voice called `<Name>`.
  Download voice files from [`gradium/phonon-voices`](https://huggingface.co/gradium/phonon-voices)
  (`voices/<voice_id>.safetensors`) and save them under a display name. The example installs
  eight English voices: Zoey, Juniper, Harper, Easton, Micah, Trevor (US) and Maeve, Alfie (UK),
  and writes a matching `voices.jsonl` (`name`, `filename`, `voice_id`, `language`,
  `description`, `gender` per line). Add voices before `initialize`, or initialize again after
  downloading more.
* **iOS.** The voices are the ones packaged in the Core ML bundle.

Pick a voice in the language of your text. An unknown voice id rejects with `ERR_PHONON_VOICE`.
Switching voices between utterances costs one voice conditioning step on the first chunk; the
same voice is not re-applied.

### Support reasons

`getEngineSupport(TTSEngine.PHONON).reason`:

| Reason | Platform | Meaning |
|---|---|---|
| `ok` | both | Supported. |
| `not-compiled` | both | The app was built without the Phonon flag (or with a placeholder lock, see above). |
| `unsupported-abi` | both | 32-bit process, an ABI not packaged (`RNSpeech_phononAbis`; reported once the shim loads), or the x86_64 iOS simulator. |
| `translated-abi` | Android | arm64 code running under translation on x86. |
| `missing-cpu-features` | Android | CPU lacks dotprod / fp16; `detail` names the missing features. |
| `library-missing` | Android | The Phonon library could not be loaded (not packaged, or AGP < 8.5.1 on a 16 KB-page device). Persisted only when `libptts_ffi` fails to load in `initialize`; a probe-time shim load failure is not recorded. |
| `symbols-missing` | Android | The library loaded but lacks an expected `ptts_*` symbol (mismatched binary). Persisted. |
| `load-failed` | both | A model failed to load in a way that is not a path or file error (for example a Core ML compile or Neural Engine plan failure). Persisted. |
| `os-too-old` | iOS | iOS < 18. |
| `low-memory` | both | Less than 3 GiB of RAM. |
| `forced` | both | Reserved for forced results; a debug force reason is reported as the forced value itself, with `detail: 'forced'`. |
| `error` | both | The probe itself failed (should not happen; `detail` has the message). |

### Persisted load failures

`library-missing` (from `initialize` only), `symbols-missing` and `load-failed` are written to a small file
(Android `noBackupFilesDir/rnspeech-phonon-cap.json`; iOS `Library/Application
Support/rnspeech-phonon-cap.json`, excluded from backup) keyed by device, OS build, library
version and model. From then on `getEngineSupport` reports that reason and the engine stays
hidden, so one failure does not repeat on every launch. Any change of the key (OS update, new
library release, different model) re-enables the check. On iOS a load failure first triggers
one recovery attempt before it is recorded: compiled models that have an `.mlpackage` next to
them (so they can be rebuilt) are deleted and the load is retried once. There is no public JS API to clear the record yet; clearing the app's data does.

### Errors

Phonon errors are `PhononError`s (exported) with a stable `code`:

| Code | When |
|---|---|
| `ERR_PHONON_UNSUPPORTED` | Not compiled, or not supported on this device (`PhononUnsupportedError`, with `reason` and `detail`). |
| `ERR_PHONON_LOAD` | The model could not be loaded (wrong path, missing file, Core ML failure). |
| `ERR_PHONON_NOT_INITIALIZED` | The engine or its native handle is gone (for example after `release`). |
| `ERR_PHONON_VOICE` | Unknown voice id. |
| `ERR_PHONON_LANGUAGE` | Language not supported by the model. |
| `ERR_PHONON_SYNTH` | Synthesis failed in native code. |
| `ERR_PHONON_BUFFER_LIMIT` | Too many synthesized chunks waiting to be played (should not happen in normal use). |
| `ERR_PHONON_TIMEOUT` | A synthesis took far longer than expected (`max(10 s, 4 × expected)`). The engine is marked broken until the app restarts. |
| `ERR_PHONON_INTERNAL` | Unexpected native or bridge error. |

Stopping is not an error: a stopped request just ends.

## Limits

* **No speed or pitch control.** The v0.4.0 native API has no rate or pitch parameter. `speed`
  and `pitch` options are ignored, with one warning each per engine instance. `volume` works.
* **No phoneme input.** `speak({phonemes})` is rejected; Phonon does its own text processing.
* **Language.** Phonon 31m is English only. `language` selects text normalization; the 40m
  per-language and multilingual models (CC BY-NC) cover French, German, Spanish and Portuguese.
  On iOS only the 31m English Core ML bundle is available.
* **Worker threads are fixed per process (Android).** `numThreads` takes effect on the first
  `initialize` in a process; later values are ignored until the app restarts. `spinBudget` is
  accepted but ignored for now (a warning is logged). The
  workers keep running (and spin briefly between chunks) while the process lives, also across
  JS reloads and `release()`.
* **Native state outlives JS reloads.** A Metro reload cancels pending synthesis but keeps the
  native worker and library loaded; the next `initialize` reuses them.
* **First load.** Android loads in roughly 60–630 ms. iOS with a precompiled bundle loads
  without compiling; an uncompiled bundle compiles once (~10 s or more), and an in-progress
  compile cannot be cancelled.
* **Timeout is final.** After `ERR_PHONON_TIMEOUT` the engine stays unusable for the process
  lifetime, because a hung native worker cannot be recovered.
* **Memory.** Plan for a 3 GiB+ device; the engine refuses to run below that. Release other
  neural engines before initializing Phonon.
* **App size.** Enabling Phonon adds ~7.6 MB installed per packaged Android ABI (stored
  uncompressed so it can be mapped directly; ~2.5 MB Play download), plus the model the app
  downloads.
* **Streaming granularity.** Each chunk is synthesized completely before it plays. With
  `firstChunk: 'clause'` the first chunk is short, which keeps first-audio latency low; frame
  streaming within a chunk is planned.

## Troubleshooting

| Symptom | Check |
|---|---|
| `not-compiled` although the flag is set | Look for the `RNSpeech: ... PLACEHOLDER` warning in the Gradle or `pod install` output: no binary release is pinned yet, so set a local override. On iOS run `pod install` again after changing the Podfile. |
| `library-missing` on Android | The library is not packaged in the APK, or the app uses AGP < 8.5.1 on a 16 KB-page device. (An ABI missing from `RNSpeech_phononAbis` reports `unsupported-abi`.) |
| `missing-cpu-features` | Expected on CPUs without dotprod (e.g. Snapdragon 845). Use another engine. |
| `ERR_PHONON_LOAD` on iOS | `modelPath` must be the inner folder with `bundle.json`, and writable. |
| Engine hidden after one failure | A persisted record (see above). Clear app data, or update the OS / library / model. |
| `speed` has no effect | Not supported by Phonon v0.4.0. |
