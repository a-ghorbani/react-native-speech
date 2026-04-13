/**
 * Kitten TextPreprocessor — 1-to-1 port of kittentts.preprocess (v0.8.1).
 *
 * Also exports chunkText + ensurePunctuation from kittentts.onnx_model.
 *
 * Pipeline order and defaults match upstream. The Kitten reference uses
 * `TextPreprocessor(remove_punctuation=False)`.
 */

// ─────────────────────────────────────────────
// Number → words
// ─────────────────────────────────────────────

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

const ORDINAL_EXCEPTIONS: Record<string, string> = {
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
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'dollar',
  '€': 'euro',
  '£': 'pound',
  '¥': 'yen',
  '₹': 'rupee',
  '₩': 'won',
  '₿': 'bitcoin',
};

function threeDigitsToWords(n: number): string {
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
    parts.push(onesWord ? `${tensWord}-${onesWord}` : tensWord);
  }
  return parts.join(' ');
}

export function numberToWords(input: number | string): string {
  let n = typeof input === 'number' ? input : parseInt(input, 10);
  if (!Number.isInteger(n)) n = parseInt(String(n), 10);
  if (n === 0) return 'zero';
  if (n < 0) return `negative ${numberToWords(-n)}`;

  // X00–X999 read as "X hundred" (e.g. 1200 → "twelve hundred")
  if (n >= 100 && n <= 9999 && n % 100 === 0 && n % 1000 !== 0) {
    const hundreds = Math.floor(n / 100);
    if (hundreds < 20) return `${ONES[hundreds]} hundred`;
  }

  const parts: string[] = [];
  for (let i = 0; i < SCALE.length; i++) {
    const chunk = n % 1000;
    if (chunk) {
      const chunkWords = threeDigitsToWords(chunk);
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
    const intWords = intPart ? numberToWords(parseInt(intPart, 10)) : 'zero';
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

function romanToInt(s: string): number {
  const val: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let result = 0;
  let prev = 0;
  for (const ch of s.toUpperCase().split('').reverse()) {
    const curr = val[ch] ?? 0;
    result += curr >= prev ? curr : -curr;
    prev = curr;
  }
  return result;
}

// ─────────────────────────────────────────────
// Regex patterns
// ─────────────────────────────────────────────

const RE_URL = /https?:\/\/\S+|www\.\S+/g;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi;
const RE_HASHTAG = /#\w+/g;
const RE_MENTION = /@\w+/g;
const RE_HTML = /<[^>]+>/g;
const RE_PUNCT = /[^\w\s.,?!;:\-\u2014\u2013\u2026]/g;
const RE_SPACES = /\s+/g;
const RE_NUMBER = /(?<![a-zA-Z])-?[\d,]+(?:\.\d+)?/g;
const RE_ORDINAL = /\b(\d+)(st|nd|rd|th)\b/gi;
const RE_PERCENT = /(-?[\d,]+(?:\.\d+)?)\s*%/g;
const RE_CURRENCY =
  /([$€£¥₹₩₿])\s*([\d,]+(?:\.\d+)?)\s*([KMBT])?(?![a-zA-Z\d])/g;
const RE_TIME = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
const RE_RANGE = /(?<!\w)(\d+)-(\d+)(?!\w)/g;
const RE_MODEL_VER = /\b([a-zA-Z][a-zA-Z0-9]*)-(\d[\d.]*)(?=[^\d.]|$)/g;
const RE_UNIT =
  /(\d+(?:\.\d+)?)\s*(km|kg|mg|ml|gb|mb|kb|tb|hz|khz|mhz|ghz|mph|kph|°[cCfF]|[cCfF]°|ms|ns|µs)\b/gi;
const RE_SCALE = /(?<![a-zA-Z])(\d+(?:\.\d+)?)\s*([KMBT])(?![a-zA-Z\d])/g;
const RE_SCI = /(?<![a-zA-Z\d])(-?\d+(?:\.\d+)?)[eE]([+-]?\d+)(?![a-zA-Z\d])/g;
const RE_FRACTION = /\b(\d+)\s*\/\s*(\d+)\b/g;
const RE_DECADE = /\b(\d{1,3})0s\b/g;
const RE_LEAD_DEC = /(?<!\d)\.([\d])/g;
const RE_ROMAN =
  /\b(M{0,4})(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})\b/g;

// ─────────────────────────────────────────────
// Expansion helpers
// ─────────────────────────────────────────────

function ordinalSuffix(n: number): string {
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
  const scaleMap: Record<string, string> = {
    K: 'thousand',
    M: 'million',
    B: 'billion',
    T: 'trillion',
  };
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
  const unitMap: Record<string, string> = {
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
  };
  return text.replace(RE_UNIT, (_, raw: string, unitIn: string) => {
    const unit = unitIn.toLowerCase();
    const expanded = unitMap[unit] || unitIn;
    const num = raw.includes('.')
      ? floatToWords(raw)
      : numberToWords(parseInt(raw, 10));
    return `${num} ${expanded}`;
  });
}

export function expandRomanNumerals(text: string): string {
  const TITLE_WORDS =
    /\b(war|chapter|part|volume|act|scene|book|section|article|king|queen|pope|louis|henry|edward|george|william|james|phase|round|level|stage|class|type|version|episode|season)\b/i;
  return text.replace(RE_ROMAN, (roman: string, ...args: unknown[]) => {
    if (!roman.trim()) return roman;
    if (roman.length === 1 && 'IVX'.includes(roman)) {
      const offset = args[args.length - 2] as number;
      const preceding = text.slice(Math.max(0, offset - 30), offset);
      if (!TITLE_WORDS.test(preceding)) return roman;
    }
    try {
      const val = romanToInt(roman);
      if (val === 0) return roman;
      return numberToWords(val);
    } catch {
      return roman;
    }
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

export function expandScaleSuffixes(text: string): string {
  const map: Record<string, string> = {
    K: 'thousand',
    M: 'million',
    B: 'billion',
    T: 'trillion',
  };
  return text.replace(RE_SCALE, (_, raw: string, suffix: string) => {
    const scaleWord = map[suffix] || suffix;
    const num = raw.includes('.')
      ? floatToWords(raw)
      : numberToWords(parseInt(raw, 10));
    return `${num} ${scaleWord}`;
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
  return text.replace(RE_NUMBER, (match: string) => {
    const raw = match.replace(/,/g, '');
    try {
      if (raw.includes('.') && replaceFloats) return floatToWords(raw);
      const n = parseInt(String(parseFloat(raw)), 10);
      if (!Number.isFinite(n)) return match;
      return numberToWords(n);
    } catch {
      return match;
    }
  });
}

export function toLowercase(text: string): string {
  return text.toLowerCase();
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
export function removeHashtags(text: string, replacement = ''): string {
  return text.replace(RE_HASHTAG, replacement);
}
export function removeMentions(text: string, replacement = ''): string {
  return text.replace(RE_MENTION, replacement);
}
export function removePunctuation(text: string): string {
  return text.replace(RE_PUNCT, ' ');
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
export function removeAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function expandContractions(text: string): string {
  // Order matters: specific before generic
  const specific: [RegExp, string][] = [
    [/\bcan't\b/gi, 'cannot'],
    [/\bwon't\b/gi, 'will not'],
    [/\bshan't\b/gi, 'shall not'],
    [/\bain't\b/gi, 'is not'],
    [/\blet's\b/gi, 'let us'],
  ];
  for (const [p, r] of specific) text = text.replace(p, r);
  const generic: [RegExp, string][] = [
    [/\b(\w+)n't\b/gi, '$1 not'],
    [/\b(\w+)'re\b/gi, '$1 are'],
    [/\b(\w+)'ve\b/gi, '$1 have'],
    [/\b(\w+)'ll\b/gi, '$1 will'],
    [/\b(\w+)'d\b/gi, '$1 would'],
    [/\b(\w+)'m\b/gi, '$1 am'],
  ];
  for (const [p, r] of generic) text = text.replace(p, r);
  text = text.replace(/\bit's\b/gi, 'it is');
  return text;
}

// ─────────────────────────────────────────────
// TextPreprocessor pipeline
// ─────────────────────────────────────────────

export interface TextPreprocessorConfig {
  lowercase: boolean;
  replaceNumbers: boolean;
  replaceFloats: boolean;
  expandContractions: boolean;
  expandModelNames: boolean;
  expandOrdinals: boolean;
  expandPercentages: boolean;
  expandCurrency: boolean;
  expandTime: boolean;
  expandRanges: boolean;
  expandUnits: boolean;
  expandScaleSuffixes: boolean;
  expandScientificNotation: boolean;
  expandFractions: boolean;
  expandDecades: boolean;
  expandPhoneNumbers: boolean;
  expandIpAddresses: boolean;
  normalizeLeadingDecimals: boolean;
  expandRomanNumerals: boolean;
  removeUrls: boolean;
  removeEmails: boolean;
  removeHtml: boolean;
  removeHashtags: boolean;
  removeMentions: boolean;
  removePunctuation: boolean;
  normalizeUnicode: boolean;
  removeAccents: boolean;
  removeExtraWhitespace: boolean;
}

const DEFAULT_CONFIG: TextPreprocessorConfig = {
  lowercase: true,
  replaceNumbers: true,
  replaceFloats: true,
  expandContractions: true,
  expandModelNames: true,
  expandOrdinals: true,
  expandPercentages: true,
  expandCurrency: true,
  expandTime: true,
  expandRanges: true,
  expandUnits: true,
  expandScaleSuffixes: true,
  expandScientificNotation: true,
  expandFractions: true,
  expandDecades: true,
  expandPhoneNumbers: true,
  expandIpAddresses: true,
  normalizeLeadingDecimals: true,
  expandRomanNumerals: false,
  removeUrls: true,
  removeEmails: true,
  removeHtml: true,
  removeHashtags: false,
  removeMentions: false,
  removePunctuation: true,
  normalizeUnicode: true,
  removeAccents: false,
  removeExtraWhitespace: true,
};

export class TextPreprocessor {
  private readonly cfg: TextPreprocessorConfig;

  constructor(overrides: Partial<TextPreprocessorConfig> = {}) {
    this.cfg = {...DEFAULT_CONFIG, ...overrides};
  }

  process(text: string): string {
    const c = this.cfg;
    if (c.normalizeUnicode) text = normalizeUnicode(text);
    if (c.removeHtml) text = removeHtmlTags(text);
    if (c.removeUrls) text = removeUrls(text);
    if (c.removeEmails) text = removeEmails(text);
    if (c.removeHashtags) text = removeHashtags(text);
    if (c.removeMentions) text = removeMentions(text);
    if (c.expandContractions) text = expandContractions(text);
    if (c.expandIpAddresses) text = expandIpAddresses(text);
    if (c.normalizeLeadingDecimals) text = normalizeLeadingDecimals(text);
    if (c.expandCurrency) text = expandCurrency(text);
    if (c.expandPercentages) text = expandPercentages(text);
    if (c.expandScientificNotation) text = expandScientificNotation(text);
    if (c.expandTime) text = expandTime(text);
    if (c.expandOrdinals) text = expandOrdinals(text);
    if (c.expandUnits) text = expandUnits(text);
    if (c.expandScaleSuffixes) text = expandScaleSuffixes(text);
    if (c.expandFractions) text = expandFractions(text);
    if (c.expandDecades) text = expandDecades(text);
    if (c.expandPhoneNumbers) text = expandPhoneNumbers(text);
    if (c.expandRanges) text = expandRanges(text);
    if (c.expandModelNames) text = expandModelNames(text);
    if (c.expandRomanNumerals) text = expandRomanNumerals(text);
    if (c.replaceNumbers) text = replaceNumbers(text, c.replaceFloats);
    if (c.removeAccents) text = removeAccents(text);
    if (c.removePunctuation) text = removePunctuation(text);
    if (c.lowercase) text = toLowercase(text);
    if (c.removeExtraWhitespace) text = removeExtraWhitespace(text);
    return text;
  }
}

// ─────────────────────────────────────────────
// Chunking (from kittentts.onnx_model)
// ─────────────────────────────────────────────

export function ensurePunctuation(text: string): string {
  text = text.trim();
  if (!text) return text;
  if (!'.!?,;:'.includes(text[text.length - 1]!)) text += ',';
  return text;
}

export function chunkText(text: string, maxLen = 400): string[] {
  const sentences = text.split(/[.!?]+/);
  const chunks: string[] = [];
  for (let sentence of sentences) {
    sentence = sentence.trim();
    if (!sentence) continue;
    if (sentence.length <= maxLen) {
      chunks.push(ensurePunctuation(sentence));
    } else {
      const words = sentence.split(/\s+/);
      let temp = '';
      for (const word of words) {
        if (temp.length + word.length + 1 <= maxLen) {
          temp = temp ? temp + ' ' + word : word;
        } else {
          if (temp) chunks.push(ensurePunctuation(temp.trim()));
          temp = word;
        }
      }
      if (temp) chunks.push(ensurePunctuation(temp.trim()));
    }
  }
  return chunks;
}
