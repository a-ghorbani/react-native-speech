# Phonon iOS host tests

Linux/macOS tests for the parts of the iOS integration that need no Xcode
(`docs/phonon/DESIGN.md` WP5). Outside every podspec glob and not in the npm package.

```bash
scripts/test-phonon-ios.sh      # all of the below; PHONON_SANITIZE=0 to skip ASan/UBSan
```

| File | Covers |
|---|---|
| `policy_test.cpp` | `ios/phonon/PhononIosPolicy.cpp`: support order (§2.2), `needs_compile`, the recovery set (only `.mlmodelc` with a `.mlpackage` beside it), load-error classification for the capability store, playback gain/clamp, effective compute unit, capability-record keying |
| `fetch_test.rb` | `ios/phonon/fetch.rb`: placeholder lock, sha256 verification and cleanup, cache hits, corrupt cache, release change, local directory / zip override and its stamp, framework validation |
| `podspec_test.rb` | `RNSpeech.podspec` evaluated with a stand-in DSL: flag off (no Phonon sources, frameworks or defines), placeholder fallback with a warning, local override (vendored framework, CoreML/CoreVideo, defines), sha mismatch fails `pod install`, one `ptts.h` and no tests in the source globs |

The Objective-C++ bridge (`ios/phonon/RNSpeechPhonon.mm`, the `phonon*` methods in
`ios/RNSpeech.mm`) is tested by `example/ios/SpeechExampleTests/PhononTests.m` (XCTest, macOS):

```bash
cd example/ios && RN_SPEECH_PHONON=1 RN_SPEECH_PHONON_XCFRAMEWORK=<PhononCore.xcframework> pod install
IOS_SIMULATOR="iPhone 16" scripts/test-ios.sh
# optional model smoke (inner Core ML bundle folder with bundle.json, readable by the simulator):
TEST_RUNNER_PHONON_TEST_MODEL_DIR=/abs/phonon-31m-en-coreml scripts/test-ios.sh
```

In a flag-off build `RNSpeechPhonon` does not exist and every `PhononTests` case returns early
(logged as skipped).
