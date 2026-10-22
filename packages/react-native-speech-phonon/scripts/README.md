# Phonon binaries

Scripts that build, repackage and verify the Phonon native binaries this package downloads at
consumer build time (`docs/DESIGN.md` §2.3, §3, §4.1). Paths below are relative to the package
(`packages/react-native-speech-phonon/`). CI runs them in the repo's
`.github/workflows/phonon-binaries.yml`; every one also runs locally.

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
| `verify-apk.sh`, `check-npm-pack.sh`, ... | Linux | app-level CI checks, see [CI integration](#ci-integration-ciyml-design-42) |

`arm64-features.sh` is the one feature table (HWCAP bits, instruction patterns) shared by the
header generator and the verifier. All scripts read `phonon.lock.json`; `PHONON_LOCK=<file>`
points them at another one (tests use this). The bash scripts that use the feature table need
bash >= 4: on a Mac, Homebrew's bash (the GitHub macOS runners have it first on PATH).

## Zip layouts (what the Gradle task and `ios/fetch.rb` unpack)

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

App builds download the release pinned in `phonon.lock.json`. To build against binaries made
from a checkout instead:

Android (Linux or macOS; Rust 1.99.1, cargo-ndk 4.1.2, NDK 28.2.13676358, jq):

```bash
git clone https://github.com/gradium-ai/xn-ptts /tmp/xn-ptts
git -C /tmp/xn-ptts checkout f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa   # v0.4.0, as in the lock
export ANDROID_NDK_HOME=~/Android/Sdk/ndk/28.2.13676358
scripts/build-android.sh --upstream /tmp/xn-ptts          # -> scripts/out/android
scripts/verify-android-so.sh --jnilibs scripts/out/android/jniLibs
cargo install cargo-about --version 0.9.2 --locked --features cli
scripts/gen-notices.sh --upstream /tmp/xn-ptts --out scripts/out/NOTICES-android.md \
  --target aarch64-linux-android --target x86_64-linux-android
scripts/package-android.sh --stage scripts/out/android \
  --notices scripts/out/NOTICES-android.md                 # -> scripts/out/dist
```

Then, in the consumer's `android/gradle.properties` (`scripts/out/` is git-ignored):

```properties
RNSpeech_phononLibDir=/abs/path/to/packages/react-native-speech-phonon/scripts/out/android/jniLibs
```

The example app in this repo takes these binaries with `-PRNSpeech_phononLocal=true`
(`yarn example build:android:phonon`).

On an aarch64 Linux host, the NDK's x86_64 tools run under qemu binfmt; that works (the
reference build above was made that way). `build-android.sh` always passes an explicit
`target-cpu`, so the checkout's `.cargo/config.toml` `target-cpu=native` never applies.

iOS (macOS with Xcode 16+):

```bash
scripts/gen-notices.sh --upstream /tmp/xn-ptts --out scripts/out/NOTICES-ios.md \
  --target aarch64-apple-ios --target aarch64-apple-ios-sim
scripts/package-ios.sh --work scripts/out/ios \
  --notices scripts/out/NOTICES-ios.md \
  --licenses scripts/out/android/licenses                 # or any dir with xn-ptts-LICENSE-*
# downloads + checks the upstream zip; notices and licenses are required (every zip has them)
export RN_SPEECH_PHONON_XCFRAMEWORK=$PWD/scripts/out/ios/PhononCore.xcframework
(cd ../../example/ios && pod install)
```

`ios/fetch.rb` (run by the podspec at `pod install`) copies the framework into
`ios/PhononCore.xcframework` (git-ignored, never packed) and skips the copy while a stamp
says nothing changed. `RN_SPEECH_PHONON_XCFRAMEWORK` takes the framework directory or a release
zip; it is not sha-checked and reports `libraryVersion` as `<version>+local`. Without it, the
release asset from `phonon.lock.json` is downloaded once into `RN_SPEECH_PHONON_CACHE` (default
`~/Library/Caches/rnspeech-phonon`) and must match the pinned sha256, else `pod install` fails
and nothing is installed. `RN_SPEECH_PHONON_RELEASE_URL` replaces the release base URL (mirrors;
`file://` works). Host tests for both, and for the podspec: `scripts/test-ios.sh`.

To try the download path against local zips instead, `update-lock.sh --sums
scripts/out/dist/SHA256SUMS --only android` writes their hashes into the lock (do not
commit that; the publish job opens the real lock PR). Then
`RNSpeech_phononBaseUrl=file:///abs/path/to/scripts/out/dist` makes Gradle "download"
from there (also usable for a mirror); the zip is cached under
`~/.gradle/caches/rnspeech-phonon/<release>/` and re-verified against the lock on every use.

## Releasing

