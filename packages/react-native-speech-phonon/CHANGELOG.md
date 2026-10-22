# Changelog

## [0.1.1](https://github.com/a-ghorbani/react-native-speech/compare/phonon-v0.1.0...phonon-v0.1.1) (2026-10-22)


### Bug Fixes

* don't play a stream chunk stopped from a callback; post-release Phonon follow-ups ([#40](https://github.com/a-ghorbani/react-native-speech/issues/40)) ([5937408](https://github.com/a-ghorbani/react-native-speech/commit/593740877b023765f06aae0f1d9a7201b77b48f6))
* **phonon:** accept core 2.8 in the peer range ([#41](https://github.com/a-ghorbani/react-native-speech/issues/41)) ([6f7246a](https://github.com/a-ghorbani/react-native-speech/commit/6f7246a60299ffe11f839845b7ff68e7b0178f05))

## [0.1.0](https://github.com/a-ghorbani/react-native-speech/releases/tag/phonon-v0.1.0) (2026-10-22)

### Added

- **Phonon engine (`@pocketpalai/react-native-speech-phonon`).** Gradium's Phonon
  (`gradium-ai/xn-ptts` v0.4.0) as a native neural engine for
  `@pocketpalai/react-native-speech` (`~2.7.0`): CPU on Android (arm64 with dotprod/fp16, or
  x86_64; AGP ≥ 8.5.1), Core ML on iOS 18+. Installing the package is the opt-in: register it
  with `Speech.registerEngine(new PhononEngine())` and initialize it with
  `{engine: PHONON, modelPath}`. The build fetches sha256-pinned binaries from
  `phonon.lock.json`, with local overrides (`RNSpeech_phononLibDir`,
  `RN_SPEECH_PHONON_XCFRAMEWORK`); a lock without published hashes fails the build. Adds
  ~7.6 MB installed per Android ABI. Playback goes through the core's neural player. The
  package downloads no models; Phonon 31m and the voices are Apache-2.0, Phonon 40m is
  **CC BY-NC 4.0** (non-commercial). No speed or pitch control (ignored with a warning). See
  [README.md](README.md).
- `Speech.getEngineSupport(PHONON)` reports why Phonon cannot run (`not-compiled`,
  `missing-cpu-features`, `os-too-old`, `low-memory`, ...) without loading the Phonon library,
  and load failures are remembered per device so the engine stays hidden.
- `PhononError` / `PhononUnsupportedError` with stable `ERR_PHONON_*` codes, and the Phonon
  types (`PhononConfig`, `PhononVoice`, `PhononSupportInfo`, ...).
- `PhononEngine.getLastMetrics()` and `PhononEngine.onChunkMetrics(listener)` (returns an
  unsubscribe function): per-chunk timings (`PhononChunkMetrics`: `ttfaMs`, `totalMs`,
  `queuedMs`, `audioSec`, playback start/end, `voiceChanged`) once each chunk's playback ends.
