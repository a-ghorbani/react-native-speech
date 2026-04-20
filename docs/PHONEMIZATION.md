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

#### Per-word resolution layers

Each word passes through an ordered cascade of layers. The first layer that
produces a match wins; its output is the IPA for that word. Later layers run
only for tokens the earlier layers didn't resolve.

```
┌────────────────────────────────────────────────────────────────────────┐
│  INPUT: one word (e.g. "Hmm", "himm", "ML", "PrismML", "Qwen")         │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
         clean = word.toLowerCase().replace(/[^a-z']/g, '')
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1.  REDUCED_FORMS                                                │
│   { a: 'ɐ', to: 'tə', has: 'hɐz' }                                     │
│   Function-word shortcuts. Hits → return immediately.                  │
└────────────────────────────────────────────────────────────────────────┘
                              │ miss
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1b. DICT_OVERRIDES (transient bugfix hatch, empty by default)    │
│   Patch a known-wrong dict entry while the upstream fix is in flight.  │
│   Hits → return override IPA. Dict is otherwise authoritative.         │
└────────────────────────────────────────────────────────────────────────┘
                              │ miss
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 2.  Dict lookup (en-us.bin, mmap'd)                              │
│   ~124K English words incl. common acronyms (API, CPU, XML, USA).      │
│   Hits → set ipa = dict value.                                         │
└────────────────────────────────────────────────────────────────────────┘
                              │ miss
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 3.  Hyphen-split compound                                        │
│   "open-source" → lookup each piece in dict, join phonemes.            │
└────────────────────────────────────────────────────────────────────────┘
                              │ no match
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 4.  Possessive fallback                                          │
│   "iOS's" → dict["ios"] + "ɪz"                                         │
└────────────────────────────────────────────────────────────────────────┘
                              │ no match
                              ▼
                  ┌───────────┴───────────┐
                  │                       │
         hans00 available?         hans00 unavailable
         (RELEASE build)           (Hermes DEBUG / jest)
                  │                       │
                  ▼                       ▼
┌──────────────────────────┐   ┌──────────────────────────────┐
│ Layer 5.  hans00 G2P     │   │ Layer 5b. Dict-only spellout │
│                          │   │                              │
│ g2p = hans00.toIPA(word) │   │ if shouldSpellOut:           │
│                          │   │   spell letter-by-letter     │
│ if shouldSpellOut:       │   │   via dict["a"…"z"]          │
│   override with letter-  │   │                              │
│   spellout               │   │ else:                        │
│ else:                    │   │   return word (passthrough)  │
│   use g2p                │   │                              │
└──────────────────────────┘   └──────────────────────────────┘
                  │                       │
                  └───────────┬───────────┘
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 6.  Per-word destress                                            │
│   FULLY_UNSTRESSED (the, of, a…) → strip ˈˌ                            │
│   SECONDARY_STRESSED (but, not, how…) → ˈ → ˌ                          │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                         OUTPUT IPA
```

#### Layer details

**Layer 1 — REDUCED_FORMS.** A handful of English function words whose
canonical dict pronunciation (`the → ðiː`, `to → tuː`, `a → eɪ`) sounds
wrong in running speech. This layer forces the reduced form used in
connected speech.

- `a` → `ɐ` (not `eɪ`)
- `to` → `tə` (not `tuː`)
- `has` → `hɐz` (not `hæz`)

**Layer 1b — DICT_OVERRIDES.** A transient bugfix hatch, not a pronunciation
store. Runs before the dict lookup so an entry here overrides the dict.
Use only to patch a known-wrong upstream dict entry while the dict fix
is in flight; each entry should have a TODO pointing at the upstream
change that will let us remove it.

**Currently empty.** Pronunciations live in the dict. The palshub dict
update on 2026-04-20 absorbed what was previously a hand-curated
interjection overlay (`hmm`, `mhm`, `shh`, `mmm`, `pfft`, `brr`, `psst`,
`ew`) — those are now regular dict entries, looked up at Layer 2.

General-purpose pronunciation additions belong in the dict, not here.
An in-code override map that grows over time becomes a parallel source
of truth and silently diverges from the dict.

**Layer 2 — Dict lookup.** The mmap'd `en-us.bin` contains ~124K English
words with pre-computed IPA, including most common acronyms (`api`, `cpu`,
`xml`, `usa`, `nasa`, …). This is the hot path for the vast majority of
input.

- `hello` → `həlˈoʊ`
- `world` → `wˈɜːld`
- `cat`, `cats` → `kˈæt`, `kˈæts`
- `API` → `ˌeɪpˌiːˈaɪ` (dict pre-spells common acronyms)
- `NASA` → `nˈæsɐ` (dict treats as a word)

**Layer 3 — Hyphen-split.** For hyphenated words that aren't in the dict
as a whole, try looking up each piece separately and concatenate.

- `open-source` → dict["open"] + dict["source"]
- `self-host` → dict["self"] + dict["host"]

**Layer 4 — Possessive fallback.** If the word ends in `'s` and the stem
is in the dict, append the `ɪz` plural-possessive ending.

- `iOS's` → dict["ios"] + `ɪz` = `ˌaɪˌoʊˈɛs` + `ɪz` = `ˌaɪˌoʊˈɛsɪz`

**Layer 5 / 5b — G2P fallback.** Only reached for OOV words (not in any
prior layer). Two sub-cases depending on the runtime:

- **Release build (hans00 available):** call the `phonemize` G2P library.
  If the word is a short all-caps acronym (`GPU`, `NSA`, `AWS`), override
  hans00 with a letter-by-letter spellout — the typographic signal is
  stronger than G2P guesses for never-seen acronyms.
- **Debug build / jest (hans00 unavailable):** fall back to letter-by-letter
  spellout using single-letter dict entries for phonotactically
  unpronounceable tokens (`ml`, `xlm`) or short all-caps acronyms (`GPU`).
  Everything else passes through unchanged.

`shouldSpellOut` = the word has no vowel in its first 4 characters
(phonotactic "unpronounceable" — standard Maximal-Onset-Principle
reasoning) **OR** it is a 2–4 character all-caps token (user-typed
acronym signal).

Examples:

- `ml` → `ˈɛm ˈɛl` (no vowel → spell out)
- `xlm` → `ˈɛks ˈɛl ˈɛm`
- `GPU` → `dʒˌiː pˌiː jˈuː` (all-caps short → spell out, regardless of
  hans00 output)
- `AWS` → `ˈeɪ dˈʌbəljˌuː ˈɛs` (overrides hans00's wrong `ˈɔz`)
- `himm` → `hɪm` in release (hans00 G2P) / `himm` passthrough in debug
  (has a vowel, not an acronym — safe to defer)
- `Qwen` → hans00 G2P in release / `Qwen` passthrough in debug
- `Kokoro` → hans00 G2P in release / `Kokoro` passthrough in debug
  (long OOV; both paths avoid spellout)

**Layer 6 — Per-word destress.** Drops or demotes stress marks on
function words that shouldn't carry primary stress in running speech.
Applied to the phonemes produced by any earlier layer.

- `the` → unstressed (strip `ˈˌ`)
- `but` → secondary-stressed (`ˈ` → `ˌ`)
- `him` → secondary-stressed

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
import {createPhonemizer} from '@pocketpalai/react-native-speech';

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
} from '@pocketpalai/react-native-speech';

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
