# Phonon binaries

Scripts that build, repackage and verify the Phonon native binaries the library downloads at
consumer build time when the Phonon engine is enabled (`docs/phonon/DESIGN.md` §2.3, §3, §4.1).
CI runs them in `.github/workflows/phonon-binaries.yml`; every one also runs locally.

| Script | Runs on | Does |
|---|---|---|
| `build-android.sh` | Linux, macOS | `libptts_ffi.so` for arm64-v8a / x86_64 from the pinned xn-ptts commit, staged with `include/`, `licenses/`, `BUILDINFO.json` |
| `verify-android-so.sh` | Linux, macOS | 16 KB alignment, NEEDED set, exactly the 8 `ptts_*` exports, stripped, no build paths, size budgets, dotprod present, no instructions outside `arm64Features` (except the runtime-gated allowance in `arm64-features.sh`). `--selftest` builds dummies that must fail |
| `gen-hwcaps-header.sh` | any | `phonon_required_hwcaps.h` from the feature list (called by `build-android.sh`) |
| `gen-notices.sh` | Linux, macOS | third-party notices with cargo-about (`about.toml`, `about.hbs`) |
| `package-android.sh` | Linux, macOS | deterministic `phonon-android-<ver>-r<N>.zip` + `SHA256SUMS` |
| `package-ios.sh` | macOS + Xcode | upstream `PhononCore.xcframework` → prelinked, headerless, minos 15.1, with an x86_64 simulator stub (`ptts_stub.c`), zipped |
| `verify-ios-xcframework.sh` | macOS, or Linux with NDK LLVM tools | layout, archs, one prelinked object per arch, 8 exports (`ptts.exp`), no `_OBJC_CLASS_$` refs, every other undefined symbol in `ios-undefined-allow.txt` (SDK C symbols only), no bitcode, minos 15.1. `--selftest` |
| `precompile-coreml.sh` | macOS + Xcode | upstream Core ML bundle → `.mlmodelc` + rewritten `bundle.json` + `manifest.tsv` (`bundle_manifest.py`) for the HF mirror |
| `update-lock.sh` | any | release/asset names and sha256s into `phonon.lock.json` |
| `test-scripts.sh` | Linux, macOS | tests for all of the above |

`arm64-features.sh` is the one feature table (HWCAP bits, instruction patterns) shared by the
header generator and the verifier. All scripts read `phonon.lock.json`; `PHONON_LOCK=<file>`
points them at another one (tests use this). The bash scripts that use the feature table need
bash >= 4: on a Mac, Homebrew's bash (the GitHub macOS runners have it first on PATH).

## Zip layouts (what the Gradle task and `ios/phonon/fetch.rb` unpack)

```
phonon-android-<ver>-r<N>.zip            phonon-ios-<ver>-r<N>.xcframework.zip
  jniLibs/arm64-v8a/libptts_ffi.so         PhononCore.xcframework/
  jniLibs/x86_64/libptts_ffi.so              Info.plist
  include/ptts.h                             ios-arm64/libptts_ffi.a
  include/phonon_required_hwcaps.h           ios-arm64_x86_64-simulator/libptts_ffi.a
  licenses/xn-ptts-LICENSE-{MIT,APACHE}    licenses/xn-ptts-LICENSE-{MIT,APACHE}
  THIRD_PARTY_NOTICES.md                   THIRD_PARTY_NOTICES.md
  BUILDINFO.json                           BUILDINFO.json
```

`phonon_required_hwcaps.h` defines `PHONON_ARM64_FEATURES`, `PHONON_REQUIRED_HWCAP`,
`PHONON_REQUIRED_HWCAP2` and `PHONON_REQUIRED_HWCAP_LIST(X)` (`X(word, bit, "name")`), all zero
off aarch64. The shim takes it from the zip (or from `include/` next to a local `jniLibs`), never
from `scripts/`, which is not in the npm package.

## Local builds and the dev override

No release exists until the owner triggers the workflow, so the lock's sha256s are
`PLACEHOLDER` and Gradle / the podspec fall back to flag-off unless pointed at local binaries.

Android (Linux or macOS; Rust 1.99.1, cargo-ndk 4.1.2, NDK 28.2.13676358, jq):

```bash
git clone https://github.com/gradium-ai/xn-ptts /tmp/xn-ptts
git -C /tmp/xn-ptts checkout f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa   # v0.4.0, as in the lock
export ANDROID_NDK_HOME=~/Android/Sdk/ndk/28.2.13676358
scripts/phonon/build-android.sh --upstream /tmp/xn-ptts          # -> scripts/out/phonon/android
scripts/phonon/verify-android-so.sh --jnilibs scripts/out/phonon/android/jniLibs
cargo install cargo-about --version 0.9.2 --locked --features cli
scripts/phonon/gen-notices.sh --upstream /tmp/xn-ptts --out scripts/out/phonon/NOTICES-android.md \
  --target aarch64-linux-android --target x86_64-linux-android
scripts/phonon/package-android.sh --stage scripts/out/phonon/android \
  --notices scripts/out/phonon/NOTICES-android.md                 # -> scripts/out/phonon/dist
```

