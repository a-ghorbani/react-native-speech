# Kokoro TTS Tests

## Phase 1: Phonemization

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PHONEMIZATION PIPELINE                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   input ──► normalize ──► split ──► espeak-ng ──► rejoin ──► postProcess│
│             (JS)         (JS)      (Native)       (JS)       (JS)       │
│                                                                         │
│   "(Hello)"  "«Hello»"   ["«","Hello","»"]  ["«","həlˈoʊ","»"]          │
│                                         → "«həlˈoʊ»" → "«həlˈoʊ»"       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     CONTRACT TESTING ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│                         SHARED FIXTURE (Contract)                       │
│                                 │                                       │
│               ┌─────────────────┴─────────────────┐                     │
│               ▼                                   ▼                     │
│   Jest (JS)                          XCTest/JUnit (Native)              │
│   ─────────                          ────────────────────               │
│   • input → normalized               • chunk.text → chunk.phoneme       │
│   • normalized → chunks                (for each non-punctuation chunk) │
│   • chunks → rejoined                                                   │
│   • rejoined → postProcessed                                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Shared Fixture

`src/engines/kokoro/__tests__/fixtures/phonemization-cases.json`

| Field | Description |
|-------|-------------|
| input | Original text |
| normalized | After TextNormalizer |
| chunks | Array of {text, isPunctuation, phoneme} after split |
| postProcessed | Final kokoro.js output (must match 1:1) |

**Native tests** iterate through `chunks` and test each non-punctuation chunk:
- Input: `chunk.text`
- Expected: `chunk.phoneme`

Reference: https://github.com/hexgrad/kokoro/blob/main/kokoro.js/tests/phonemize.test.js

### Test Files

| Test | File |
|------|------|
| Normalization (Jest) | `src/engines/kokoro/__tests__/TextNormalizer.test.ts` |
| Split/Rejoin (Jest) | `src/engines/kokoro/__tests__/Phonemizer.test.ts` |
| Post-processing (Jest) | `src/engines/kokoro/__tests__/Phonemizer.test.ts` |
| espeak-ng (iOS) | `example/ios/SpeechExampleTests/EspeakWrapperTests.m` |
| espeak-ng (Android) | `android/src/test/java/com/speech/EspeakNativeTest.kt` |

### Commands

```bash
yarn test:kokoro   # Jest: normalization + split/rejoin + post-processing
yarn test:ios      # iOS: espeak-ng wrapper
yarn test:android  # Android: espeak-ng wrapper
yarn test:native   # Both native tests
```
