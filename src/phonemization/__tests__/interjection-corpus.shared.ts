/**
 * Shared helpers for the interjection/acronym corpus tests. The same
 * assertion suite runs against HansPhonemizer in two modes:
 *
 *   - hans00 available (release-build path; real phonemize via subprocess)
 *   - hans00 unavailable (Hermes debug / jest-bundle-failure path)
 *
 * The *behavioral class* each case belongs to (interjection must not spell,
 * acronym must spell, real-word must pronounce, etc.) is identical in both
 * modes — the exact IPA surface differs but the structure does not. Keeping
 * the assertions here guarantees that the two test files stay in lockstep.
 */

import type {HansPhonemizer} from '../HansPhonemizer';
import {splitCamelCase} from '../splitCamelCase';

// IPA vowels — used to detect whether a phoneme cluster pronounces as a
// syllable or is just a consonant spell-out. Mirrors HansPhonemizer's
// IPA_VOWELS plus 'y' (treated as secondary vowel for phonotactic purposes).
const IPA_VOWELS = 'aeiouæɑɒɔəɛɜɝɞɪʊʌɚɨøɵœɶɤɯʏɐy';
export const hasVowel = (s: string) => new RegExp(`[${IPA_VOWELS}]`).test(s);

/**
 * Single-letter IPA spell-outs that appear when the pipeline treats a word
 * as an acronym. Values taken from the upstream dict for letters a-z — they
 * match what HansPhonemizer's spellOutLetters() produces.
 */
export const LETTER_IPA: Record<string, string> = {
  a: 'ˈeɪ',
  b: 'bˈiː',
  c: 'sˈiː',
  d: 'dˈiː',
  e: 'ˈiː',
  f: 'ˈɛf',
  g: 'dʒˈiː',
  h: 'ˈeɪtʃ',
  i: 'ˈaɪ',
  j: 'dʒˈeɪ',
  k: 'kˈeɪ',
  l: 'ˈɛl',
  m: 'ˈɛm',
  n: 'ˈɛn',
  o: 'ˈoʊ',
  p: 'pˈiː',
  q: 'kjˈuː',
  r: 'ˈɑːɹ',
  s: 'ˈɛs',
  t: 'tˈiː',
  u: 'jˈuː',
  v: 'vˈiː',
  w: 'dˈʌbəljˌuː',
  x: 'ˈɛks',
  y: 'wˈaɪ',
  z: 'zˈiː',
};

/**
 * Count how many letter-IPA patterns appear as indications that `word` was
 * spelled out letter-by-letter.
 *
 * Two positive signals:
 *   (a) space-separated tokens match letter-IPA as whole tokens
 *       ('ˈɛm ˈɛl' for ML — the spellOutLetters path)
 *   (b) the full concatenated spellout appears as a contiguous substring
 *       ('ˌɛmˌeɪtʃˈɛm' for mhm — the espeak-inherited dict-spellout)
 *
 * Substring matching of *individual* letters is deliberately avoided: the
 * letter E's IPA 'ˈiː' appears inside 'tiːm' (team) and would false-positive
 * on every English word containing /iː/.
 */
export function countLetterSpellouts(ipa: string, word: string): number {
  // Strip stress marks (ˈˌ) AND length marks (ː) so the comparison tolerates
  // hans00's spelled-out form ("dʒˈiˈpiˈju" for GPU — stress but no length)
  // and the dict's fully-marked form ("dʒˈiː pˈiː jˈuː") equally.
  const normalize = (s: string) => s.replace(/[ˈˌː]/g, '');
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length < 2) return 0;

  const expectedPieces = clean
    .split('')
    .map(l => LETTER_IPA[l])
    .filter((s): s is string => !!s)
    .map(normalize);
  if (expectedPieces.length === 0) return 0;

  const normalizedIpa = normalize(ipa);

  const expectedConcat = expectedPieces.join('');
  if (expectedConcat.length >= 4 && normalizedIpa.includes(expectedConcat)) {
    return clean.length;
  }

  const tokens = normalizedIpa.split(/[\s,.!?;:]+/).filter(Boolean);
  const letterIpaSet = new Set(expectedPieces);
  let hits = 0;
  for (const t of tokens) {
    if (letterIpaSet.has(t)) hits++;
  }
  return hits;
}

