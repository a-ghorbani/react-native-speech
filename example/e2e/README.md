# End-to-end tests

[Maestro](https://maestro.mobile.dev) flows that drive the example app on a
real Android device or emulator, with the real engines.

- `run.yaml`: entry point. It launches the app, initializes `ENGINE`, and runs the self-test.
- `engine.yaml`: selects and initializes the engine. If the Kitten model is missing, it downloads `nano-int8` (~24 MB).
- `selftest.yaml`: taps **SELFTEST** on the Streaming tab and requires `SELFTEST DONE engine=<engine> passed=N failed=0`.

The scenarios themselves live in `example/src/views/SelfTestPanel.tsx`. They log
`[SelfTest] <name> PASS|FAIL <detail>` lines to logcat (`ReactNativeJS`).

## Run locally

```sh
# build the example (release bundles the JS, so no Metro is needed)
(cd example/android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a)

scripts/e2e-android.sh --install example/android/app/build/outputs/apk/release/app-release.apk Kitten
```

- **Other engines:** pass `Kokoro` or `Supertonic`. Their models must already be downloaded in the app (Manage Models).
- **Several devices:** set `ANDROID_SERIAL`.
- **MIUI and other phones that confirm every USB install:** install Maestro's driver once, then run with `MAESTRO_ARGS=--no-reinstall-driver`.

Results go to `e2e-artifacts/`: JUnit reports, screenshots, `logcat.txt` and `selftest.txt`.

## CI

The `e2e-android` job in `.github/workflows/ci.yml` builds an x86_64 release APK and runs the Kitten flow on an API 34 emulator.

It runs with `XNNPACK=off`, because ONNX Runtime crashes when it creates a session with the XNNPACK provider on the x86_64 emulator. Real arm64 devices run with XNNPACK on.

The CI flow can't cover audio interruptions (the **INTERRUPT** button) or listening quality. Check those on a device.
