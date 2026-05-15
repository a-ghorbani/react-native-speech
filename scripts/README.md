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

## Multilingual verification

`verify-supertonic-multilingual.ts` is an ASR round-trip harness for the
Supertonic engine. It does NOT call into the React Native runtime — it
ports the engine's inference path to `onnxruntime-node` and runs against
locally cached v3 model files. The library code is the source of truth;
the harness exists to spot regressions in multilingual output without
needing a device.

**What it does, per language:**

1. Synthesize a canonical test sentence (`scripts/lib/multilingual-test-sentences.ts`).
2. Write 16-bit PCM mono WAV to `scripts/out/<lang>.wav`.
3. Transcribe with `whisper-cli` (whisper.cpp + large-v3 model).
4. Compare transcript to input (Sørensen–Dice bigram similarity).
5. Pass if `sim ≥ 0.6 && rms > 0.01`. Auto-detect-language mismatch
   alone is NOT a failure — see the fallback note below.

**Prereqs (one-time):**

```bash
yarn add -D onnxruntime-node                          # already in devDependencies
brew install whisper-cpp                              # provides /opt/homebrew/bin/whisper-cli
mkdir -p scripts/.cache/whisper scripts/.cache/supertonic-3/onnx scripts/.cache/supertonic-3/voice_styles

# Whisper large-v3 (~3GB) — multilingual ASR
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin \
  -o scripts/.cache/whisper/ggml-large-v3.bin

# Supertonic v3 ONNX + voices (~401MB)
for f in duration_predictor.onnx text_encoder.onnx vector_estimator.onnx \
         vocoder.onnx tts.json unicode_indexer.json; do
  curl -L "https://huggingface.co/Supertone/supertonic-3/resolve/main/onnx/$f" \
    -o "scripts/.cache/supertonic-3/onnx/$f"
done
for v in F1 F2 F3 F4 F5 M1 M2 M3 M4 M5; do
  curl -L "https://huggingface.co/Supertone/supertonic-3/resolve/main/voice_styles/${v}.json" \
    -o "scripts/.cache/supertonic-3/voice_styles/${v}.json"
done
```

Everything in `scripts/.cache/` is gitignored.

**Run:**

```bash
npx tsx scripts/verify-supertonic-multilingual.ts
npx tsx scripts/verify-supertonic-multilingual.ts --langs de,fr,ja      # subset
npx tsx scripts/verify-supertonic-multilingual.ts --voice M1 --steps 16
npx tsx scripts/verify-supertonic-multilingual.ts --skip-whisper        # just WAVs
```

Results: `scripts/out/report.md` (markdown table) and `scripts/out/<lang>.wav`.
Spot-listen with `afplay scripts/out/de.wav`.

**Auto-detect fallback (`⚑` in the report):**

Whisper's language auto-detect is unreliable on short utterances of
close-neighbor pairs (et↔es, sl↔hr, sk↔cs). The harness handles this:

- First pass: `whisper-cli -l auto`.
- If detected language ≠ expected language, retry: `whisper-cli -l <expected>`.
- Score the **forced-retry transcript** against the input. This isolates
  synthesis quality from Whisper's language-id quirks.
- The report marks fallback runs with `⚑` so you can see which languages
  needed it without treating them as failures.

A `⚑` with `sim ≈ 1.00` means "Whisper guessed the wrong language but
transcribed it correctly when told what to listen for" — i.e., the
audio is fine.

**Non-determinism:**

The vector estimator starts from Gaussian noise (`Math.random()`), so
similarity scores drift slightly between runs. Re-running a failing
language usually settles it. If you need reproducible numbers, seed
`Math.random` before invoking `SupertonicNode.synthesize`.

**Adding a new language:** put a short native-orthography sentence in
`scripts/lib/multilingual-test-sentences.ts`. The harness picks it up
on the next run.

**Capturing on-device audio for the same round-trip:** the example app
has a "Save WAV" toggle in the Supertonic controls. When on, every
synthesized chunk is captured via the engine's `onAudioChunk` option
and written to `DocumentDirectoryPath/supertonic-<lang>-<voice>-<ts>.wav`
once Speak completes. The file is identical-format to what this
harness produces (16-bit PCM mono @ 44.1kHz), so you can pull it off
the simulator/device and feed it directly to `whisper-cli`:

```bash
# iOS Simulator
xcrun simctl get_app_container booted <bundle-id> data
# Android emulator
adb shell run-as <pkg> cp files/<file>.wav /sdcard/Download/

whisper-cli -m scripts/.cache/whisper/ggml-large-v3.bin -l <lang> -f <file>.wav
```

Use this to catch drift between the Node harness and the real
on-device synthesis path.
