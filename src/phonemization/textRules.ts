/**
 * Text → words rules (most ported from kittentts.preprocess v0.8.1), used by
 * the shared pipeline (normalizeForSpeech) and the Kitten tail
 * (engineTails). Numbers become words through ./numberWords.
 */

import {lookupTable} from '../utils/lookupTable';

import {numberToWords, floatToWords, ordinalSuffix} from './numberWords';

const CURRENCY_SYMBOLS = lookupTable<string>({
  $: 'dollar',
  '€': 'euro',
  '£': 'pound',
  '¥': 'yen',
  '₹': 'rupee',
  '₩': 'won',
  '₿': 'bitcoin',
});

// ─────────────────────────────────────────────
// Regex patterns
// ─────────────────────────────────────────────

const RE_URL = /https?:\/\/\S+|www\.\S+/g;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi;
const RE_HTML = /<[^>]+>/g;
const RE_SPACES = /\s+/g;
const RE_NUMBER = /(?<![a-zA-Z])-?[\d,]+(?:\.\d+)?/g;
const RE_ORDINAL = /\b(\d+)(st|nd|rd|th)\b/gi;
const RE_PERCENT = /(-?[\d,]+(?:\.\d+)?)\s*%/g;
const RE_CURRENCY =
  /([$€£¥₹₩₿])\s*([\d,]+(?:\.\d+)?)\s*([KMBT])?(?![a-zA-Z\d])/g;
const RE_TIME = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
const RE_RANGE = /(?<!\w)(\d+)-(\d+)(?!\w)/g;
const RE_MODEL_VER = /\b([a-zA-Z][a-zA-Z0-9]*)-(\d[\d.]*)(?=[^\d.]|$)/g;
export const UNIT_NAMES =
  'km|kg|mg|ml|gb|mb|kb|tb|hz|khz|mhz|ghz|mph|kph|°[cCfF]|[cCfF]°|ms|ns|µs';
const RE_UNIT = new RegExp(
  `(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*(${UNIT_NAMES})\\b`,
  'gi',
);
const RE_SCI = /(?<![a-zA-Z\d])(-?\d+(?:\.\d+)?)[eE]([+-]?\d+)(?![a-zA-Z\d])/g;
const RE_FRACTION = /\b(\d+)\s*\/\s*(\d+)\b/g;
const RE_DECADE = /\b(\d{1,3})0s\b/g;
const RE_LEAD_DEC = /(?<!\d)\.([\d])/g;

// ─────────────────────────────────────────────
// Expansion helpers
// ─────────────────────────────────────────────

export function expandOrdinals(text: string): string {
  return text.replace(RE_ORDINAL, (_, num) => ordinalSuffix(parseInt(num, 10)));
}

export function expandPercentages(text: string): string {
  return text.replace(RE_PERCENT, (_, raw: string) => {
    const clean = raw.replace(/,/g, '');
    return clean.includes('.')
      ? `${floatToWords(clean)} percent`
      : `${numberToWords(parseInt(clean, 10))} percent`;
  });
}

export function expandCurrency(text: string): string {
  const scaleMap = lookupTable<string>({
    K: 'thousand',
    M: 'million',
    B: 'billion',
    T: 'trillion',
  });
  return text.replace(
    RE_CURRENCY,
    (_, symbol: string, rawIn: string, scaleSuffix?: string) => {
      const raw = rawIn.replace(/,/g, '');
      const unit = CURRENCY_SYMBOLS[symbol] || '';

      if (scaleSuffix) {
        const scaleWord = scaleMap[scaleSuffix]!;
        const num = raw.includes('.')
          ? floatToWords(raw)
          : numberToWords(parseInt(raw, 10));
        return `${num} ${scaleWord} ${unit}${unit ? 's' : ''}`.trim();
      }

      if (raw.includes('.')) {
        const [intPart, decPart] = raw.split('.');
        const decStr = (decPart || '').slice(0, 2).padEnd(2, '0');
        const decVal = parseInt(decStr, 10);
        const intWords = numberToWords(parseInt(intPart || '0', 10));
        let result = unit ? `${intWords} ${unit}s` : intWords;
        if (decVal) {
          const cents = numberToWords(decVal);
          result += ` and ${cents} cent${decVal !== 1 ? 's' : ''}`;
        }
        return result;
      }

      const val = parseInt(raw, 10);
      const words = numberToWords(val);
      return unit ? `${words} ${unit}${val !== 1 ? 's' : ''}` : words;
    },
  );
}