Then, in the consumer's `android/gradle.properties` (`scripts/out/` is git-ignored):

```properties
RNSpeech_phononEnabled=true
RNSpeech_phononLibDir=/abs/path/to/react-native-speech/scripts/out/phonon/android/jniLibs
```

On an aarch64 Linux host, the NDK's x86_64 tools run under qemu binfmt; that works (the
reference build above was made that way). `build-android.sh` always passes an explicit
`target-cpu`, so the checkout's `.cargo/config.toml` `target-cpu=native` never applies.

iOS (macOS with Xcode 16+):

```bash
scripts/phonon/gen-notices.sh --upstream /tmp/xn-ptts --out scripts/out/phonon/NOTICES-ios.md \
  --target aarch64-apple-ios --target aarch64-apple-ios-sim
scripts/phonon/package-ios.sh --work scripts/out/phonon/ios \
  --notices scripts/out/phonon/NOTICES-ios.md \
  --licenses scripts/out/phonon/android/licenses                 # or any dir with xn-ptts-LICENSE-*
# downloads + checks the upstream zip; notices and licenses are required (every zip has them)
export RN_SPEECH_PHONON=1
export RN_SPEECH_PHONON_XCFRAMEWORK=$PWD/scripts/out/phonon/ios/PhononCore.xcframework
(cd example/ios && pod install)
```

To try the download path against local zips instead, `update-lock.sh --sums
scripts/out/phonon/dist/SHA256SUMS --only android` writes their hashes into the lock (do not
commit that; the publish job opens the real lock PR). Then
`RNSpeech_phononBaseUrl=file:///abs/path/to/scripts/out/phonon/dist` makes Gradle "download"
from there (also usable for a mirror); the zip is cached under
`~/.gradle/caches/rnspeech-phonon/<release>/` and re-verified against the lock on every use.

## Releasing

Owner only: run the workflow with `publish` ticked (or push a `phonon-bin-v<ver>-r<N>` tag). It
creates the release with `--latest=false`, uploads the zips, `SHA256SUMS` and both
`BUILDINFO-*.json`, and opens a PR pinning the hashes and refreshing
`docs/phonon/THIRD_PARTY_NOTICES.md`. The PR targets the dispatching branch, or the default
branch for a tag push (a tag checkout has no branch to open a PR from); that branch's lock must
pin the same upstream commit, which is checked before anything is published. The lock is updated
before the release is created, and a re-run that finds its own release (same `SHA256SUMS`) goes
on to the PR instead of failing. The precompiled Core ML bundle is a workflow artifact
(`phonon-31m-en-coreml-precompiled`) to mirror to the palshub HF repo. Releases are immutable:
rebuilding means a new `-r<N>`. Pull requests that touch these files only lint (actionlint with
shellcheck, pinned), build and verify.

## Tests

```bash
ANDROID_NDK_HOME=~/Android/Sdk/ndk/28.2.13676358 scripts/phonon/test-scripts.sh
# also verify a real build:
PHONON_ANDROID_STAGE=scripts/out/phonon/android scripts/phonon/test-scripts.sh
# lint, as CI does (actionlint 1.7.12, shellcheck 0.11.0 via `pip install shellcheck-py`):
actionlint .github/workflows/phonon-binaries.yml && shellcheck -x scripts/phonon/*.sh
```

## Not yet run on a Mac

Written and statically checked on Linux only; the first macOS run (CI `ios` job or by hand) must
confirm:

- `test-scripts.sh` passes under the runner's bash with Xcode's tools (iOS verifier self-test
  with `xcrun clang` / `libtool`; package-android.sh on BSD `date` / `touch` / `shasum`).
- `package-ios.sh`: `xcrun ld -r ... -exported_symbols_list ptts.exp -filelist members.txt` over
  all ~707 members per slice links without duplicate-symbol errors (it links in members archive
  resolution would have left out, e.g. compiler_builtins); `verify-ios-xcframework.sh`'s
  `undefined` check passes (only iOS 15-safe SDK C symbols left undefined; extend
  `ios-undefined-allow.txt` only after checking a symbol exists in iOS 15.1); whether
  `bitcode_strip` takes the members or the `llvm-objcopy` fallback is needed (Homebrew llvm on
  macos-15, else `brew install llvm`); `xcodebuild -create-xcframework` names the fat simulator
  library `ios-arm64_x86_64-simulator`; the ditto zip has `PhononCore.xcframework/` at its root.
- An app links the result with `-all_load` (WP8) on device and simulator.
- `precompile-coreml.sh` with the real `xcrun coremlcompiler compile`; the host-compiled
  `.mlmodelc` loads on an A15 ANE (WP5).

