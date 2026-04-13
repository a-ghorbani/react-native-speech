/**
 * TextNormalizer Tests
 *
 * Tests the text normalization step of the phonemization pipeline.
 * Uses shared fixture: fixtures/phonemization-cases.json
 *
 * This test validates: input -> normalized (column 0 -> column 1)
 */

import {TextNormalizer} from '../TextNormalizer';
import testFixture from './fixtures/phonemization-cases.json';

describe('TextNormalizer', () => {
  const normalizer = new TextNormalizer();

  describe('en-us normalization', () => {
    const testCases = testFixture['en-us'];

    test.each(testCases.map((tc, i) => [i, tc.input, tc.normalized]))(
      '[%i] normalizes "%s"',
      (_index, input, expected) => {
        const actual = normalizer.normalize(input as string);
        expect(actual).toBe(expected);
      },
    );
  });

  describe('en-gb normalization', () => {
    const testCases = testFixture['en-gb'];

    test.each(testCases.map((tc, i) => [i, tc.input, tc.normalized]))(
      '[%i] normalizes "%s"',
      (_index, input, expected) => {
        const actual = normalizer.normalize(input as string);
        expect(actual).toBe(expected);
      },
    );
  });

  describe('quote handling', () => {
    test('converts smart single quotes to straight quotes', () => {
      // \u2018 and \u2019 are curly single quotes
      // They should be converted to straight single quotes
      const result = normalizer.normalize('\u2018Hello\u2019');
      expect(result).toBe("'Hello'");
    });

    test('converts smart double quotes to straight quotes', () => {
      // \u201c and \u201d are curly double quotes
      // In kokoro.js these are first converted to straight " quotes
      const result = normalizer.normalize('\u201cHello\u201d');
      expect(result).toBe('"Hello"');
    });

    test('converts guillemets to double quotes', () => {
      expect(normalizer.normalize('\u00abHello\u00bb')).toBe('"Hello"');
    });

    test('converts parentheses to guillemets', () => {
      expect(normalizer.normalize('(Hello)')).toBe('\u00abHello\u00bb');
    });
  });

  describe('CJK punctuation', () => {
    test('converts Japanese comma to western comma', () => {
      expect(normalizer.normalize('Hello\u3001World')).toBe('Hello, World');
    });

    test('converts Japanese period to western period', () => {
      expect(normalizer.normalize('Hello\u3002World')).toBe('Hello. World');
    });

    test('converts Chinese punctuation', () => {
      expect(normalizer.normalize('Hello\uff0cWorld')).toBe('Hello, World');
      expect(normalizer.normalize('Hello\uff1aWorld')).toBe('Hello: World');
      // Note: trailing spaces are trimmed by normalize()
      expect(normalizer.normalize('Hello\uff1f')).toBe('Hello?');
      expect(normalizer.normalize('Hello\uff01')).toBe('Hello!');
    });
  });

  describe('whitespace normalization', () => {
    test('collapses multiple spaces', () => {
      expect(normalizer.normalize('Hello   World')).toBe('Hello World');
    });

    test('trims leading and trailing whitespace', () => {
      expect(normalizer.normalize('  Hello World  ')).toBe('Hello World');
    });
  });

  describe('abbreviations', () => {
    test('expands Dr. before capitalized name', () => {
      expect(normalizer.normalize('Dr. Smith')).toBe('Doctor Smith');
      expect(normalizer.normalize('DR. Brown')).toBe('Doctor Brown');
    });

    test('expands Mr. before capitalized name', () => {
      expect(normalizer.normalize('Mr. Smith')).toBe('Mister Smith');
      expect(normalizer.normalize('MR. Anderson')).toBe('Mister Anderson');
    });

    test('expands Ms. before capitalized name', () => {
      expect(normalizer.normalize('Ms. Taylor')).toBe('Miss Taylor');
      expect(normalizer.normalize('MS. Carter')).toBe('Miss Carter');
    });

    test('normalizes Mrs. before capitalized name (keeps Mrs for espeak-ng)', () => {
      // kokoro.js normalizes to "Mrs" (not "Missus") because espeak-ng
      // correctly pronounces "Mrs" as "mˈɪsɪz"
      expect(normalizer.normalize('Mrs. Johnson')).toBe('Mrs Johnson');
      expect(normalizer.normalize('MRS. Wilson')).toBe('Mrs Wilson');
    });

    test('removes period from etc. at end of input', () => {
      // Based on kokoro.js behavior: etc. is only replaced when at end or not followed by space
      expect(normalizer.normalize('apples, etc.')).toBe('apples, etc');
      // When followed by space + anything, the period is NOT removed
      // This matches kokoro.js behavior
      expect(normalizer.normalize('apples, etc. more')).toBe(
        'apples, etc. more',
      );
      expect(normalizer.normalize('apples, etc. More')).toBe(
        'apples, etc. More',
      );
    });
  });

  describe('casual words', () => {
    test("converts yeah to ye'a", () => {
      expect(normalizer.normalize('Yeah')).toBe("Ye'a");
      expect(normalizer.normalize('yeah')).toBe("ye'a");
    });
  });

  describe('number handling', () => {
    test('splits years into two parts', () => {
      // Years are split to "19 90" by splitNum, then intToWords final pass
      // converts the bare integer segments to words.
      expect(normalizer.normalize('1990')).toBe('nineteen ninety');
      expect(normalizer.normalize('2022')).toBe('twenty twenty two');
    });

    test('handles decade suffix', () => {
      // "22s" is not a bare integer so stays intact after intToWords pass.
      expect(normalizer.normalize('2022s')).toBe('twenty 22s');
      expect(normalizer.normalize('1980s')).toBe('nineteen 80s');
    });

    test('splits time format', () => {
      expect(normalizer.normalize('12:34')).toBe('twelve thirty four');
      expect(normalizer.normalize('3:00')).toBe("three o'clock");
      expect(normalizer.normalize('3:05')).toBe('three oh five');
    });

    test('removes commas from numbers', () => {
      expect(normalizer.normalize('1,000')).toBe('one thousand');
      expect(normalizer.normalize('12,345,678')).toBe('12345678');
    });

    test('converts number ranges', () => {
      expect(normalizer.normalize('10-20')).toBe('ten to twenty');
      expect(normalizer.normalize('5-10')).toBe('five to ten');
    });

    test('adds space before uppercase S after number', () => {
      expect(normalizer.normalize('10S')).toBe('ten S');
      expect(normalizer.normalize('5S')).toBe('five S');
    });
  });

  describe('currency handling', () => {
    test('converts dollar amounts', () => {
      expect(normalizer.normalize('$100')).toBe('one hundred dollars');
      expect(normalizer.normalize('$1')).toBe('one dollar');
    });

    test('converts dollar amounts with cents', () => {
      expect(normalizer.normalize('$5.99')).toBe(
        'five dollars and ninety nine cents',
      );
      expect(normalizer.normalize('$1.01')).toBe('one dollar and one cent');
    });

    test('converts pound amounts', () => {
      expect(normalizer.normalize('\u00a3100')).toBe('one hundred pounds');
      expect(normalizer.normalize('\u00a31')).toBe('one pound');
    });

    test('converts pound amounts with pence', () => {
      expect(normalizer.normalize('\u00a31.50')).toBe(
        'one pound and fifty pence',
      );
      expect(normalizer.normalize('\u00a35.01')).toBe(
        'five pounds and one penny',
      );
    });
  });

  describe('decimal numbers', () => {
    test('converts decimal numbers to spoken form', () => {
      expect(normalizer.normalize('12.34')).toBe('twelve point three four');
      expect(normalizer.normalize('0.01')).toBe('zero point zero one');
      expect(normalizer.normalize('3.14159')).toBe(
        'three point one four one five nine',
      );
    });
  });

  describe('possessives', () => {
    test('handles uppercase consonant possessives', () => {
      // The regex only matches UPPERCASE consonants
      // First: (?<=[BCDFGHJ-NP-TV-Z])'?s\b -> 'S
      // Then: (?<=X')S\b -> s (exception for X)
      expect(normalizer.normalize("X's mark")).toBe("X's mark"); // X is exception
      expect(normalizer.normalize("BOB's car")).toBe("BOB'S car"); // B is uppercase consonant
      expect(normalizer.normalize("Bob's car")).toBe("Bob's car"); // b is lowercase, no change
    });
  });

  describe('acronyms', () => {
    test('converts periods in acronyms to hyphens', () => {
      // The regex only replaces periods BETWEEN uppercase letters
      // Final period is not replaced (no letter follows)
      expect(normalizer.normalize('U.S.A.')).toBe('U-S-A.');
      expect(normalizer.normalize('A.B.C')).toBe('A-B-C');
      // When followed by lowercase text, first pattern activates
      expect(normalizer.normalize('U.S.A. is')).toBe('U-S-A- is');
    });
  });

  describe('chunkBySentences', () => {
    test('splits text into sentence chunks', () => {
      const text = 'Hello world. This is a test. Another sentence.';
      const chunks = normalizer.chunkBySentences(text);
      expect(chunks).toEqual([
        'Hello world. This is a test. Another sentence.',
      ]);
    });

    test('respects max chunk size', () => {
      const text = 'Short. Another short. Third one.';
      const chunks = normalizer.chunkBySentences(text, 20);
      expect(chunks.length).toBeGreaterThan(1);
    });
  });
});