Owner only: run the workflow with `publish` ticked (or push a `phonon-bin-v<ver>-r<N>` tag). It
creates the release with `--latest=false`, uploads the zips, `SHA256SUMS` and both
`BUILDINFO-*.json`, and opens a PR pinning the hashes and refreshing
`docs/THIRD_PARTY_NOTICES.md`. The PR targets the dispatching branch, or the default
branch for a tag push (a tag checkout has no branch to open a PR from); that branch's lock must
pin the same upstream commit, which is checked before anything is published. The lock is updated
before the release is created, and a re-run that finds its own release (same `SHA256SUMS`) goes
on to the PR instead of failing. The precompiled Core ML bundle is a workflow artifact
(`phonon-31m-en-coreml-precompiled`) to mirror to the palshub HF repo. Releases are immutable:
rebuilding means a new `-r<N>`. Pull requests that touch these files only lint (actionlint with
shellcheck, pinned), build and verify.

The lock PR is opened with the `PHONON_LOCK_PR_TOKEN` secret (a PAT or GitHub App token with
contents and pull-requests write) when it is set. Without it the default `GITHUB_TOKEN` is used,
and GitHub starts no workflows for that PR: trigger `ci.yml` by hand (close and reopen the PR,
or push an empty commit) before merging, because that run is the first to download and verify
the released binaries.

## Tests

```bash
ANDROID_NDK_HOME=~/Android/Sdk/ndk/28.2.13676358 scripts/test-scripts.sh
# also verify a real build:
PHONON_ANDROID_STAGE=scripts/out/android scripts/test-scripts.sh
# lint, as CI does (actionlint 1.7.12, shellcheck 0.11.0 via `pip install shellcheck-py`):
actionlint ../../.github/workflows/phonon-binaries.yml && shellcheck -x scripts/*.sh
```

## CI integration (`ci.yml`, design §4.2)

The scripts the app-level CI jobs run; all of them also run locally, and
`test-ci-scripts.sh` tests them (plus the structure of `ci.yml`).

| Script | Does |
|---|---|
| `verify-apk.sh` | what an APK carries of Phonon. `--phonon on`: per ABI both libraries present, stored uncompressed at 16 KB aligned offsets, PT_LOAD p_align ≥ 0x4000, NEEDED sets, `--libdir` source match (PT_LOAD bytes: AGP re-strips), none under other ABIs, `PhononNative` natives survived R8. `--phonon off`: no Phonon library, no `PhononNative`. `--selftest` |
| `check-npm-pack.sh` | `npm pack` (runs `prepare`, as publishing does): lock and Phonon build glue in; `test/`, `cpp/tests`, JVM tests, scripts, docs other than the notices, build output, any `libptts_ffi*` / `PhononCore.xcframework` out; tarball size. `--core --root ../..`: the core package has no Phonon file or mention. `--selftest` |
| `ci-emulator-selftest.sh` | installs a debug APK with the add-on, copies a model in with `run-as`, runs the self-test deep link, checks the `[SelfTest]` results, page size and crashes. `--check-log` checks saved logs; `--selftest` |
| `fetch-ci-model.sh` | phonon-31m-en checkpoint, sha256-pinned in `example/src/utils/phononPins.json`, for the emulator jobs' cache |
| `example-without-addon.sh` | drops the add-on from `example/package.json`, so the example builds as a core-only app (undo: `git checkout example/package.json`) |
| `ci.init.gradle` | CI-only switches without touching the example's build files: `-PrnSpeechCiMinify=true` (R8 on for release), `-PrnSpeechCiBundleDebug=true` (JS bundled into the debug APK) |

The add-on jobs download the release pinned in `phonon.lock.json`, like a consumer build. Pull
requests that change the build scripts or the lock build and verify fresh binaries in
`phonon-binaries.yml`.

Reproducing the jobs locally (Linux, after the "Local builds" steps above):

```bash
export ANDROID_NDK_HOME=~/Android/Sdk/ndk/28.2.13676358
LIBS=$PWD/scripts/out/android/jniLibs
APK=../../example/android/app/build/outputs/apk/release/app-release.apk
(cd ../../example/android && ./gradlew assembleRelease \
  -PreactNativeArchitectures=arm64-v8a,x86_64 -PRNSpeech_phononAbis=arm64-v8a,x86_64 \
  -PRNSpeech_phononLibDir=$LIBS -PrnSpeechCiMinify=true -I $OLDPWD/scripts/ci.init.gradle)
scripts/verify-apk.sh --apk $APK --phonon on --abis arm64-v8a,x86_64 --libdir $LIBS
# the core alone: the example without the add-on carries no Phonon
scripts/example-without-addon.sh
(cd ../../example/android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a)
scripts/verify-apk.sh --apk $APK --phonon off
git checkout ../../example/package.json
scripts/check-npm-pack.sh
scripts/check-npm-pack.sh --core --root ../..
# emulator / device run (any adb device; the 16 KB check needs a ps16k image)
scripts/ci-emulator-selftest.sh --apk app-debug.apk --model "$(scripts/fetch-ci-model.sh /tmp/m)" \
  --page-size 4096 --scenarios s3,s6 --require S1_support,S2_init,S3_short_speak,S6_stop
scripts/test-ci-scripts.sh
```

