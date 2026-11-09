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

## Playback-edges suite

`example/src/selftest/edgesSelfTest.ts` probes playback edge cases (issue #45). It starts from a deep link:

```sh
scripts/e2e-edges-android.sh --install example/android/app/build/outputs/apk/release/app-release.apk \
  'engine=kitten&download=1&seed=1&iterations=200&soak=500'
```

- **Scenarios:** `cold`, `resolve`, `stop`, `pause_tail`, `interrupt`, `route`, `mic`, `fuzz` and `soak`. The default runs all of them. Pick some with `scenarios=stop,pause_tail`.
- **Engines:** `engine=kitten` (pass `download=1` to fetch `nano-int8`), `kokoro`, `supertonic`, `phonon`, or `current` (whatever the SYS tab initialized).
- **Cold run:** pass `--cold` to force-stop the app first. Then `cold` is the first audio of a fresh process after the first engine init.
- **Fuzz repro:** each failing iteration logs its ops and a deep link. For example, `scenarios=fuzz&seed=1&fuzzIter=17` replays iteration 17 alone.
- **Thresholds:** `tolMs` (default 50) is the slack allowed when checking that a chunk finishes no earlier than its PCM duration plus the output latency. `settleTimeoutMs` defaults to 20000 and `memGrowthMb` to 100. Every margin is logged, so you can read the numbers whether or not the gate passes.

The suite prints `[SelfTest] E<n>_<name> PASS|FAIL|SKIP <detail>` and one `[SelfTest] EDGE {...}` line per run. It ends with `SELFTEST DONE suite=edges engine=<id> passed=N failed=N skipped=N`. The full per-run JSON (every event time, the PCM duration of each chunk, and the output latency) goes to `edges-evidence/<runId>/runs.jsonl` in the app's external files dir. The script pulls it into `e2e-artifacts/edges/`.

The script grants `RECORD_AUDIO` for the mic scenario, then revokes it unless the app already had it. `edges.yaml` runs the same deep link under Maestro, using `--env EDGES_QUERY=...`.

On iOS, open `speechexample://selftest?suite=edges&...` with `devicectl device process launch --payload-url`. The evidence lands in the app's `Documents/edges-evidence/`. Results and the DONE line are also logged as `[BENCH]` `EDGE_RESULT`/`EDGE_DONE` markers, which reach the device log in Release builds, and are written to `Documents/benchmark-markers.json`.

## CI

The `e2e-android` job in `.github/workflows/ci.yml` builds an x86_64 release APK and runs the Kitten flow on an API 34 emulator.

It runs with `XNNPACK=off`, because ONNX Runtime crashes when it creates a session with the XNNPACK provider on the x86_64 emulator. Real arm64 devices run with XNNPACK on.

The CI flow can't cover audio interruptions (the **INTERRUPT** button) or listening quality. Check those on a device.
