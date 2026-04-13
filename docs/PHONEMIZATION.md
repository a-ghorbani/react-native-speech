# Phonemization Implementation

This document explains how phonemization works in react-native-speech.

## Overview

Phonemization converts text to phonemes (IPA — International Phonetic Alphabet)
for neural TTS models like Kokoro and Kitten. This is a **critical step** —
neural TTS models are trained on phonemes, not raw text.

The library ships a **GPL-free** pure-JS phonemization pipeline backed by a
prebuilt IPA dictionary. The dictionary is loaded once via a Turbo Module
(`dictOpen` / `dictLookup`) that mmaps the binary file in native code, so
lookups are zero-allocation on the hot path.

## Architecture

```
Text Input
    ↓
KokoroEngine / KittenEngine (application layer)
    ↓ (TextNormalizer.normalize())
Normalized Text
    ↓
HansPhonemizer (src/phonemization/HansPhonemizer.ts)
    ↓ (per-word lookup + fallback rules)
DictSource  ──── NativeDict (Turbo Module, mmap'd .bin)
    ↓
IPA Phoneme String
    ↓ (optional postProcessPhonemes for Kokoro)
Engine-ready Phonemes
```

**Key design:** Normalization happens at the engine layer
(e.g., `KokoroEngine`), NOT inside the phonemizer.

## Components

### TextNormalizer (`src/engines/kokoro/TextNormalizer.ts`)

Preprocesses text before phonemization. Expands abbreviations, normalizes
quotes/apostrophes, converts years and other numerals to words, and chunks
long input by sentence boundaries.

### HansPhonemizer (`src/phonemization/HansPhonemizer.ts`)

Pure-JS G2P:
1. Tokenizes the normalized text.
2. Looks up each word in the loaded `DictSource`.
3. Falls back to letter-level rules for OOV words.
4. Reassembles the IPA string, preserving punctuation chunks.

An optional `postProcess` hook runs Kokoro-specific phoneme normalizations
(`postProcessPhonemes` from `Phonemizer.ts`).

### DictSource + NativeDict

- `src/phonemization/DictSource.ts` — interface for dictionary backends.
- `src/phonemization/loadNativeDict.ts` — loads the binary dict via the
  Turbo Module (`RNSpeech.dictOpen` / `dictLookup`).
- `cpp/native_dict.{h,cpp}` — mmap-backed `.bin` reader (EPD1 format).
- `ios/NativeDictWrapper.{h,mm}` and
  `android/src/main/cpp/native_dict_jni.cpp` — platform glue.

The `.bin` is built from TSV sources under `third-party/phonemizer-dicts/`
via `node scripts/build-dict.mjs`.

### createPhonemizer factory

```ts
import {createPhonemizer} from '@mhpdev/react-native-speech';

const phonemizer = createPhonemizer('js', {dict});
const phonemes = await phonemizer.phonemize('hello world', 'en-us');
```

Available types:

- `'js'` — `HansPhonemizer` with Kokoro post-processing (default).
- `'js-ipa'` — `HansPhonemizer` returning raw IPA, no post-processing.
- `'none'` — pass-through (text returned unchanged).

## Best Practices

```ts
import {
  createPhonemizer,
  TextNormalizer,
  loadNativeDict,
} from '@mhpdev/react-native-speech';

const dict = await loadNativeDict(dictPath);
const phonemizer = createPhonemizer('js', {dict});
const normalizer = new TextNormalizer();

const normalized = normalizer.normalize(input);
for (const chunk of normalizer.chunkBySentences(normalized, 1000)) {
  const phonemes = await phonemizer.phonemize(chunk, 'en-us');
  await synthesize(phonemes);
}
```

## References

- [Kokoro TTS](https://github.com/thewh1teagle/kokoro-js)
- [IPA Chart](https://www.internationalphoneticassociation.org/content/ipa-chart)
