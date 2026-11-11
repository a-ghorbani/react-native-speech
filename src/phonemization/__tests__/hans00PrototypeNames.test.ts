/**
 * hans00's own tables are plain objects: a "constructor" or "__proto__"
 * token in its input comes back as ASCII or "[object Object]" (#89). The
 * G2P fallback never sends such a token to it.
 */
jest.mock('../../utils/logger', () => ({
  createComponentLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Approximates hans00 1.1.0 as measured on Node: tokens split on
// separators, and the two broken names come back as ASCII or object text.
jest.mock('phonemize', () => ({
  toIPA: jest.fn((text: string) =>
    text.replace(/([a-z_]+)|([^a-z_]+)/gi, (_m, tok, sep) => {
      if (sep) return `${sep} `;
      if (tok === 'constructor') return 'constructor';
      if (tok === '__proto__') return '[ ˈɑbdʒɛkt ˈɑbdʒɛkt]';
      return `ˈ${tok.toLowerCase()}`;
    }),
  ),
}));

jest.mock('../../NativeSpeech', () => ({}));

import {JsDictSource} from '../JsDictSource';
import {normalizeForEngine} from '../normalizeForSpeech';
import {createPhonemizer} from '../../engines/kokoro/Phonemizer';

const hans00 = require('phonemize') as {toIPA: jest.Mock};

const DICT = new JsDictSource({
  a: 'ɐ',
  the: 'ðə',
  here: 'hˈɪɹ',
  one: 'wˈʌn',
  rule: 'ɹˈuːl',
  see: 'sˈiː',
  now: 'nˈaʊ',
  constructor: 'kənstɹˈʌktɚ',
  proto: 'pɹˈoʊɾoʊ',
});

const BROKEN = /constructor|proto|ɑbdʒɛkt|\[|_/i;
const UNSAFE_TOKEN = /(^|[^a-z_])(constructor|__proto__)([^a-z_]|$)/i;

describe.each(['kitten', 'kokoro'] as const)(
  '%s: Object.prototype names in the hans00 fallback (#89)',
  engine => {
    beforeEach(() => hans00.toIPA.mockClear());

    test.each([
      ['A constructor-zorblax here.', 'kənstɹˈʌktɚ'],
      ['A zorblax-constructor here.', 'kənstɹˈʌktɚ'],
      ['The Constructor-Zorblax rule.', 'kənstɹˈʌktɚ'],
      ['The __proto__-zorblax one.', 'pɹˈoʊɾoʊ'],
      ['See constructor.zorblax now.', 'kənstɹˈʌktɚ'],
    ])('"%s" reads the name from the dict', async (text, ipa) => {
      const out = await createPhonemizer(
        engine === 'kitten' ? 'js-ipa' : 'js',
        {dict: DICT},
      ).phonemize(normalizeForEngine(text, engine), 'en-us');

      const calls = hans00.toIPA.mock.calls.map(c => c[0] as string);
      expect(calls.filter(c => UNSAFE_TOKEN.test(c))).toEqual([]);
      expect(calls.length).toBeGreaterThan(0);
      expect(out.replace(/[ˈˌ]/g, '')).toContain(ipa.replace(/[ˈˌ]/g, ''));
      expect(out).not.toMatch(BROKEN);
    });

    test('a compound without those names goes to hans00 whole', async () => {
      await createPhonemizer(engine === 'kitten' ? 'js-ipa' : 'js', {
        dict: DICT,
      }).phonemize(
        normalizeForEngine('A hello-zorblax here.', engine),
        'en-us',
      );
      expect(hans00.toIPA.mock.calls.map(c => c[0])).toEqual(['hello-zorblax']);
    });
  },
);
