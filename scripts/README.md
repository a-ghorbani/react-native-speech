# Scripts

Utility scripts for development, benchmarking, and asset preparation.

## Build

- `build-dict.mjs` — Build the binary phonemizer dictionary (`.bin`) from
  the TSV source. The TSV is not vendored in this repo (the data is
  espeak-ng-derived and this repo is MIT). Clone
  https://huggingface.co/datasets/palshub/phonemizer-dicts somewhere and
  point `PHONEMIZER_DICTS_DIR` at it, e.g.

  ```bash
  git clone https://huggingface.co/datasets/palshub/phonemizer-dicts ~/codes/phonemizer-dicts
  PHONEMIZER_DICTS_DIR=~/codes/phonemizer-dicts yarn build:dict
  ```

  Both `.tsv` (input) and `.bin` (output) live in that directory; push
  back to HuggingFace from there.
- `convert-kitten-voices.py` — Convert Kitten TTS voice embeddings.

## Benchmarking

- `benchmark-run.sh` — Top-level benchmark driver.
- `benchmark-ios.sh` — iOS device benchmark with Instruments traces.
- `benchmark-android.sh` — Android device benchmark with `atrace` / Perfetto.
- `benchmark-compare.py` — Compare benchmark runs.
- `extract-trace-table.py` — Parse xctrace XML exports into a flat CSV.

## Tests

- `test-ios.sh` / `test-android.sh` — Run the example app's native tests.
