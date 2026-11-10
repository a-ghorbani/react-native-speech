/**
 * Number → words, for every text rule on the speech path (one module).
 *
 * `numberToWords` defaults to the hyphenated style ("twenty-one",
 * "twelve hundred"). The Kokoro tail asks for `{joiner: ' ',
 * groupHundreds: false}`, its kokoro.js-era style ("twenty one", "one
 * thousand two hundred").
 */

import {lookupTable} from '../utils/lookupTable';

const ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

const SCALE = ['', 'thousand', 'million', 'billion', 'trillion'];

const ORDINAL_EXCEPTIONS = lookupTable<string>({
  one: 'first',
  two: 'second',
  three: 'third',
  four: 'fourth',
  five: 'fifth',
  six: 'sixth',
  seven: 'seventh',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
});

function threeDigitsToWords(n: number, joiner: string): string {
  if (n === 0) return '';
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (remainder < 20) {
    if (remainder) parts.push(ONES[remainder]!);
  } else {
    const tensWord = TENS[Math.floor(remainder / 10)]!;
    const onesWord = ONES[remainder % 10]!;
    parts.push(onesWord ? `${tensWord}${joiner}${onesWord}` : tensWord);
  }
  return parts.join(' ');
}

/**
 * Digit strings longer than this are read digit by digit: past ~10^15
 * the scale words run out and float precision drops digits, so the
 * cardinal reading would silently be a different number. Such strings
 * are IDs, card or account numbers in practice.
 */
const MAX_CARDINAL_DIGITS = 15;
const DIGIT_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];

function digitsToWords(digits: string): string {
  return Array.from(digits, d => DIGIT_WORDS[+d]!).join(' ');
}

export interface NumberWordsStyle {
  /** Between tens and ones: "-" (default) or " ". */
  joiner?: string;
  /** Read 1100–1900 as "eleven hundred" … (default) rather than "one thousand one hundred". */
  groupHundreds?: boolean;
}

export function numberToWords(
  input: number | string,
  {joiner = '-', groupHundreds = true}: NumberWordsStyle = {},
): string {
  const str = String(input).replace(/^-/, '');
  if (/^\d+$/.test(str) && str.length > MAX_CARDINAL_DIGITS) {
    const words = digitsToWords(str);
    return String(input).startsWith('-') ? `negative ${words}` : words;
  }
  let n = typeof input === 'number' ? input : parseInt(input, 10);
  if (!Number.isInteger(n)) n = parseInt(String(n), 10);
  if (n === 0) return 'zero';
  if (n < 0) return `negative ${numberToWords(-n, {joiner, groupHundreds})}`;

  // X00–X999 read as "X hundred" (e.g. 1200 → "twelve hundred")
  if (
    groupHundreds &&
    n >= 100 &&
    n <= 9999 &&
    n % 100 === 0 &&
    n % 1000 !== 0
  ) {
    const hundreds = Math.floor(n / 100);
    if (hundreds < 20) return `${ONES[hundreds]} hundred`;
  }

  const parts: string[] = [];
  for (let i = 0; i < SCALE.length; i++) {
    const chunk = n % 1000;
    if (chunk) {
      const chunkWords = threeDigitsToWords(chunk, joiner);
      const scale = SCALE[i]!;
      parts.push(scale ? `${chunkWords} ${scale}`.trim() : chunkWords);
    }
    n = Math.floor(n / 1000);
    if (n === 0) break;
  }
  return parts.reverse().join(' ');
}

export function floatToWords(
  value: number | string,
  decimalSep = 'point',
): string {
  let text = typeof value === 'string' ? value : String(value);
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);

  let result: string;
  if (text.includes('.')) {
    const [intPart, decPart] = text.split('.');
    const intWords = intPart ? numberToWords(intPart) : 'zero';
    const digitMap = ['zero', ...ONES.slice(1)];
    const decWords = (decPart || '')
      .split('')
      .map(d => digitMap[parseInt(d, 10)]!)
      .join(' ');
    result = `${intWords} ${decimalSep} ${decWords}`;
  } else {
    result = numberToWords(parseInt(text, 10));
  }
  return negative ? `negative ${result}` : result;
}

export function ordinalSuffix(n: number): string {
  const word = numberToWords(n);
  let prefix: string;
  let last: string;
  let joiner: string;
  if (word.includes('-')) {
    const idx = word.lastIndexOf('-');
    prefix = word.slice(0, idx);
    last = word.slice(idx + 1);
    joiner = '-';
  } else {
    const idx = word.lastIndexOf(' ');
    if (idx >= 0) {
      prefix = word.slice(0, idx);
      last = word.slice(idx + 1);
      joiner = ' ';
    } else {
      prefix = '';
      last = word;
      joiner = '';
    }
  }

  let lastOrd: string;
  const exception = ORDINAL_EXCEPTIONS[last];
  if (exception) {
    lastOrd = exception;
  } else if (last.endsWith('t')) {
    lastOrd = last + 'h';
  } else if (last.endsWith('e')) {
    lastOrd = last.slice(0, -1) + 'th';
  } else {
    lastOrd = last + 'th';
  }
  return prefix ? `${prefix}${joiner}${lastOrd}` : lastOrd;
}
