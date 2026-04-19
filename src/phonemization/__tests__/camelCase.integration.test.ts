/**
 * End-to-end integration test for camelCase / PascalCase phonemization.
 *
 * Unlike `HansPhonemizer.test.ts`, this file does NOT mock `phonemize` —
 * it loads the real hans00 G2P library so we catch regressions in the full
 * pipeline (splitter + dict lookup + hans00 fallback).
 *
 * Mirrors how production composes the steps: TextNormalizer (Kokoro) and
 * TextPreprocessor (Kitten) call `splitCamelCase` before handing text to
 * `HansPhonemizer.phonemize`. We compose the same two functions here so the
 * test stays faithful to production wiring — `HansPhonemizer` is a pure
 * phonemizer and does not split internally.
 *
 * Why a child_process? The `phonemize` package's bundled English G2P table
 * declares `const ..., jest=`ˈdʒɛst`, ...` (the word "jest" as a dictionary
 * key). Jest wraps every loaded module in a function whose parameters
 * include `jest`, which collides with this bare identifier and raises
 *   "Identifier 'jest' has already been declared"
 * Spawning a clean Node process avoids the wrapper entirely.
 *
 * Assertions are intentionally substring-based, not exact-string. The exact
 * IPA from hans00 can shift across versions; we only care that:
 *   1. CamelCase words get split (presence of a space in the output).
 *   2. Each split part produces non-jammed, plausible phonemes
 *      (e.g. PrismML → contains "pɹɪzəm" AND letter sounds for M/L).
 *   3. Words we explicitly DON'T want split stay as a single phoneme blob.
 *
 * If hans00 ever updates its English G2P, expect to revisit the substring
 * checks — but the structural assertions (split / no-split) should hold.
 */

import {execFileSync} from 'node:child_process';
import * as path from 'node:path';

import {HansPhonemizer} from '../HansPhonemizer';
import {splitCamelCase} from '../splitCamelCase';
import type {DictSource} from '../DictSource';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Run a single phonemize() call in a clean Node subprocess and return the IPA.
// Cached per-word so the suite stays fast despite the per-call fork.
// Prefixed `mock` so jest.mock() can reference it (jest hoists mock factories
// to the top of the file and disallows non-mock-prefixed references).
const mockIpaCache = new Map<string, string>();

