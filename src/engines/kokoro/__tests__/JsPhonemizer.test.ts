/**
 * JsPhonemizer Tests
 *
 * Tests:
 * 1. ipaToMisaki - IPA → Misaki phoneme mapping (pure function, no deps)
 * 2. JsPhonemizer integration - full pipeline with mocked phonemize library
 */

import {ipaToMisaki, JsPhonemizer} from '../JsPhonemizer';

// Mock the logger
jest.mock('../../../utils/logger', () => ({
  createComponentLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock the phonemize library
jest.mock('phonemize', () => ({
  toIPA: (text: string) => {
    // Simplified mock that returns known IPA for test words
    const dict: Record<string, string> = {
      take: 'ˈteɪk',
      bike: 'ˈbaɪk',
      boat: 'ˈboʊt',
      how: 'ˈhaʊ',
      boy: 'ˈbɔɪ',
      bird: 'ˈbɝd',
      full: 'ˈfʊɫ',
      hello: 'həˈɫoʊ',
      world: 'ˈwɝɫd',
      red: 'ˈɹɛd',
      church: 'ˈtʃɝtʃ',
      judge: 'ˈdʒʌdʒ',
      cat: 'ˈkæt',
      butter: 'ˈbətɝ',
      apples: 'ˈæpəɫz',
      oranges: 'ˈɔɹɪndʒᵻz',
      bananas: 'bəˈnænəz',
      'hello world': 'həˈɫoʊ ˈwɝɫd',
      'how are you': 'ˈhaʊ ˈɑɹ ˈju',
    };
    const lower = text.toLowerCase().trim();
    return dict[lower] || `ˈ${lower}`;
  },
}));

describe('ipaToMisaki', () => {
  describe('US English diphthongs', () => {
    test('eɪ → A', () => {
      expect(ipaToMisaki('teɪk', 'en-us')).toBe('tAk');
    });

    test('aɪ → I', () => {
      expect(ipaToMisaki('baɪk', 'en-us')).toBe('bIk');
    });

    test('oʊ → O', () => {
      expect(ipaToMisaki('boʊt', 'en-us')).toBe('bOt');
    });

    test('aʊ → W', () => {
      expect(ipaToMisaki('haʊ', 'en-us')).toBe('hW');
    });

    test('ɔɪ → Y', () => {
      expect(ipaToMisaki('bɔɪ', 'en-us')).toBe('bY');
    });
  });

  describe('British English diphthongs', () => {
    test('əʊ → Q (British "boat")', () => {
      expect(ipaToMisaki('bəʊt', 'en-gb')).toBe('bQt');
    });

    test('oʊ stays as oʊ in British (not mapped to O)', () => {
      // In GB, oʊ is not a standard diphthong; əʊ is used instead
      expect(ipaToMisaki('oʊ', 'en-gb')).toBe('oʊ');
    });
  });

  describe('r-colored vowels', () => {
    test('ɝ → ɜɹ', () => {
      expect(ipaToMisaki('bɝd', 'en-us')).toBe('bɜɹd');
    });

    test('ɚ → əɹ', () => {
      expect(ipaToMisaki('bɚtɚ', 'en-us')).toBe('bəɹtəɹ');
    });
  });

  describe('consonant mappings', () => {
    test('dark L (ɫ) → l', () => {
      expect(ipaToMisaki('fʊɫ', 'en-us')).toBe('fʊl');
    });

    test('tʃ → ʧ', () => {
      expect(ipaToMisaki('tʃɜɹtʃ', 'en-us')).toBe('ʧɜɹʧ');
    });

    test('dʒ → ʤ', () => {
      expect(ipaToMisaki('dʒʌdʒ', 'en-us')).toBe('ʤʌʤ');
    });

    test('glottal stop ʔ → t (US only)', () => {
      expect(ipaToMisaki('bʌʔən', 'en-us')).toBe('bʌtən');
    });

    test('glottal stop ʔ preserved in GB', () => {
      expect(ipaToMisaki('bʌʔən', 'en-gb')).toBe('bʌʔən');
    });
  });

  describe('multiple mappings in one string', () => {
    test('hello world: həˈɫoʊ ˈwɝɫd → həˈlO ˈwɜɹld', () => {
      expect(ipaToMisaki('həˈɫoʊ ˈwɝɫd', 'en-us')).toBe('həˈlO ˈwɜɹld');
    });

    test('preserves stress marks', () => {
      const result = ipaToMisaki('ˈteɪk ˌbaɪk', 'en-us');
      expect(result).toBe('ˈtAk ˌbIk');
      expect(result).toContain('ˈ');
      expect(result).toContain('ˌ');
    });
  });

  describe('passthrough of Misaki-native symbols', () => {
    test('preserves consonants', () => {
      expect(ipaToMisaki('bdfstkmnpv', 'en-us')).toBe('bdfstkmnpv');
    });

    test('preserves pure vowels', () => {
      expect(ipaToMisaki('əɪʊɛɑɔʌ', 'en-us')).toBe('əɪʊɛɑɔʌ');
    });

    test('preserves punctuation', () => {
      expect(ipaToMisaki('hɛˈloʊ!', 'en-us')).toBe('hɛˈlO!');
    });
  });
});

describe('JsPhonemizer (mocked)', () => {
  let phonemizer: JsPhonemizer;

  beforeAll(() => {
    phonemizer = new JsPhonemizer();
  });

  describe('full pipeline', () => {
    test('phonemizes with Misaki mapping', async () => {
      const result = await phonemizer.phonemize('hello world', 'en-us');
      // hello world → həˈɫoʊ ˈwɝɫd → ipaToMisaki → həˈlO ˈwɜɹld → postProcess
      expect(result).toContain('O'); // oʊ → O
      expect(result).not.toContain('ɫ'); // dark L removed
      expect(result).not.toContain('ɝ'); // r-colored mapped
    });

    test('preserves punctuation in pipeline', async () => {
      const result = await phonemizer.phonemize(
        'apples, oranges, bananas',
        'en-us',
      );
      expect(result).toContain(',');
    });
  });

  describe('diphthong mapping in pipeline', () => {
    test('eɪ → A (take)', async () => {
      const result = await phonemizer.phonemize('take', 'en-us');
      expect(result).toContain('A');
    });

    test('aɪ → I (bike)', async () => {
      const result = await phonemizer.phonemize('bike', 'en-us');
      expect(result).toContain('I');
    });

    test('oʊ → O (boat)', async () => {
      const result = await phonemizer.phonemize('boat', 'en-us');
      expect(result).toContain('O');
    });

    test('aʊ → W (how)', async () => {
      const result = await phonemizer.phonemize('how', 'en-us');
      expect(result).toContain('W');
    });

    test('ɔɪ → Y (boy)', async () => {
      const result = await phonemizer.phonemize('boy', 'en-us');
      expect(result).toContain('Y');
    });
  });

  describe('non-empty output', () => {
    test.each(['hello', 'cat', 'bird', 'full', 'red'])(
      '"%s" produces non-empty output',
      async text => {
        const result = await phonemizer.phonemize(text, 'en-us');
        expect(result.length).toBeGreaterThan(0);
      },
    );
  });
});
