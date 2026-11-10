/**
 * Engine tails: the text → words steps where Kitten and Kokoro differ today,
 * run after the shared pipeline (normalizeForSpeech) by normalizeForEngine.
 *
 * - Kitten: the kittentts.preprocess steps KittenEngine enables, in their
 *   upstream order.
 * - Kokoro: the kokoro.js-derived steps (clock times split, money,
 *   decimals digit by digit, capital possessives, dotted acronyms, numbers
 *   joined with spaces, « » for parentheses).
 *
 * Known differences kept on purpose (#33 is a pure refactor): number words
 * joined with "-" vs " ", Kokoro's "PR'S" possessive and "package-json" dotted names, « ».
 */

import {numberToWords} from './numberWords';
import {splitCamelCase} from './splitCamelCase';
import {
  expandCurrency,
  expandDecades,
  expandIpAddresses,
  expandModelNames,
  expandOrdinals,
  expandPercentages,
  expandPhoneNumbers,
  expandRanges,
  expandScientificNotation,
  expandTime,
  expandUnits,
  normalizeLeadingDecimals,
  normalizeUnicode,
  removeEmails,
  removeExtraWhitespace,
  removeHtmlTags,
  removeUrls,
  replaceNumbers,
} from './textRules';

export function kittenTail(text: string): string {
  text = normalizeUnicode(text);
  text = removeHtmlTags(text);
  text = removeUrls(text);
  text = removeEmails(text);
  text = expandIpAddresses(text);
  text = normalizeLeadingDecimals(text);
  text = expandCurrency(text);
  text = expandPercentages(text);
  text = expandScientificNotation(text);
  text = expandTime(text);
  text = expandOrdinals(text);
  text = expandUnits(text);
  text = expandDecades(text);
  text = expandPhoneNumbers(text);
  text = expandRanges(text);
  text = expandModelNames(text);
  text = replaceNumbers(text);
  text = splitCamelCase(text);
  return removeExtraWhitespace(text);
}

/** Clock times split the kokoro.js way. */
function splitNum(match: string): string {
  if (match.includes('.')) {
    return match;
  } else if (match.includes(':')) {
    const parts = match.split(':').map(Number);
    const h = parts[0];
    const m = parts[1];
    if (m === 0) {
      return `${h} o'clock`;
    } else if (m !== undefined && m < 10) {
      return `${h} oh ${m}`;
    }
    return `${h} ${m}`;
  }

  return match;
}

/** Money in spoken form. */
function flipMoney(match: string): string {
  const bill = match[0] === '$' ? 'dollar' : 'pound';

  if (isNaN(Number(match.slice(1)))) {
    return `${match.slice(1)} ${bill}s`;
  } else if (!match.includes('.')) {
    const suffix = match.slice(1) === '1' ? '' : 's';
    return `${match.slice(1)} ${bill}${suffix}`;
  }

  const parts = match.slice(1).split('.');
  const b = parts[0];
  const c = parts[1];
  if (!c) {
    return match;
  }
  const d = parseInt(c.padEnd(2, '0'), 10);
  const coins =
    match[0] === '$'
      ? d === 1
        ? 'cent'
        : 'cents'
      : d === 1
        ? 'penny'
        : 'pence';

  return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`;
}

/** Decimals read digit by digit. */
function pointNum(match: string): string {
  const parts = match.split('.');
  const a = parts[0];
  const b = parts[1];
  if (!b) {
    return match;
  }
  return `${a} point ${b.split('').join(' ')}`;
}

export function kokoroTail(text: string): string {
  let result = text;

  // 1. Handle quotes and brackets
  // Use Unicode escapes for reliability
  result = result
    .replace(/[\u2018\u2019]/g, "'") // Curly single quotes to straight
    .replace(/\u00ab/g, '"') // « to "
    .replace(/\u00bb/g, '"') // » to "
    .replace(/[\u201c\u201d]/g, '"') // Curly double quotes to straight
    .replace(/\(/g, '\u00ab') // ( to «
    .replace(/\)/g, '\u00bb'); // ) to »

  // 2. Replace uncommon punctuation marks (CJK etc.)
  result = result
    .replace(/、/g, ', ')
    .replace(/。/g, '. ')
    .replace(/！/g, '! ')
    .replace(/，/g, ', ')
    .replace(/：/g, ': ')
    .replace(/；/g, '; ')
    .replace(/？/g, '? ');

  // 3. Whitespace normalization
  result = result
    .replace(/[^\S \n]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '');

  // 4. Abbreviations
  result = result
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc');

  // 5. Normalize casual words
  result = result.replace(/\b(y)eah?\b/gi, "$1e'a");

  // 6. Handle numbers and currencies
  // Clock times
  result = result.replace(
    /\d*\.\d+|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g,
    m => splitNum(m),
  );

  // Remove commas from numbers
  result = result.replace(/(?<=\d),(?=\d)/g, '');

  // Currency handling
  result = result.replace(
    /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
    m => flipMoney(m),
  );

  // Decimal numbers (after currency to avoid conflicts)
  result = result.replace(/\d*\.\d+/g, m => pointNum(m));

  // Number ranges (10-20 -> 10 to 20)
  result = result.replace(/(?<=\d)-(?=\d)/g, ' to ');

  // Uppercase S after number (10S -> 10 S)
  result = result.replace(/(?<=\d)S/g, ' S');

  // 7. Handle possessives
  // result = result.replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S");
  // result = result.replace(/(?<=X')S\b/g, 's');
  // ALL-CAPS words (>=2 letters)
  result = result.replace(/(?<=\b[A-Z]{2,})'?s\b/g, "'S");
  // single-letter uppercase tokens (C's, B's, "G 2 Ps"); not the words
  // "As", "Is", "Us" unless written with the apostrophe
  result = result.replace(/(?<=\b[A-Z])'s\b|(?<=\b[B-HJ-TV-Z])s\b/g, "'S");
  // X → /ɪz/ exception
  result = result.replace(/(?<=X')S\b/g, 's');

  // 8. Handle acronyms with periods (U.S.A. -> U-S-A-)
  result = result.replace(/(?:[A-Za-z]\.){2,} [a-z]/g, m =>
    m.replace(/\./g, '-'),
  );
  result = result.replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-');

  // 9. Convert any remaining bare integers to words. Digits left here
  // would be dropped by the phonemizer (silence), so larger numbers and
  // plurals ("2022s") are covered too.
  result = result.replace(/\b(\d+)(s?)\b/g, (_m, digits: string, s: string) => {
    const n = parseInt(digits, 10);
    const words =
      n <= 999999
        ? numberToWords(n, {joiner: ' ', groupHundreds: false})
        : numberToWords(digits).replace(/-/g, ' ');
    if (!s) return words;
    return words.endsWith('y')
      ? `${words.slice(0, -1)}ies`
      : words.endsWith('x')
        ? `${words}es`
        : `${words}s`;
  });

  // 10. Split camelCase / PascalCase tokens so each part is phonemized
  // independently (e.g. "PrismML" → "Prism ML", "iOS's" → "i OS's").
  // Conservative — won't touch iPhone, McDonald, JavaScript, etc.
  result = splitCamelCase(result);

  // 11. Strip leading and trailing whitespace
  return result.trim();
}