function mockRealToIPA(word: string): string {
  const cached = mockIpaCache.get(word);
  if (cached !== undefined) return cached;

  const script = `
    const { toIPA } = require('phonemize');
    const w = process.argv[1];
    process.stdout.write(toIPA(w, { stripStress: false }));
  `;
  const out = execFileSync(process.execPath, ['-e', script, word], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  mockIpaCache.set(word, out);
  return out;
}

// Tiny dict — enough to exercise dict-hit + hans00-fallback paths.
// Keep entries minimal so OOV behavior is visible in the test output.
const DICT: Record<string, string> = {
  prism: 'pɹˈɪzəm',
  parser: 'pˈɑːɹsɚ',
  strand: 'stɹˈænd',
  hello: 'həlˈoʊ',
  world: 'wˈɜːld',
};

function makeDict(map: Record<string, string>): DictSource {
  return {
    lookup: (w: string) => map[w] ?? null,
    size: () => Object.keys(map).length,
  };
}

// Stub `phonemize` inside the jest VM with a bridge to the subprocess. This
// avoids the bundle's `const jest = ...` collision while still exercising
// real hans00 output for OOV words.
jest.mock(
  'phonemize',
  () => ({
    toIPA: (w: string, _opts?: {stripStress?: boolean}) => mockRealToIPA(w),
  }),
  {virtual: true},
);

describe('HansPhonemizer + real hans00 — camelCase regression matrix', () => {
  let phon: HansPhonemizer;

  beforeAll(() => {
    phon = new HansPhonemizer({dict: makeDict(DICT)});
  });

  // Exact composition the engine preprocessors use: split first, then
  // phonemize. Keeps the test honest to production wiring — HansPhonemizer
  // does NOT split internally; the splitter is a normalizer-stage step.
  const phonemize = (text: string) =>
    phon.phonemize(splitCamelCase(text), 'en-us');

  // Kitten-style composition: split → lowercase → phonemize. Catches the
  // class of bugs where lowercasing strips the acronym signal hans00 needs
  // to spell letters out (e.g. "PrismML" → "prism ml" → hans00 echoes "ml").
  const phonemizeKittenStyle = (text: string) =>
    phon.phonemize(splitCamelCase(text).toLowerCase(), 'en-us');

  describe('words that SHOULD split (the bug we fixed)', () => {
    test('PrismML → "prism" + spelled-out "ML"', async () => {
      const out = await phonemize('PrismML');
      // Splitter ran (output has internal whitespace separating parts)
      expect(out).toMatch(/\s/);
      // Dict-hit for "prism"
      expect(out).toContain('pɹˈɪzəm');
      // Hans00 spells out "ML" — output should include the "ɛ" vowel
      // (M=em, L=el — both contain ɛ in IPA)
      expect(out).toMatch(/ɛ/);
    });

    test("prismML → same as PrismML (case shouldn't matter for the split)", async () => {
      const out = await phonemize('prismML');
      expect(out).toMatch(/\s/);
      expect(out).toContain('pɹˈɪzəm');
      expect(out).toMatch(/ɛ/);
    });

    test('XMLParser → "XML" spelled out + "parser"', async () => {
      const out = await phonemize('XMLParser');
      expect(out).toMatch(/\s/);
      expect(out).toContain('pˈɑːɹsɚ');
      // XML letter-by-letter — should include "ɛk" (X=ex)
      expect(out).toMatch(/ɛk/);
    });

    test('myXMLParser → both rules combine', async () => {
      const out = await phonemize('myXMLParser');
      // 3 chunks (my / XML / Parser) → ≥2 internal spaces
      const spaces = (out.match(/\s/g) || []).length;
      expect(spaces).toBeGreaterThanOrEqual(2);
      expect(out).toContain('pˈɑːɹsɚ');
    });

    test('DNAStrand → "DNA" spelled out + "strand" from dict', async () => {
      const out = await phonemize('DNAStrand');
      expect(out).toMatch(/\s/);
      expect(out).toContain('stɹˈænd');
    });

    test("iOS's → 'i' + 'OS' + possessive", async () => {
      const out = await phonemize("iOS's");
      expect(out).toMatch(/\s/);
      // Possessive ɪz suffix
      expect(out).toMatch(/ɪz|s/);
    });
  });

  describe('words that must NOT split (would regress if they did)', () => {
    // For each, assert the output is a single token (no internal spaces).
    // Pre-verified against the real package — none of these contain a
    // space in their hans00 output.
    test.each([
      'iPhone',
      'iCloud',
      'iPad',
      'McDonald',
      'MacBook',
      'MyClass',
      'JavaScript',
      'GitHub',
      'TypeScript',
      'PowerShell',
    ])('%s stays as a single token (no whitespace inserted)', async word => {
      const out = await phonemize(word);
      expect(out).not.toMatch(/\s/);
    });
  });

  describe('all-caps and trivial tokens (no-op)', () => {
    test.each(['USA', 'HTTP', 'OK'])(
      '%s is phonemized as a single token',
      async word => {
        const out = await phonemize(word);
        expect(out).not.toMatch(/\s/);
        // Should produce real IPA, not the original word
        expect(out).not.toBe(word);
      },
    );
  });

  describe('sentence-level integration', () => {
    test('CamelCase tokens inside a sentence split correctly', async () => {
      const out = await phonemize('hello PrismML world');
      expect(out).toContain('həlˈoʊ');
      expect(out).toContain('pɹˈɪzəm');
      expect(out).toContain('wˈɜːld');
    });
  });

  describe('Kitten-style pipeline (split + lowercase + phonemize)', () => {
    // These verify the acronym-fallback fix: even after lowercase strips
    // the acronym signal, the phonemizer must produce clean IPA — no
    // literal letter characters leaking into the phoneme stream.
    test.each([
      ['PrismML', 'pɹˈɪzəm'], // dict-hit for "prism" still works
      ['prismML', 'pɹˈɪzəm'],
      ['XMLParser', 'pˈɑːɹsɚ'], // dict-hit for "parser"
    ])(
      '%s — broken hans00 echo for lowercased acronym is fixed',
      async (input, expectedSubstring) => {
        const out = await phonemizeKittenStyle(input);
        // No literal lowercase letter sequence (length ≥ 2) sandwiched
        // between IPA characters — that would mean the acronym echoed.
        // Look specifically for the lowercased acronym fragments.
        if (input.includes('ML')) {
          expect(out).not.toMatch(/\bml\b/);
        }
        if (input.includes('XML')) {
          expect(out).not.toMatch(/\bxml\b/);
        }
        expect(out).toContain(expectedSubstring);
      },
    );

    test('standalone lowercased acronym (ml) gets letter-by-letter', async () => {
      // Mimics the exact failure from production logs: dict miss, hans00
      // echoes "ml", fallback spells out as letters.
      const out = await phon.phonemize('ml', 'en-us');
      expect(out).not.toMatch(/\bml\b/);
      // Both letters M and L share the ɛ vowel — at least one must appear.
      expect(out).toMatch(/ɛ/);
    });

    test('standalone lowercased acronym (xlm) gets letter-by-letter', async () => {
      const out = await phon.phonemize('xlm', 'en-us');
      expect(out).not.toMatch(/\bxlm\b/);
      expect(out).toMatch(/ɛ/);
    });
  });
});
