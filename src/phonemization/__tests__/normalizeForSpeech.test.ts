import {normalizeForSpeech} from '../normalizeForSpeech';

describe('normalizeForSpeech', () => {
  test.each([
    // Typographic apostrophes → ASCII so the dict sees "don't".
    ['I don’t know why it didn’t work', "I don't know why it didn't work"],
    ['“That’s great,” she said.', '"That\'s great," she said.'],
    ['Q&amp;A, it&#39;s', "Q and A, it's"],
    ['ok.So we go', 'ok.So we go'],
    // Emails read in full; URLs read as their host only.
    ['Email john.doe@example.com now', 'Email john doe at example dot com now'],
    ['Visit www.example.com/help.', 'Visit example dot com.'],
    ['See https://github.com/a/b?x=1 for more', 'See github dot com for more'],
    // Not domains: no TLD match / single-letter labels.
    ['Use Node.js daily', 'Use Node.js daily'],
    // Latin abbreviations.
    ['JSON, e.g. a REST API', 'JSON, for example, a REST API'],
    ['lunch, i.e. noon', 'lunch, that is, noon'],
    ['cats vs. dogs', 'cats versus dogs'],
    ['Dr. Smith met Mr. Jones', 'Doctor Smith met Mister Jones'],
    ['Ask the dr. now', 'Ask the dr. now'],
    ['DR. Brown', 'Doctor Brown'],
    // Symbols.
    ['salt & pepper', 'salt and pepper'],
    ['R&D and AT&T', 'R and D and AT and T'],
    ['C++ is fine', 'C++ is fine'],
    // Ordinals, percentages, units.
    ['March 5th', 'March fifth'],
    ['grew 12.5%', 'grew twelve point five percent'],
    ['in the 1990s and 80s', 'in the nineteen nineties and eighties'],
    // Clock times and am/pm spelled as letters.
    ['at 3:30 pm', 'at 3 30 p-m-'],
    ['at 9:05AM', 'at 9 oh 5 a-m-'],
    ['at 12:00', "at 12 o'clock"],
    ['at 10 a.m., then', 'at 10 a-m-, then'],
    // Letter/digit tokens.
    ['GPT-4o and COVID-19', 'GPT 4 o and COVID 19'],
    ['MP3 in 3D', 'MP 3 in 3 D'],
    ['the 2022s', 'the 2022s'],
    // Numeric forms.
    ['1e-3', 'one times ten to the negative three'],
    // Regression guards from the adversarial probe set.
    ['Open VS Code', 'Open VS Code'],
    ['in 4K or 8K', 'in 4 kay or 8 kay'],
    ['rated 4/5 and due 5/1', 'rated 4/5 and due 5/1'],
    ['run 1:30:45', 'run 1 30 45'],
    ['Qwen2.5-7B', 'Qwen 2.5 7 billion'],
    ['100s of users', 'hundreds of users'],
    ['wrap in <b>bold</b>', 'wrap in <b>bold</b>'],
    ['See details. > Note: this', 'See details. > Note: this'],
    // Second review round.
    ['A U.S.-based firm', 'A U-S based firm'],
    ['use a.m./p.m. format', 'use a-m p-m- format'],
    ['open 9am-5pm daily', 'open 9 a-m- to 5 p-m- daily'],
    ['5-10K users', '5-10 thousand users'],
    ['from 7-13B params', 'from 7-13 billion params'],
    ['10-20% cheaper', '10 to twenty percent cheaper'],
    ['B2B and 3 T-shirts', 'B 2 B and 3 T-shirts'],
    ['Steps 1/2/3', 'Steps 1/2/3'],
    ['He got his MS. Then', 'He got his MS. Then'],
    // Dotted acronyms keep a sentence-final period.
    ['the U.S. and the U.K. agreed', 'the U-S- and the U-K- agreed'],
    ['We live in the U.S.', 'We live in the U-S-.'],
  ])('%s', (input, expected) => {
    expect(normalizeForSpeech(input)).toBe(expected);
  });

  test('leaves plain prose untouched', () => {
    const prose = 'The quick brown fox jumps over the lazy dog, twice.';
    expect(normalizeForSpeech(prose)).toBe(prose);
  });

  test('is idempotent', () => {
    const once = normalizeForSpeech(
      'Dr. Smith’s 2nd test: 50% at 3:30 pm, e.g. GPT-4o & U.S. data.',
    );
    expect(normalizeForSpeech(once)).toBe(once);
  });
});

describe('numberToWords (long digit strings)', () => {
  const {numberToWords} = require('../KittenPreprocessor');

  test('reads 16+ digits digit by digit instead of a wrong cardinal', () => {
    expect(numberToWords('1234567890123456')).toBe(
      'one two three four five six seven eight nine zero one two three four five six',
    );
  });

  test('keeps cardinal reading up to 15 digits', () => {
    expect(numberToWords('1000000000000')).toBe('one trillion');
  });
});