export function looksSpelledOut(ipa: string, word: string): boolean {
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length < 2) return false;
  const hits = countLetterSpellouts(ipa, clean);
  return hits >= Math.ceil(clean.length * 0.75);
}

/**
 * One case from the fixture JSON. Structural — we avoid importing the JSON
 * type here so the helper stays agnostic of fixture schema tweaks.
 */
export interface CorpusCase {
  input: string;
  category: string;
  status: string;
  notes?: string;
  espeakRef?: string | null;
}

export type OutputCapture = {
  input: string;
  category: string;
  status: string;
  output: string;
};

/**
 * Run the full corpus against `phon` and register a Jest `test()` per case.
 * `mode` is the label prefix used in test names + the capture dump so
 * release and debug runs are easy to tell apart in the jest output.
 */
export function describeCorpus(
  mode: string,
  getPhonemizer: () => HansPhonemizer,
  cases: readonly CorpusCase[],
): void {
  const captured: OutputCapture[] = [];

  afterAll(() => {
    console.log(
      `\n=== ${mode} — pipeline output capture ===\n` +
        captured
          .map(
            r =>
              `[${r.status.padEnd(26)}] ${r.category.padEnd(
                26,
              )} ${JSON.stringify(r.input).padEnd(50)} -> ${JSON.stringify(
                r.output,
              )}`,
          )
          .join('\n'),
    );
  });

  for (const c of cases) {
    const label = `${c.category} — ${JSON.stringify(c.input)} [${c.status}]`;

    test(label, async () => {
      // Engines run splitCamelCase in their preprocessor before calling
      // the phonemizer; mirror that here so PrismML/XMLParser test the
      // realistic end-to-end flow, not HansPhonemizer's raw contract.
      const preprocessed = splitCamelCase(c.input);
      const out = await getPhonemizer().phonemize(preprocessed, 'en-us');
      captured.push({
        input: c.input,
        category: c.category,
        status: c.status,
        output: out,
      });

      assertCase(c, preprocessed, out);
    });
  }
}

function assertCase(c: CorpusCase, preprocessed: string, out: string): void {
  if (c.category === 'interjection') {
    expect(looksSpelledOut(out, c.input)).toBe(false);
    expect(out.length).toBeLessThan(16);
    expect(out).not.toBe(c.input);
  } else if (c.category === 'acronym') {
    expect(looksSpelledOut(out, c.input)).toBe(true);
  } else if (c.category === 'real_word') {
    expect(looksSpelledOut(out, c.input)).toBe(false);
    expect(hasVowel(out)).toBe(true);
  } else if (c.category === 'camelcase_with_acronym') {
    const caps = (preprocessed.match(/\b[A-Z]{2,}\b/g) || []).pop() || '';
    if (caps) {
      const hits = countLetterSpellouts(out, caps);
      expect(hits).toBeGreaterThanOrEqual(Math.ceil(caps.length * 0.75));
    }
  } else if (c.category === 'sentence_interjection') {
    const firstWord = (c.input.match(/^[A-Za-z']+/) || [''])[0];
    if (firstWord) {
      const letterHits = countLetterSpellouts(out, firstWord);
      expect(letterHits).toBeLessThan(Math.ceil(firstWord.length * 0.75));
    }
  } else if (c.category === 'sentence_acronym') {
    const allCaps = preprocessed.match(/\b[A-Z]{2,}\b/g) || [];
    const spelledOut = allCaps.some(caps => {
      const hits = countLetterSpellouts(out, caps);
      return hits >= Math.ceil(caps.length * 0.75);
    });
    expect(spelledOut).toBe(true);
  } else if (c.category === 'normal') {
    expect(hasVowel(out)).toBe(true);
  } else if (c.category === 'model_name') {
    expect(looksSpelledOut(out, c.input)).toBe(false);
    // Vowel check only applies when we produced actual IPA; skip if the
    // output is an ASCII passthrough (valid degraded-path behavior in
    // no-hans00 mode when the word isn't in the dict).
    if (!/^[A-Za-z\s.,!?'-]+$/.test(out)) {
      expect(hasVowel(out)).toBe(true);
    }
  } else if (c.category === 'sentence_model_name') {
    const tokens = c.input.match(/[A-Za-z]+/g) || [];
    for (const tok of tokens) {
      if (tok.length < 2) continue;
      const hits = countLetterSpellouts(out, tok);
      expect(hits).toBeLessThan(Math.ceil(tok.length * 0.75));
    }
  }
}