export function expandTime(text: string): string {
  return text.replace(
    RE_TIME,
    (
      _match: string,
      hStr: string,
      mStr: string,
      _s: string | undefined,
      suffixIn: string | undefined,
    ) => {
      const h = parseInt(hStr, 10);
      const mins = parseInt(mStr, 10);
      const suffix = suffixIn ? ` ${suffixIn.toLowerCase()}` : '';
      const hWords = numberToWords(h);
      if (mins === 0) {
        return !suffixIn ? `${hWords} hundred${suffix}` : `${hWords}${suffix}`;
      }
      if (mins < 10) {
        return `${hWords} oh ${numberToWords(mins)}${suffix}`;
      }
      return `${hWords} ${numberToWords(mins)}${suffix}`;
    },
  );
}

export function expandRanges(text: string): string {
  return text.replace(
    RE_RANGE,
    (_, lo: string, hi: string) =>
      `${numberToWords(parseInt(lo, 10))} to ${numberToWords(parseInt(hi, 10))}`,
  );
}

export function expandModelNames(text: string): string {
  return text.replace(
    RE_MODEL_VER,
    (_, name: string, ver: string) => `${name} ${ver}`,
  );
}

export function expandUnits(text: string): string {
  const unitMap = lookupTable<string>({
    km: 'kilometers',
    kg: 'kilograms',
    mg: 'milligrams',
    ml: 'milliliters',
    gb: 'gigabytes',
    mb: 'megabytes',
    kb: 'kilobytes',
    tb: 'terabytes',
    hz: 'hertz',
    khz: 'kilohertz',
    mhz: 'megahertz',
    ghz: 'gigahertz',
    mph: 'miles per hour',
    kph: 'kilometers per hour',
    ms: 'milliseconds',
    ns: 'nanoseconds',
    µs: 'microseconds',
    '°c': 'degrees Celsius',
    'c°': 'degrees Celsius',
    '°f': 'degrees Fahrenheit',
    'f°': 'degrees Fahrenheit',
  });
  return text.replace(RE_UNIT, (_, raw: string, unitIn: string) => {
    const unit = unitIn.toLowerCase();
    const expanded = unitMap[unit] || unitIn;
    const digits = raw.replace(/,/g, '');
    const num = digits.includes('.')
      ? floatToWords(digits)
      : numberToWords(parseInt(digits, 10));
    return `${num} ${expanded}`;
  });
}

export function normalizeLeadingDecimals(text: string): string {
  text = text.replace(/(?<!\d)(-)\.([\d])/g, '$10.$2');
  return text.replace(RE_LEAD_DEC, '0.$1');
}

export function expandScientificNotation(text: string): string {
  return text.replace(RE_SCI, (_, coeffRaw: string, expRaw: string) => {
    const exp = parseInt(expRaw, 10);
    const coeffWords = coeffRaw.includes('.')
      ? floatToWords(coeffRaw)
      : numberToWords(parseInt(coeffRaw, 10));
    const expWords = numberToWords(Math.abs(exp));
    const sign = exp < 0 ? 'negative ' : '';
    return `${coeffWords} times ten to the ${sign}${expWords}`;
  });
}

export function expandFractions(text: string): string {
  return text.replace(RE_FRACTION, (match: string, n1: string, n2: string) => {
    const num = parseInt(n1, 10);
    const den = parseInt(n2, 10);
    if (den === 0) return match;
    const numWords = numberToWords(num);
    let denomWord: string;
    if (den === 2) denomWord = num === 1 ? 'half' : 'halves';
    else if (den === 4) denomWord = num === 1 ? 'quarter' : 'quarters';
    else {
      denomWord = ordinalSuffix(den);
      if (num !== 1) denomWord += 's';
    }
    return `${numWords} ${denomWord}`;
  });
}

