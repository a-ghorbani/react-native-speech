#!/usr/bin/env node
/**
 * Characterization baseline for the Kokoro + Kitten text pipelines on
 * markdown input. Captures BOTH paths the app exercises:
 *
 *   1. Non-streaming: `Speech.speak(text)` → engine `doSynthesize` →
 *      per-engine chunker (`chunkBySentencesWithMetadata` for Kokoro,
 *      `chunkTextWithPositions` for Kitten).
 *   2. Streaming:    `Speech.createSpeechStream()` → engine
 *      `synthesizeStream` → `MarkdownStreamBuffer` (when markdown stripping
 *      is on) → `StreamingChunker`.
 *
 * Production-faithful choices:
 *   - Loads the real en-us dict from the `palshub/phonemizer-dicts` TSV
 *     (path via PHONEMIZER_DICTS_DIR, default /Users/aghorbani/codes/
 *     phonemizer-dicts). Matches the native `.bin` content entry-for-entry.
 *   - Uses the same `maxChunkSize` the example app passes at the streaming
 *     screen: Kokoro 100, Kitten 500.
 *   - Simulates token-at-a-time LLM append by splitting the sample into
 *     short fragments before feeding the stream.
 *
 * Reproducibility:
 *   - Requires `yarn prepare` to have produced `lib/module/`.
 *   - Auto-applies a one-line runtime patch to
 *     `lib/module/phonemization/HansPhonemizer.js` so the compiled ESM can
 *     resolve `require('phonemize')` — bare `require` is undefined in ESM,
 *     but `globalThis.require` works once we set it with `createRequire`.
 *     `lib/` is gitignored; the patch is idempotent and re-applied every
 *     run.
 *
 * Env:
 *   BASELINE_STRIP=0  → capture the pre-fix shape (stripMarkdown disabled)
 *   BASELINE_STRIP=1  → capture the post-fix shape (default)
 *   PHONEMIZER_DICTS_DIR → override dict location
 */
import {createRequire} from 'node:module';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

globalThis.require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LIB = resolve(ROOT, 'lib/module');

// ─── Pre-flight: auto-patch HansPhonemizer for ESM `require` ──────────────
// The compiled lib uses bare `require('phonemize')`. In ESM that's a
// ReferenceError. Patch to `globalThis.require('phonemize')` — same
// behavior on device (Metro provides `require`), and works under Node
// since we set globalThis.require above.
const HANS_PATH = `${LIB}/phonemization/HansPhonemizer.js`;
if (!existsSync(HANS_PATH)) {
  console.error(`ERROR: ${HANS_PATH} not found. Run \`yarn prepare\` first.`);
  process.exit(1);
}
{
  let src = readFileSync(HANS_PATH, 'utf8');
  if (src.includes("require('phonemize')") && !src.includes("globalThis.require('phonemize')")) {
    src = src.replace(
      "require('phonemize')",
      "globalThis.require('phonemize')",
    );
    writeFileSync(HANS_PATH, src, 'utf8');
    console.log(`[patch] applied globalThis.require shim to ${HANS_PATH}`);
  }
}

const {TextNormalizer} = await import(
  `${LIB}/engines/kokoro/TextNormalizer.js`
);
const {HansPhonemizer} = await import(
  `${LIB}/phonemization/HansPhonemizer.js`
);
const {JsDictSource} = await import(`${LIB}/phonemization/JsDictSource.js`);
const {postProcessPhonemes} = await import(
  `${LIB}/engines/kokoro/Phonemizer.js`
);
const {TextPreprocessor} = await import(
  `${LIB}/phonemization/KittenPreprocessor.js`
);
const {chunkTextWithPositions} = await import(
  `${LIB}/engines/kitten/chunkTextWithPositions.js`
);
const {StreamingChunker} = await import(
  `${LIB}/engines/StreamingChunker.js`
);
const {stripMarkdown, createMarkdownStreamBuffer} = await import(
  `${LIB}/utils/stripMarkdown.js`
);

const STRIP = process.env.BASELINE_STRIP !== '0';

// ─── Dict: production-faithful JsDictSource from TSV ─────────────────────
const DICTS_DIR =
  process.env.PHONEMIZER_DICTS_DIR ||
  '/Users/aghorbani/codes/phonemizer-dicts';