The example app as a whole cannot use the configuration cache (onnxruntime-react-native's build
script is incompatible), so `build-android-phonon` checks it on the add-on module
(`:pocketpalai_react-native-speech-phonon:assembleRelease`, which builds the core too; stored
then reused, no problem from our files) and builds the app without it.

## Device evidence (WP9, design §8.3-§8.5)

| Script | Does |
|---|---|
| `stage-android-model.sh <dir>` | the example's Android download on the host (checkpoint + 8 curated voices, sha256-pinned in `example/src/utils/phononPins.json`) into `<dir>/31m-en`, for phones without internet |
| `collect-android-evidence.sh <serial> <slug> <flavor> --apk <apk>` | one evidence run: install (confirms the HyperOS "Install via USB?" prompt), `device.json`, launch, model push, meminfo before/after, self-test deep link, screenshots + UI dumps at `SCREENSHOT_READY`, maps proof, pid-filtered logcat + crash buffer + new dropbox crashes against the §8.4 regex, the app's `phonon-evidence/<runId>/`, `check.txt` (PASS/FAIL/NOT-RUN per check, §8.3 thresholds). `--scenario S1..S13,U1,U2,U3,F1` picks scenarios, `--dry-run` prints the adb plan, `--selftest` tests the checks offline |

Output lands in the gitignored `docs/evidence/` and is never committed: summarise it in a
PR comment (screenshots via `gh image`).

Evidence APKs (JS always bundled, no Metro; `ci.init.gradle -PrnSpeechCiBundleDebug=true` for
the debug ones):

| Flavor | Build (`cd example/android`; with the add-on: `-PRNSpeech_phononAbis=arm64-v8a`, plus `-PRNSpeech_phononLibDir=$LIBS` for local binaries) |
|---|---|
| `addon` | `assembleRelease -PreactNativeArchitectures=arm64-v8a`, with the add-on |
| `core` | `assembleRelease -PreactNativeArchitectures=arm64-v8a`, after `scripts/example-without-addon.sh` |
| `addon-32bit` | `assembleRelease -PreactNativeArchitectures=armeabi-v7a`, with the add-on (no Phonon library for 32-bit: `unsupported-abi`) |
| `forced-<reason>` | `assembleDebug ... -PRNSpeech_phononForceReason=<reason>` (debug builds only) |
| `negative-control` | `assembleDebug ... -PRNSpeech_phononSkipHwcapGate=true` (N1: the debug probe skips the HWCAP gate; never ship it) |
| debug `addon` | `assembleDebug ...`, with the add-on: run-as maps, and S11's reload half |

```bash
# model for phones without internet (else the app downloads it: --model download)
M="$(scripts/stage-android-model.sh /tmp/phonon-model)"
# the default run (S1-S10, S12), one scenario, the S13 sweep, an unsupported flavor
scripts/collect-android-evidence.sh <serial> <slug> addon --apk addon.apk --model "$M"
scripts/collect-android-evidence.sh <serial> <slug> addon --apk addon.apk --model "$M" --scenario S6
scripts/collect-android-evidence.sh <serial> <slug> addon --apk addon.apk --model "$M" --scenario S13
scripts/collect-android-evidence.sh <serial> <slug> forced-load-failed --apk forced-load-failed.apk
```

Notes from the first device run:

- With `extractNativeLibs=false` the libraries are mmapped from `base.apk`, so
  `/proc/<pid>/maps | grep libptts_ffi` (U1 as first written) is 0 even with the library loaded.
  The maps proof therefore also counts `base.apk` mappings whose file offset is inside
  `lib/<abi>/libptts_ffi.so`'s stored range in the APK, and an initialized supported run must
  see it (else the check is reported blind).
- Release builds have no `run-as`: the self-test copies its evidence folder to the app's
  external files dir (`adb pull`), saves its own `maps.txt`, and installs a pushed model with
  `modelFrom=` (`PhononModelManager.installFromDirectory`: the download's checks, no network).
- S11 is opt-in (`scenarios=s11`): the script backgrounds the app on `S11_BACKGROUND_REQUEST`;
  the reload half needs a debug build (release: `NOT-RUN`), and the next JS context finishes the
  run from a marker file.

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

- `ci.yml` `build-ios-phonon` (written on Linux, never run): Xcode 16.4 exists on `macos-15` and
  ships an iOS 18 simulator; the `simctl` JSON queries find an iOS 18 (and, if any, iOS 17)
  iPhone; `xcodebuild test -only-testing:SpeechExampleTests/PhononTests` passes; the command-line
  `OTHER_LDFLAGS=$(inherited) -all_load` override links; the unsigned Release device builds
  (`CODE_SIGNING_ALLOWED=NO`) succeed and `size -m` prints `Segment __TEXT: <n>` lines the job
  parses; the iOS 17 smoke finds `[SelfTest]` lines with `log show`.
