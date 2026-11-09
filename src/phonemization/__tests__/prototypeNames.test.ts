/**
 * Words that name Object.prototype members ("constructor", "toString", …)
 * must be read as words: no table lookup on the text path may return an
 * inherited member (#88: "constructor" was spoken as
 * "function Object() { [native code] }").
 */
jest.mock('../../utils/logger', () => ({
  createComponentLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// hans00 stand-in: OOV words come back as "ˈ" + the lowercased word.
jest.mock('phonemize', () => ({
  toIPA: (w: string) => `ˈ${w.toLowerCase()}`,
}));

jest.mock('../../NativeSpeech', () => ({}));

const mockAsset = {text: ''};
jest.mock('../../utils/AssetLoader', () => ({
  loadAssetAsText: async () => mockAsset.text,
}));

import {HansPhonemizer} from '../HansPhonemizer';
import {JsDictSource} from '../JsDictSource';
import {loadDict} from '../dict';
import {normalizeForSpeech} from '../normalizeForSpeech';
import {TextPreprocessor} from '../KittenPreprocessor';
import {TextNormalizer} from '../../engines/kokoro/TextNormalizer';
import {lookupTable} from '../../utils/lookupTable';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const NAMES = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__proto__',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
];
const LEAK = /function|native code|\[object|\{/;

describe('Object.prototype names (#88)', () => {
  test.each(NAMES)('%s is phonemized as a word (no dict entry)', async name => {
    const phon = new HansPhonemizer({dict: new JsDictSource({the: 'ðə'})});
    const out = await phon.phonemize(`the ${name} runs`, 'en-us');
    expect(out).not.toMatch(LEAK);
  });

  test('a dict entry for constructor is used', async () => {
    const dict = new JsDictSource({constructor: 'kənstɹˈʌktɚ'});
    const phon = new HansPhonemizer({dict});
    expect(await phon.phonemize('Constructor', 'en-us')).toBe('kənstɹˈʌktɚ');
  });

  test('JsDictSource misses for prototype names', () => {
    const dict = new JsDictSource({the: 'ðə'});
    for (const name of NAMES) expect(dict.lookup(name)).toBeNull();
  });

  test('loadDict keeps "__proto__" and "constructor" as plain entries', async () => {
    mockAsset.text = '__proto__\tpɹˈoʊɾoʊ\nconstructor\tkənstɹˈʌktɚ\nthe\tðə\n';
    const dict = await loadDict('mem://proto.tsv');
    expect(dict.lookup('__proto__')).toBe('pɹˈoʊɾoʊ');
    expect(dict.lookup('constructor')).toBe('kənstɹˈʌktɚ');
    expect(dict.lookup('toString')).toBeNull();
  });

  test.each(NAMES)('%s survives the Kitten and Kokoro text layers', name => {
    const text = `Call ${name} on 5 km and $3 at 10K, the 1st, IV.`;
    const kitten = new TextPreprocessor({
      removePunctuation: false,
      expandContractions: false,
      lowercase: false,
      expandScaleSuffixes: false,
      expandFractions: false,
    }).process(normalizeForSpeech(text));
    const kokoro = new TextNormalizer().normalize(normalizeForSpeech(text));
    expect(kitten).not.toMatch(LEAK);
    expect(kokoro).not.toMatch(LEAK);
  });

  test('lookupTable has no prototype and is frozen', () => {
    const t = lookupTable({a: 'x'});
    expect(t.constructor).toBeUndefined();
    expect(t.toString).toBeUndefined();
    expect(Object.isFrozen(t)).toBe(true);
    expect(t.a).toBe('x');
  });

  test('text-path tables keyed by strings are lookupTable, not plain objects', () => {
    // A plain `Record<string, …> = {` table hits Object.prototype for
    // "constructor"; keep every such table on the text path prototype-free.
    const phon = join(__dirname, '..');
    const files = [
      ...readdirSync(phon)
        .filter(n => n.endsWith('.ts'))
        .map(n => join(phon, n)),
      join(__dirname, '../../engines/kokoro/TextNormalizer.ts'),
      join(__dirname, '../../engines/kokoro/Phonemizer.ts'),
    ];
    const plain: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(
        /(?:const|let)\s+(\w+)\s*(?::\s*Record<string,[^=]*>)?\s*=\s*\(?\{/g,
      )) {
        if (/Record<string,|\(\{$/.test(m[0])) plain.push(`${f}: ${m[1]}`);
      }
    }
    expect(plain).toEqual([]);
  });
});