const TSV_PATH = resolve(DICTS_DIR, 'en-us.tsv');
if (!existsSync(TSV_PATH)) {
  console.error(
    `ERROR: en-us.tsv not found at ${TSV_PATH}. Set PHONEMIZER_DICTS_DIR or clone palshub/phonemizer-dicts there.`,
  );
  process.exit(1);
}
const dictMap = Object.create(null);
for (const line of readFileSync(TSV_PATH, 'utf8').split('\n')) {
  if (!line) continue;
  const tab = line.indexOf('\t');
  if (tab > 0) dictMap[line.slice(0, tab)] = line.slice(tab + 1);
}
const dict = new JsDictSource(dictMap);
console.log(
  `[dict] loaded ${Object.keys(dictMap).length} entries from ${TSV_PATH} (${statSync(TSV_PATH).size} bytes)`,
);

// Sanity check that hans00 is reachable — prod path needs it for OOV words.
const phonemize = globalThis.require('phonemize');
if (!phonemize || typeof phonemize.toIPA !== 'function') {
  console.error('ERROR: phonemize package did not load.');
  process.exit(1);
}
console.log(
  `[phonemize] loaded, toIPA("when") = ${phonemize.toIPA('when')}`,
);

// ─── Sample ──────────────────────────────────────────────────────────────
const MARKDOWN_SAMPLE = `When we say someone is a **"knockout,"** it can mean different things depending on the context. Here are the most common interpretations:

---

### 1. **In Sports (especially boxing or combat sports):**
- A **knockout** is when a fighter is **defeated by a punch or other strike**, resulting in the other fighter being **unconscious** or **unable to continue**.
- For example:
  > "He put on a clinic and knocked out his opponent in the third round."

---

### 2. **In General Language (slang):**
- **"Knockout"** is often used **colloquially** to mean **someone who is extremely attractive, confident, or impressive**.
- It's typically a **compliment** or **expression of admiration**.
- For example:
  > "She was a knockout at the party—everyone was talking about her."

---

### 3. **In Psychology (a "knockout" in a lab):**
- A **knockout** refers to a **genetically modified animal** that is **lack of a particular gene**, making it **unresponsive to a drug or stimulus**.
- Used in research to study the function of genes.
- For example:
  > "The knockout mice showed no response to the drug, helping scientists understand its mechanism."

---

### 4. **In Business or Marketing (a "knockout product"):**
- A **knockout product** is one that **stands out dramatically** and **immediately captures attention**.
- It might be a new item or a service that **dominates the market** or is **remarkably effective**.

---

### Summary:
| Context | Meaning |
|----------------|-------------------------------------------------------------------------|
| **Sports** | A fighter who is knocked out (unconscious or unable to continue) |
| **General** | Someone who is extremely attractive, confident, or impressive |
| **Psychology** | A genetically modified animal that is unresponsive to a stimulus |
| **Business** | A product or service that makes a strong, striking impression |

Let me know if you want to explore a specific context!`;

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Split a string into small fragments the way a streaming LLM would emit
 * tokens — ~4 chars apart, breaking at whitespace when possible.
 */
