# Changelog

## [0.2.1](https://github.com/a-ghorbani/react-native-speech/compare/phonon-v0.2.0...phonon-v0.2.1) (2026-11-11)


### Bug Fixes

* a new speak() or stream replaces the previous utterance ([#95](https://github.com/a-ghorbani/react-native-speech/issues/95)) ([6823a1f](https://github.com/a-ghorbani/react-native-speech/commit/6823a1f8b3d152d98f01989cf0f9810cb844954e))
* keep the space between sentences TextChunker groups into one chunk ([#61](https://github.com/a-ghorbani/react-native-speech/issues/61)) ([88b092a](https://github.com/a-ghorbani/react-native-speech/commit/88b092a2116d10795fc850e60d4009c29286be0d))
* **phonon:** accept core 2.10 in the peer range ([#131](https://github.com/a-ghorbani/react-native-speech/issues/131)) ([fc7b563](https://github.com/a-ghorbani/react-native-speech/commit/fc7b5637488e26080f1a9b6ab7c03e0fbd51eb14))
* **phonon:** trim edge silence before storing a buffer ([#85](https://github.com/a-ghorbani/react-native-speech/issues/85)) ([e4ea93c](https://github.com/a-ghorbani/react-native-speech/commit/e4ea93cc4b718b1dc9498037369359251060054c))
* **streaming:** synthesize two chunks ahead and size chunks to the synthesis rate ([#93](https://github.com/a-ghorbani/react-native-speech/issues/93)) ([73dc7f9](https://github.com/a-ghorbani/react-native-speech/commit/73dc7f92c6b67c18d339886e6003ea27da04d27a))

# [0.2.0](https://github.com/a-ghorbani/react-native-speech/compare/phonon-v0.1.3...phonon-v0.2.0) (2026-11-08)


### Features

* configurable first-chunk word limit (firstChunkMaxWords) ([#56](https://github.com/a-ghorbani/react-native-speech/issues/56)) ([dd66531](https://github.com/a-ghorbani/react-native-speech/commit/dd66531933597eb8b8af7d9bc104d552b88131b8))

## [0.1.3](https://github.com/a-ghorbani/react-native-speech/compare/phonon-v0.1.2...phonon-v0.1.3) (2026-10-24)


### Bug Fixes

* **phonon:** build the iOS binaries from source without Apple AMX ([#53](https://github.com/a-ghorbani/react-native-speech/issues/53)) ([f2fc556](https://github.com/a-ghorbani/react-native-speech/commit/f2fc556d9aa6b92dd617fd11f96f3a51ef9c8861))

## [0.1.2](https://github.com/a-ghorbani/react-native-speech/compare/phonon-v0.1.1...phonon-v0.1.2) (2026-10-23)


### Bug Fixes

* **phonon:** skip a chunk with nothing to synthesize instead of failing ([#50](https://github.com/a-ghorbani/react-native-speech/issues/50)) ([5dfba45](https://github.com/a-ghorbani/react-native-speech/commit/5dfba45456d2bdcf59c2e28edda465474c6ce4ee))

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
