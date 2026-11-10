import {normalizeForEngine} from '../normalizeForSpeech';

const both = (text: string) => ({
  kitten: normalizeForEngine(text, 'kitten'),
  kokoro: normalizeForEngine(text, 'kokoro'),
});

describe('years behind a context word read as years (#32)', () => {
  test.each([
    ['In 1984 we left.', 'In nineteen eighty-four we left.'],
    ['since 2001', 'since two thousand one'],
    ['May 2024 release', 'May twenty twenty-four release'],
    ['the 1990s', 'the nineteen nineties'],
    ['the 2020-2021 season', 'the twenty twenty to twenty twenty-one season'],
    ['World War I (1914–1918)', 'nineteen fourteen to nineteen eighteen'],
    ['from 1990 to 2020', 'from nineteen ninety to twenty twenty'],
    ['between 1990 and 2020', 'between nineteen ninety and twenty twenty'],
    ['May 5, 2024', 'May five, twenty twenty-four'],
    ['on 2024-05-01', 'on May first, twenty twenty-four'],
    ['Aug. 2024 build', 'Aug. twenty twenty-four build'],
    ['before 1900', 'before nineteen hundred'],
    ['after 1905', 'after nineteen oh five'],
    ['circa 1100', 'circa eleven hundred'],
    ['until 2000', 'until two thousand'],
    ['By 2030, most cars', 'By twenty thirty, most cars'],
    ['the summer of 1969', 'the summer of nineteen sixty-nine'],
    ['in 2019 or 2020', 'in twenty nineteen or twenty twenty'],
    ['the 2000s', 'the two thousands'],
    ['CPUs from roughly 2019 on', 'from roughly twenty nineteen on'],
    ['through 1972', 'through nineteen seventy-two'],
    ['In 2020 researchers found', 'In twenty twenty researchers'],
    ['In 2020 people stayed home.', 'In twenty twenty people'],
    ['In 1968 students protested.', 'In nineteen sixty-eight students'],
    ['By 2030 customers will expect it.', 'By twenty thirty customers'],
    ['Q4 2023 results beat estimates.', 'Q four twenty twenty-three results'],
    ['In May 2024 users reported bugs.', 'May twenty twenty-four users'],
    ['since 2020 people work from home', 'since twenty twenty people'],
    ['May twenty-first, 2024', 'May twenty-first, twenty twenty-four'],
    ['dropped (Q4, 2023)', 'Q four, twenty twenty-three'],
  ])('%s', (input, expected) => {
    const {kitten, kokoro} = both(input);
    expect(kitten).toContain(expected);
    expect(kokoro).toContain(expected);
  });
});

describe('other 4-digit numbers read as cardinals (#32)', () => {
  test.each([
    ['1984 people came', 'one thousand nine hundred eighty', 'people came'],
    ['2048 MB of RAM', 'two thousand forty', 'megabytes'],
    ['port 8080', 'eight thousand eighty', ''],
    ['out of 2048 tokens', 'two thousand forty', 'tokens'],
    ['a context of 2048 tokens', 'two thousand forty', 'tokens'],
    ['by 1984 users', 'one thousand nine hundred eighty', 'users'],
    ['May both 2024 teams', 'two thousand twenty', 'teams'],
    ['after 1984 steps', 'one thousand nine hundred eighty', 'steps'],
    ['from 1950 to 1984 people', 'one thousand nine hundred fifty', 'people'],
    ['a median of 1551 ms', 'one thousand five hundred fifty', 'milliseconds'],
    ['in 1500 ms', 'fifteen hundred', 'milliseconds'],
    ['costs $1999', 'one thousand nine hundred ninety', 'dollars'],
    ['takes 1500-2000 ms', 'two thousand', 'milliseconds'],
    ['1950–1984 MB', 'one thousand nine hundred eighty', 'megabytes'],
    ['scores 1950 - 1984', 'one thousand nine hundred eighty', 'scores'],
  ])('%s', (input, cardinal, rest) => {
    const {kitten, kokoro} = both(input);
    for (const out of [kitten, kokoro]) {
      expect(out.replace(/-/g, ' ')).toContain(cardinal);
      expect(out).toContain(rest);
      expect(out).not.toMatch(/nineteen|twenty (?:twenty|forty|fifteen)/);
    }
  });
});

describe('4-digit runs inside codes read in pairs (#32)', () => {
  test.each([
    ['the SM8850 chip', 'SM eighty-eight fifty chip'],
    ['MT6899 (Dimensity)', 'MT sixty-eight ninety-nine'],
    ['an RTX4090', 'RTX forty ninety'],
    ['commit 5228ea0', 'fifty-two twenty-eight'],
    ['Buy the RTX4090, it rocks.', 'RTX forty ninety, it rocks.'],
  ])('%s', (input, expected) => {
    const {kitten, kokoro} = both(input);
    expect(kitten).toContain(expected);
    expect(kokoro).toContain(expected);
  });

  test.each([
    ['2048MB of RAM', 'two thousand forty'],
    ['a 1440p screen', 'one thousand four hundred forty'],
  ])('not a unit: %s', (input, cardinal) => {
    const {kitten, kokoro} = both(input);
    expect(kitten.replace(/-/g, ' ')).toContain(cardinal);
    expect(kokoro.replace(/-/g, ' ')).toContain(cardinal);
  });
});