export function expandDecades(text: string): string {
  const decadeMap: Record<number, string> = {
    0: 'hundreds',
    1: 'tens',
    2: 'twenties',
    3: 'thirties',
    4: 'forties',
    5: 'fifties',
    6: 'sixties',
    7: 'seventies',
    8: 'eighties',
    9: 'nineties',
  };
  return text.replace(RE_DECADE, (_, baseStr: string) => {
    const base = parseInt(baseStr, 10);
    const decadeDigit = base % 10;
    const decadeWord = decadeMap[decadeDigit] || '';
    if (base < 10) return decadeWord;
    // "2000s" → "two thousands", not "twenty hundreds"
    if (base % 100 === 0) return `${numberToWords(base * 10)}s`;
    const centuryPart = Math.floor(base / 10);
    return `${numberToWords(centuryPart)} ${decadeWord}`;
  });
}

export function expandIpAddresses(text: string): string {
  const d = [
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
  const octet = (s: string): string =>
    s
      .split('')
      .map(c => d[parseInt(c, 10)]!)
      .join(' ');
  return text.replace(
    /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    (_, a: string, b: string, c: string, dd: string) =>
      [a, b, c, dd].map(octet).join(' dot '),
  );
}

export function expandPhoneNumbers(text: string): string {
  const d = [
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
  const digits = (s: string): string =>
    s
      .split('')
      .map(c => d[parseInt(c, 10)]!)
      .join(' ');
  // 11-digit: 1-800-555-0199
  text = text.replace(
    /(?<!\d-)(?<!\d)\b(\d{1,2})-(\d{3})-(\d{3})-(\d{4})\b(?!-\d)/g,
    (_, a: string, b: string, c: string, e: string) =>
      [a, b, c, e].map(digits).join(' '),
  );
  // 10-digit
  text = text.replace(
    /(?<!\d-)(?<!\d)\b(\d{3})-(\d{3})-(\d{4})\b(?!-\d)/g,
    (_, a: string, b: string, c: string) => [a, b, c].map(digits).join(' '),
  );
  // 7-digit
  text = text.replace(
    /(?<!\d-)\b(\d{3})-(\d{4})\b(?!-\d)/g,
    (_, a: string, b: string) => [a, b].map(digits).join(' '),
  );
  return text;
}

export function replaceNumbers(text: string, replaceFloats = true): string {
  return text.replace(RE_NUMBER, (whole: string) => {
    // RE_NUMBER's [\d,]+ swallows a trailing comma ("Q4, 2023").
    const trailing = /,+$/.exec(whole)?.[0] ?? '';
    const match = whole.slice(0, whole.length - trailing.length);
    if (!match) return whole;
    const raw = match.replace(/,/g, '');
    const toWords = (): string => {
      if (raw.includes('.') && replaceFloats) return floatToWords(raw);
      if (/^-?\d+$/.test(raw)) return numberToWords(raw);
      const n = parseInt(String(parseFloat(raw)), 10);
      if (!Number.isFinite(n)) return match;
      return numberToWords(n);
    };
    try {
      return toWords() + trailing;
    } catch {
      return whole;
    }
  });
}

export function removeUrls(text: string, replacement = ''): string {
  return text.replace(RE_URL, replacement).trim();
}
export function removeEmails(text: string, replacement = ''): string {
  return text.replace(RE_EMAIL, replacement).trim();
}
export function removeHtmlTags(text: string): string {
  return text.replace(RE_HTML, ' ');
}
export function removeExtraWhitespace(text: string): string {
  return text.replace(RE_SPACES, ' ').trim();
}
export function normalizeUnicode(
  text: string,
  form: 'NFC' | 'NFD' | 'NFKC' | 'NFKD' = 'NFC',
): string {
  return text.normalize(form);
}
