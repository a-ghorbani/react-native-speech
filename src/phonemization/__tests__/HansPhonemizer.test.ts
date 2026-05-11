/**
 * HansPhonemizer unit tests.
 *
 * These cover the six layers of phonemizeWord end-to-end:
 *   - REDUCED_FORMS override (beats the dict)
 *   - dict lookup
 *   - hyphen-split compounds
 *   - possessive fallback
 *   - hans00 OOV fallback
 *   - per-word destress (FULLY_UNSTRESSED / SECONDARY_STRESSED)
 *
 * Full corpus Levenshtein benchmarks live in phonemizer-bench; this file is
 * only a fast regression guard.
 */

import {HansPhonemizer} from '../HansPhonemizer';
import type {DictSource} from '../DictSource';

// Tiny in-memory DictSource for tests — mirrors JsDictSource without the
// dependency, so this file stays self-contained.
function makeSource(map: Record<string, string>): DictSource {
  return {
    lookup: (w: string) => map[w] ?? null,
    size: () => Object.keys(map).length,
  };
}

jest.mock('../../utils/logger', () => ({
  createComponentLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Minimal mock for hans00/phonemize — only hit for OOV words.
jest.mock('phonemize', () => ({
  toIPA: jest.fn((word: string, _opts?: {stripStress?: boolean}) => {
    const map: Record<string, string> = {
      floofulous: 'ˈfluːfələs',
      zoomy: 'ˈzuːmi',
      // Echo cases — simulates lowercased acronyms hans00 doesn't recognize.
      ml: 'ml',
      xlm: 'xlm',
      // Single letters — what the acronym fallback queries when spelling out.
      // Mock lowercases input before lookup, so 'M'/'L'/'X' all hit these.
      m: 'ɛm',
      l: 'ɛl',
      x: 'ɛks',
    };
    const key = word.toLowerCase();
    return map[key] ?? `ˈ${key}`;
  }),
}));

const hans00Mock = require('phonemize') as {toIPA: jest.Mock};

const DICT: Record<string, string> = {
  hello: 'həlˈoʊ',
  world: 'wˈɜːld',
  cat: 'kˈæt',
  cats: 'kˈæts',
  the: 'ðˈiː',
  is: 'ˈɪz',
  but: 'bˈʌt',
  ice: 'ˈaɪs',
  cream: 'kɹˈiːm',
  apple: 'ˈæpəl',
};

describe('HansPhonemizer', () => {
  let phon: HansPhonemizer;

  beforeEach(() => {
    phon = new HansPhonemizer({dict: makeSource(DICT)});
    hans00Mock.toIPA.mockClear();
  });

  test('uses REDUCED_FORMS override instead of dict', async () => {
    // "a" is in REDUCED_FORMS (→ ɐ). Even without a dict entry, override wins.
    const out = await phon.phonemize('a cat', 'en-us');
    expect(out).toContain('ɐ');
    expect(out).toContain('kˈæt');
  });

  test('looks up words in the dict', async () => {
    const out = await phon.phonemize('hello world', 'en-us');
    expect(out).toContain('həlˈoʊ');
    expect(out).toContain('wˈɜːld');
    expect(hans00Mock.toIPA).not.toHaveBeenCalled();
  });

  test('hyphen-split compounds are handled per-part', async () => {
    const out = await phon.phonemize('ice-cream', 'en-us');
    // joined compound, no space
    expect(out).toContain('ˈaɪskɹˈiːm');
    expect(hans00Mock.toIPA).not.toHaveBeenCalled();
  });

  test('possessive fallback: X\u2019s uses dict[X] + ɪz', async () => {
    const out = await phon.phonemize("apple's", 'en-us');
    expect(out).toContain('ˈæpəl' + 'ɪz');
  });

  test('lowercased acronym falls back to letter-by-letter spelling', async () => {
    // hans00 echoes "ml" (no IPA chars) — a real-world failure for tokens
    // like Kitten's lowercased "PrismML" → "prism ml". The fallback should
    // spell out each letter so the IPA stream stays clean.
    const out = await phon.phonemize('ml', 'en-us');
    expect(out).toContain('ɛm');
    expect(out).toContain('ɛl');
    // The literal token must NOT leak into the IPA.
    expect(out).not.toMatch(/\bml\b/);
  });

  test('three-letter acronym (xlm) also spells out', async () => {
    const out = await phon.phonemize('xlm', 'en-us');
    expect(out).toContain('ɛks');
    expect(out).toContain('ɛl');
    expect(out).toContain('ɛm');
    expect(out).not.toMatch(/\bxlm\b/);
  });

  test('echo detection does NOT fire for words producing real IPA', async () => {
    // "floofulous" has IPA chars (ː, ə) so isn't echo — fallback skipped.
    // (relocateStress shifts the ˈ mark; just check the IPA body remains.)
    const out = await phon.phonemize('floofulous', 'en-us');
    expect(out).toContain('uːfələs');
    // No letter-spelled fallback — output is one IPA blob, no internal spaces.
    expect(out).not.toMatch(/\s/);
  });

  test('OOV words fall back to hans00/phonemize', async () => {
    const out = await phon.phonemize('floofulous', 'en-us');
    expect(hans00Mock.toIPA).toHaveBeenCalledWith(
      'floofulous',
      expect.any(Object),
    );
    // Stress relocated after first vowel
    expect(out).toMatch(/fl?.*ˈ/);
  });

  test('FULLY_UNSTRESSED words lose all stress marks', async () => {
    // "the" is in FULLY_UNSTRESSED; dict entry is ðˈiː → stress stripped.
    const out = await phon.phonemize('the cat', 'en-us');
    expect(out).toContain('ðiː');
    expect(out).not.toContain('ðˈiː');
    // But cat keeps primary stress
    expect(out).toContain('kˈæt');
  });

  test('SECONDARY_STRESSED words get ˈ→ˌ downgraded', async () => {
    // "but" is in SECONDARY_STRESSED; dict has bˈʌt → bˌʌt.
    const out = await phon.phonemize('but', 'en-us');
    expect(out).toContain('bˌʌt');
    expect(out).not.toContain('bˈʌt');
  });

  test('preserves punctuation between chunks', async () => {
    const out = await phon.phonemize('hello, world!', 'en-us');
    expect(out).toContain(',');
    expect(out).toContain('!');
  });

  test('applies postProcess when provided', async () => {
    const pp = new HansPhonemizer({
      dict: makeSource(DICT),
      postProcess: (p, _lang) => p.replace(/cat/g, 'CAT'),
    });
    // Fake post: applies on the rejoined string, so inject a literal "cat".
    const tweak = new HansPhonemizer({
      dict: makeSource({...DICT, cat: 'cat'}),
      postProcess: (p, _lang) => p.replace(/cat/g, 'CAT'),
    });
    const out1 = await pp.phonemize('cat', 'en-us');
    expect(out1).toContain('kˈæt'); // normal dict output, no 'cat' literal
    const out2 = await tweak.phonemize('cat', 'en-us');
    expect(out2).toBe('CAT');
  });
});