function splitLikeLlm(text, approxSize = 4) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + approxSize, text.length);
    // Prefer a whitespace boundary to avoid mid-word fragments — LLMs
    // typically produce tokens that align with word-ish boundaries.
    while (end < text.length && !/\s/.test(text[end]) && end - i < approxSize * 2) {
      end++;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** Drain a StreamingChunker to completion, returning all chunks in order. */
async function drainChunker(chunker) {
  const chunks = [];
  for (;;) {
    const c = await chunker.getNextChunk();
    if (c === null) break;
    chunks.push(c);
  }
  return chunks;
}

// ─── Pipelines ───────────────────────────────────────────────────────────

async function captureKokoroNonStream(text) {
  const normalizer = new TextNormalizer();
  const phonemizer = new HansPhonemizer({dict, postProcess: postProcessPhonemes});
  const input = STRIP ? stripMarkdown(text) : text;
  // Non-streaming engine uses maxChunkSize = 500 by default in config
  // wiring at KokoroEngine.ts; engine default constant is 400 but the
  // example/app path passes 100 — we capture with 400 (engine default) for
  // the non-streaming path since that's what `speak(long text)` uses.
  const chunks = normalizer.chunkBySentencesWithMetadata(input, 400);
  const out = [];
  for (const chunk of chunks) {
    const normalized = normalizer.normalize(chunk.text);
    const ipa = await phonemizer.phonemize(normalized, 'en-us');
    out.push({
      rawChunk: chunk.text,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
      normalized,
      ipa,
    });
  }
  return out;
}

async function captureKittenNonStream(text) {
  const preprocessor = new TextPreprocessor({removePunctuation: false});
  const phonemizer = new HansPhonemizer({dict});
  const input = STRIP ? stripMarkdown(text) : text;
  const chunks = chunkTextWithPositions(input, 500);
  const out = [];
  for (const chunk of chunks) {
    const processed = preprocessor.process(chunk.text);
    const ipa = await phonemizer.phonemize(processed, 'en-us');
    out.push({
      rawChunk: chunk.text,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
      processed,
      ipa,
    });
  }
  return out;
}

async function captureKokoroStream(text) {
  // Example app: Kokoro streams with maxChunkSize=100.
  const normalizer = new TextNormalizer();
  const phonemizer = new HansPhonemizer({dict, postProcess: postProcessPhonemes});
  const chunker = new StreamingChunker(100);
  const mdBuffer = STRIP ? createMarkdownStreamBuffer() : null;
  // Producer: simulate LLM token stream.
  for (const frag of splitLikeLlm(text)) {
    if (mdBuffer) {
      const emit = mdBuffer.push(frag);
      if (emit) chunker.append(emit);
    } else {
      chunker.append(frag);
    }
  }
  if (mdBuffer) {
    const tail = mdBuffer.flush();
    if (tail) chunker.append(tail);
  }
  chunker.finalize();
  const chunks = await drainChunker(chunker);
  const out = [];
  for (const chunk of chunks) {
    const normalized = normalizer.normalize(chunk.text);
    const ipa = await phonemizer.phonemize(normalized, 'en-us');
    out.push({
      rawChunk: chunk.text,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
      normalized,
      ipa,
    });
  }
  return out;
}

async function captureKittenStream(text) {
  // Example app: Kitten streams with maxChunkSize=500.
  const preprocessor = new TextPreprocessor({removePunctuation: false});
  const phonemizer = new HansPhonemizer({dict});
  const chunker = new StreamingChunker(500);
  const mdBuffer = STRIP ? createMarkdownStreamBuffer() : null;
  for (const frag of splitLikeLlm(text)) {
    if (mdBuffer) {
      const emit = mdBuffer.push(frag);
      if (emit) chunker.append(emit);
    } else {
      chunker.append(frag);
    }
  }
  if (mdBuffer) {
    const tail = mdBuffer.flush();
    if (tail) chunker.append(tail);
  }
  chunker.finalize();
  const chunks = await drainChunker(chunker);
  const out = [];
  for (const chunk of chunks) {
    const processed = preprocessor.process(chunk.text);
    const ipa = await phonemizer.phonemize(processed, 'en-us');
    out.push({
      rawChunk: chunk.text,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
      processed,
      ipa,
    });
  }
  return out;
}

// ─── Drive ───────────────────────────────────────────────────────────────

const kokoroNonStream = await captureKokoroNonStream(MARKDOWN_SAMPLE);
const kokoroStream = await captureKokoroStream(MARKDOWN_SAMPLE);
const kittenNonStream = await captureKittenNonStream(MARKDOWN_SAMPLE);
const kittenStream = await captureKittenStream(MARKDOWN_SAMPLE);

const baseline = {
  meta: {
    description:
      'Characterization of Kokoro + Kitten text pipelines on markdown input. Captures both non-streaming (Speech.speak) and streaming (Speech.createSpeechStream) paths with the real en-us dict. Compare before-fix vs after-fix files.',
    sampleLength: MARKDOWN_SAMPLE.length,
    stripMarkdownApplied: STRIP,
    dictEntries: Object.keys(dictMap).length,
    dictPath: TSV_PATH,
    kokoroStreamMaxChunkSize: 100,
    kittenStreamMaxChunkSize: 500,
    generator: 'scripts/capture-markdown-baseline.mjs',
  },
  sample: MARKDOWN_SAMPLE,
  kokoro: {
    nonStreaming: {chunkCount: kokoroNonStream.length, chunks: kokoroNonStream},
    streaming: {chunkCount: kokoroStream.length, chunks: kokoroStream},
  },
  kitten: {
    nonStreaming: {chunkCount: kittenNonStream.length, chunks: kittenNonStream},
    streaming: {chunkCount: kittenStream.length, chunks: kittenStream},
  },
};

const outDir = resolve(ROOT, 'src/__tests__/__fixtures__');
mkdirSync(outDir, {recursive: true});
const fileName = STRIP
  ? 'markdown-baseline.after-fix.json'
  : 'markdown-baseline.before-fix.json';
const outPath = resolve(outDir, fileName);
writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');

console.log(`[baseline] written: ${outPath} (strip=${STRIP})`);
console.log(
  `  Kokoro non-stream=${kokoroNonStream.length}, stream=${kokoroStream.length}`,
);
console.log(
  `  Kitten non-stream=${kittenNonStream.length}, stream=${kittenStream.length}`,
);
