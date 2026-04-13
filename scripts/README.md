# Scripts

Utility scripts for development, benchmarking, and asset preparation.

## Build

- `build-dict.mjs` — Build the binary phonemizer dictionary (`.bin`) from
  the TSV source under `third-party/phonemizer-dicts/`.
- `convert-kitten-voices.py` — Convert Kitten TTS voice embeddings.

## Benchmarking

- `benchmark-run.sh` — Top-level benchmark driver.
- `benchmark-ios.sh` — iOS device benchmark with Instruments traces.
- `benchmark-android.sh` — Android device benchmark with `atrace` / Perfetto.
- `benchmark-compare.py` — Compare benchmark runs.
- `extract-trace-table.py` — Parse xctrace XML exports into a flat CSV.

## Tests

- `test-ios.sh` / `test-android.sh` — Run the example app's native tests.
