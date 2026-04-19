/**
 * Tests the dict-only fallback path that fires when hans00/phonemize is
 * unavailable. Real-world trigger: Hermes debug mode can't bytecode-encode
 * the 4.3MB en-g2p bundle, so `require('phonemize')` returns undefined
 * silently after the first failure. Synthesis must still produce clean
 * IPA — short OOV tokens spell out via the dict, longer ones pass through.
 *
 * This test mocks phonemize to return an object with no `toIPA`, which
 * exercises the same code path as the Hermes failure.
 */

// Mock phonemize as an empty object — getHans00 sees `typeof toIPA !==
// 'function'` and treats it as unavailable. Mirrors the Hermes silent-undef
// behavior closely enough to exercise our fallback.
jest.mock('phonemize', () => ({}), {virtual: true});

jest.mock('../../utils/logger', () => ({
  createComponentLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {HansPhonemizer} from '../HansPhonemizer';
import type {DictSource} from '../DictSource';

function makeDict(map: Record<string, string>): DictSource {
  return {
    lookup: (w: string) => map[w] ?? null,
    size: () => Object.keys(map).length,
  };
}

// Dict has English words AND single-letter acronym pronunciations.
// In production, these letter entries come from CMU/EPD dicts.
const DICT_WITH_LETTERS: Record<string, string> = {
  hello: 'həlˈoʊ',
  world: 'wˈɜːld',
  prism: 'pɹˈɪzəm',
  // Single-letter spelled-out IPA
  m: 'ɛm',
  l: 'ɛl',
  x: 'ɛks',
  i: 'aɪ',
  o: 'oʊ',
  s: 'ɛs',
};

describe('HansPhonemizer — hans00 unavailable (Hermes debug fallback)', () => {
  let phon: HansPhonemizer;

  beforeAll(() => {
    phon = new HansPhonemizer({dict: makeDict(DICT_WITH_LETTERS)});
  });

  test('short OOV token (ml) spells out via dict letters', async () => {
    // hans00 is unavailable; layer 5b should kick in and produce ɛm ɛl
    // from dict.lookup('m') + dict.lookup('l').
    const out = await phon.phonemize('ml', 'en-us');
    expect(out).toContain('ɛm');
    expect(out).toContain('ɛl');
    // Critically, the literal "ml" must not leak into the IPA stream.
    expect(out).not.toMatch(/\bml\b/);
  });

  test('three-letter OOV token (xlm) spells out', async () => {
    const out = await phon.phonemize('xlm', 'en-us');
    expect(out).toContain('ɛks');
    expect(out).toContain('ɛl');
    expect(out).toContain('ɛm');
    expect(out).not.toMatch(/\bxlm\b/);
  });

  test('dict-hit word still works (no fallback needed)', async () => {
    const out = await phon.phonemize('hello world', 'en-us');
    expect(out).toContain('həlˈoʊ');
    expect(out).toContain('wˈɜːld');
  });

  test('OOV word with missing dict letters falls through (no crash)', async () => {
    // 'qq' has no dict entries for 'q' — fallback returns the literal
    // (unchanged spelled string), so layer 5b's `spelled !== clean` guard
    // skips assignment and we end up at the final passthrough.
    // This is acceptable: better to pass through 2-char garbage than crash.
    const out = await phon.phonemize('qq', 'en-us');
    expect(typeof out).toBe('string');
  });

  test('long OOV word passes through (>4 chars, no fallback applies)', async () => {
    // 5+ letter OOV is most likely a real word, not an acronym. Letter
    // spellout would be wrong (e.g., "RADAR" shouldn't be "R-A-D-A-R").
    // We pass through and accept the audio model's output.
    const out = await phon.phonemize('floofulous', 'en-us');
    expect(typeof out).toBe('string');
  });

  test('iOS-style sentence (mixed dict-hit + OOV acronym)', async () => {
    // Mimics what KittenEngine produces after split+lowercase:
    // "PrismML" → "prism ml" → "prism" hits dict, "ml" hits letter fallback.
    const out = await phon.phonemize('prism ml', 'en-us');
    expect(out).toContain('pɹˈɪzəm');
    expect(out).toContain('ɛm');
    expect(out).toContain('ɛl');
    expect(out).not.toMatch(/\bml\b/);
  });
});
