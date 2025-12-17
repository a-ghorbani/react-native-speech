/**
 * Phonemizer Tests
 *
 * Tests the phonemization pipeline:
 * 1. splitOnPunctuation - splits text on punctuation
 * 2. rejoinChunks - rejoins chunks with phonemes
 * 3. postProcessPhonemes - post-processes for Kokoro compatibility
 *
 * Uses shared fixture: fixtures/phonemization-cases.json
 */

import {
  postProcessPhonemes,
  splitOnPunctuation,
  rejoinChunks,
} from '../Phonemizer';
import testFixture from './fixtures/phonemization-cases.json';

describe('splitOnPunctuation', () => {
  describe('en-us cases', () => {
    const testCases = testFixture['en-us'];

    test.each(testCases.map((tc, i) => [i, tc.normalized, tc.chunks]))(
      '[%i] splits "%s" correctly',
      (_index, normalized, expectedChunks) => {
        const actual = splitOnPunctuation(normalized as string);
        const expected = (
          expectedChunks as {text: string; isPunctuation: boolean}[]
        ).map(c => ({
          isPunctuation: c.isPunctuation,
          text: c.text,
        }));
        expect(actual).toEqual(expected);
      },
    );
  });

  describe('en-gb cases', () => {
    const testCases = testFixture['en-gb'];

    test.each(testCases.map((tc, i) => [i, tc.normalized, tc.chunks]))(
      '[%i] splits "%s" correctly',
      (_index, normalized, expectedChunks) => {
        const actual = splitOnPunctuation(normalized as string);
        const expected = (
          expectedChunks as {text: string; isPunctuation: boolean}[]
        ).map(c => ({
          isPunctuation: c.isPunctuation,
          text: c.text,
        }));
        expect(actual).toEqual(expected);
      },
    );
  });
});

describe('rejoinChunks', () => {
  test('rejoins chunks with phonemes', () => {
    const chunks = [
      {isPunctuation: true, text: '«', phoneme: '«'},
      {isPunctuation: false, text: 'Hello', phoneme: 'həlˈoʊ'},
      {isPunctuation: true, text: '»', phoneme: '»'},
    ];
    expect(rejoinChunks(chunks)).toBe('«həlˈoʊ»');
  });

  test('handles multiple punctuation', () => {
    const chunks = [
      {isPunctuation: false, text: 'Apples', phoneme: 'ˈæpəlz'},
      {isPunctuation: true, text: ', ', phoneme: ', '},
      {isPunctuation: false, text: 'oranges', phoneme: 'ˈɔɹɪndʒᵻz'},
    ];
    expect(rejoinChunks(chunks)).toBe('ˈæpəlz, ˈɔɹɪndʒᵻz');
  });
});

describe('postProcessPhonemes', () => {
  describe('en-us full pipeline', () => {
    const testCases = testFixture['en-us'];

    // Test: rejoin chunks (simulating native phonemization) -> postProcess = expected
    test.each(
      testCases.map((tc, i) => [i, tc.input, tc.chunks, tc.postProcessed]),
    )('[%i] full pipeline for "%s"', (_index, _input, chunks, expected) => {
      // Simulate the full pipeline: chunks already have phonemes from native
      const rejoined = rejoinChunks(
        chunks as {isPunctuation: boolean; text: string; phoneme: string}[],
      );
      const actual = postProcessPhonemes(rejoined, 'en-us');
      expect(actual).toBe(expected);
    });
  });

  describe('en-gb full pipeline', () => {
    const testCases = testFixture['en-gb'];

    test.each(
      testCases.map((tc, i) => [i, tc.input, tc.chunks, tc.postProcessed]),
    )('[%i] full pipeline for "%s"', (_index, _input, chunks, expected) => {
      const rejoined = rejoinChunks(
        chunks as {isPunctuation: boolean; text: string; phoneme: string}[],
      );
      const actual = postProcessPhonemes(rejoined, 'en-gb');
      expect(actual).toBe(expected);
    });
  });

  describe('kokoro word fix', () => {
    test('fixes American English kokoro pronunciation', () => {
      expect(postProcessPhonemes('kəkˈoːɹoʊ', 'en-us')).toBe('kˈoʊkəɹoʊ');
    });

    test('fixes British English kokoro pronunciation', () => {
      expect(postProcessPhonemes('kəkˈɔːɹəʊ', 'en-gb')).toBe('kˈəʊkəɹəʊ');
    });
  });

  describe('phoneme symbol normalization', () => {
    test('converts palatalization marker to j', () => {
      expect(postProcessPhonemes('testʲ', 'en-us')).toBe('testj');
    });

    test('normalizes r to ɹ', () => {
      expect(postProcessPhonemes('red', 'en-us')).toBe('ɹed');
    });

    test('normalizes velar fricative x to k', () => {
      expect(postProcessPhonemes('lox', 'en-us')).toBe('lok');
    });

    test('normalizes lateral fricative ɬ to l', () => {
      expect(postProcessPhonemes('ɬaɪt', 'en-us')).toBe('laɪt');
    });
  });

  describe('hundred spacing', () => {
    test('adds space before hundred when preceded by vowel', () => {
      expect(postProcessPhonemes('θɹˈiːhˈʌndɹɪd', 'en-us')).toBe(
        'θɹˈiː hˈʌndɹɪd',
      );
    });

    test('adds space before hundred when preceded by ɹ (en-us also converts fˈɔːɹ to fˈoːɹ)', () => {
      // In en-us, fˈɔːɹ gets converted to fˈoːɹ
      expect(postProcessPhonemes('fˈɔːɹhˈʌndɹɪd', 'en-us')).toBe(
        'fˈoːɹ hˈʌndɹɪd',
      );
      // In en-gb, fˈɔːɹ is preserved
      expect(postProcessPhonemes('fˈɔːɹhˈʌndɹɪd', 'en-gb')).toBe(
        'fˈɔːɹ hˈʌndɹɪd',
      );
    });
  });

  describe('trailing z handling', () => {
    test('removes space before z at end of string', () => {
      expect(postProcessPhonemes('tˈɛn z', 'en-us')).toBe('tˈɛnz');
    });

    test('removes space before z before punctuation', () => {
      expect(postProcessPhonemes('tˈɛn z.', 'en-us')).toBe('tˈɛnz.');
      expect(postProcessPhonemes('tˈɛn z,', 'en-us')).toBe('tˈɛnz,');
    });
  });

  describe('American English ninety fix', () => {
    test('converts ninety to nindi in en-us', () => {
      expect(postProcessPhonemes('nˈaɪnti', 'en-us')).toBe('nˈaɪndi');
    });

    test('does not convert ninety in en-gb', () => {
      expect(postProcessPhonemes('nˈaɪnti', 'en-gb')).toBe('nˈaɪnti');
    });

    test('preserves nineteen (does not match)', () => {
      expect(postProcessPhonemes('nˈaɪntiːn', 'en-us')).toBe('nˈaɪntiːn');
    });
  });

  describe('trimming', () => {
    test('trims leading and trailing whitespace', () => {
      expect(postProcessPhonemes('  həlˈoʊ  ', 'en-us')).toBe('həlˈoʊ');
    });
  });
});
