/**
 * normalizeForSpeech — shared English text cleanup for LLM-generated input.
 *
 * Runs per chunk (after markdown stripping and sentence chunking) ahead of
 * the engine-specific normalizers (Kitten TextPreprocessor, Kokoro
 * TextNormalizer). It verbalizes things both engines previously dropped or
 * garbled because the phonemizer only understands letters:
 *
 *   - typographic quotes/apostrophes  ("don’t" → "don't")
 *   - emails and URLs                 ("a@b.com" → "a at b dot com")
 *   - Latin abbreviations             ("e.g." → "for example")
 *   - symbols                         ("&" → "and", "2 + 2 = 4")
 *   - ordinals, percentages, units    ("5th", "12%", "2GB")
 *   - letter/digit tokens             ("GPT-4o" → "GPT 4 o")
 *   - dotted acronyms                 ("U.S." → "U-S-", spelled by the
 *                                      phonemizer's letter-sequence layer)
 *
 * Every step is idempotent on its own output, so the downstream engine
 * normalizers can still run their (overlapping) expansions safely.
 */

import {
  expandDecades,
  expandFractions,
  expandIpAddresses,
  expandOrdinals,
  expandPercentages,
  expandScientificNotation,
  expandUnits,
} from './KittenPreprocessor';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const EXTRA_UNITS: Record<string, string> = {
  ft: 'feet',
  lb: 'pounds',
  lbs: 'pounds',
  oz: 'ounces',
  cm: 'centimeters',
  mm: 'millimeters',
  sec: 'seconds',
  secs: 'seconds',
  min: 'minutes',
  mins: 'minutes',
  hr: 'hours',
  hrs: 'hours',
};

const CURRENCY_NAMES: Record<string, string> = {
  $: 'dollars',
  '€': 'euros',
  '£': 'pounds',
};

const TLDS =
  'com|org|net|io|ai|dev|app|edu|gov|uk|de|fr|jp|cn|ca|au|info|biz|xyz|tech|gg|tv|ly';

const RE_EMAIL = /\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)*\.[A-Za-z][\w-]*)\b/g;
const RE_URL = new RegExp(
  `\\b(?:https?:\\/\\/)?(?:www\\.)?((?:[a-z0-9-]{2,}\\.)+(?:${TLDS}))\\b(?:\\/[^\\s)\\]]*[^\\s)\\].,;:!?])?\\/?`,
  'gi',
);

function speakDomain(domain: string): string {
  return domain.split('.').join(' dot ');
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function normalizeQuotes(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, e: string) =>
      e === '#39' ? "'" : HTML_ENTITIES[e]!,
    )
    .replace(/[‘’‛′ʼ＇]/g, "'")
    .replace(/[“”„‟″＂]/g, '"');
}

export function verbalizeEmailsAndUrls(text: string): string {
  text = text.replace(
    RE_EMAIL,
    (_, user: string, domain: string) =>
      `${user.replace(/[._]/g, ' ')} at ${speakDomain(domain)}`,
  );
  // Package specs ("react@18.3.1") are not emails.
  text = text.replace(/(?<=\w)@(?=\d)/g, ' at ');
  // Read only the host of a URL — paths and query strings are noise
  // when spoken. Scheme-less hosts are only matched against a TLD list
  // so "Node.js" / "e.g" aren't treated as domains.
  return text.replace(RE_URL, (match: string, host: string, offset: number) =>
    // Not inside a longer token.
    offset > 0 && /[@\w]/.test(text[offset - 1]!)
      ? match
      : speakDomain(host.toLowerCase()),
  );
}

export function expandLatinAbbreviations(text: string): string {
  return (
    text
      .replace(/\be\.g\.,?/gi, 'for example,')
      .replace(/\bi\.e\.,?/gi, 'that is,')
      // Lowercase only: "VS Code" is a product, not "versus".
      .replace(/\b[vV]s\.(?=\s)|\bvs(?=\s)/g, 'versus')
      .replace(/\bapprox\.(?=\s)/gi, 'approximately')
      .replace(/\bcf\.(?=\s)/gi, 'compare')
      // Titles before a name: the period would otherwise read as a
      // sentence end ("Doctor. Smith").
      .replace(/\b(?:Dr|DR)\.(?=\s+[A-Z])/g, 'Doctor')
      .replace(/\b(?:Mrs|MRS)\.(?=\s+[A-Z])/g, 'Missus')
      .replace(/\b(?:Mr|MR)\.(?=\s+[A-Z])/g, 'Mister')
      // "MS." is usually the degree or Microsoft, not a title.
      .replace(/\bMs\.(?=\s+[A-Z])/g, 'Miss')
      .replace(/\b(?:Prof|PROF)\.(?=\s+[A-Z])/g, 'Professor')
      .replace(/,,/g, ',')
  );
}

export function verbalizeSymbols(text: string): string {
  return (
    text
      // "&" in prose and in compounds ("R&D", "AT&T")
      .replace(/\s*&\s*/g, ' and ')
      // Arrows used in LLM lists ("A → B", "A -> B")
      .replace(/\s*(?:→|->|⟶|=>)\s*/g, ' to ')
      // Comparisons. Spoken before any HTML-tag stripping, which would
      // otherwise delete "b and c" from "a < b and c > d". A "<" glued to
      // a letter ("<b>") is left alone as markup, and so is a ">" after
      // sentence punctuation (an inline blockquote marker).
      .replace(/\s*(?:<=|≤)\s*(?=[\w(-])/g, ' less than or equal to ')
      .replace(/\s*(?:>=|≥)\s*(?=[\w(-])/g, ' greater than or equal to ')
      .replace(/\s*≠\s*/g, ' not equal to ')
      .replace(/\s*≈\s*/g, ' approximately ')
      // Numeric comparisons only ("x < 5", "n>3", "5 > 3").
      .replace(
        /(?<=[\w)]\s?)<(?=\s?-?\d)|(?<=\d\s?)<(?=\s?[\w(])/g,
        ' less than ',
      )
      .replace(
        /(?<=[\w)]\s?)>(?=\s?-?\d)|(?<=\d\s?)>(?=\s?[\w(])/g,
        ' greater than ',
      )
      // Other spaced "<"/">" between words are mostly menu paths
      // ("Settings > Privacy"): read as a pause.
      .replace(/(?<=[\w)])\s[<>]\s(?=\S)/g, ', ')
      // Arithmetic: only between operands, so "C++" and list bullets
      // keep their meaning.
      .replace(/(?<=[\w)])\s*\+\s*(?=[\w(])/g, ' plus ')
      .replace(/(?<=[\w)])\s+=\s+(?=[\w($€£-])/g, ' equals ')
      .replace(/(?<=\d)(?:\s*×\s*|\s+x\s+)(?=\d)/g, ' times ')
      .replace(/(?<=\s|^)~\s*(?=\d)/g, 'about ')
      .replace(/(?<=\s|^)#(?=\d)/g, 'number ')
      // Drawn-out interjections beyond the dict's longest forms ("hmmm",
      // "mmm", "shh"): "Hmmmmm" → "Hmmm".
      .replace(/\b([Hh])m{4,}\b/g, '$1mmm')
      .replace(/\b([Mm])m{3,}\b/g, '$1mm')
      .replace(/\b([Ss])h{3,}\b/g, '$1hh')
      // snake_case identifiers ("max_tokens", "x86_64")
      .replace(/(?<=[A-Za-z\d])_(?=[A-Za-z\d])/g, ' ')
      // "w/o", "w/" shorthands; single-letter pairs ("N/A", "A/B") are
      // spelled — "A" alone would be read as the article.
      .replace(/\b[Ww]\/[Oo]\b/g, 'without')
      .replace(/\b[Ww]\/(?=\s)/g, 'with')
      .replace(/\b([A-Za-z])\/([A-Za-z])\b/g, '$1-$2-')
      // Slash between words ("and/or", "input/output")
      .replace(/(?<=[A-Za-z])\/(?=[A-Za-z])/g, ' ')
  );
}

/** True when only whitespace, or whitespace + a capitalized word, follows. */
function endsSentence(src: string, end: number): boolean {
  return /^(?:\s*$|\s+[A-Z])/.test(src.slice(end));
}

export function expandClockTimes(text: string): string {
  // "3:30" → "3 30", "3:05" → "3 oh 5", "3:00 pm" → "3 pm", "3:00" →
  // "3 o'clock". Digits are left for the engine number expansion.
  return text.replace(
    /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?![\d:])(\s*[ap]\.?m\b\.?)?/gi,
    (
      _m: string,
      h: string,
      mm: string,
      ss: string | undefined,
      suffix: string | undefined,
    ) => {
      // Durations / timestamps with seconds: read every part.
      if (ss !== undefined) {
        return `${parseInt(h, 10)} ${mm} ${ss}${suffix ?? ''}`;
      }
      const mins = parseInt(mm, 10);
      const sfx = suffix ?? '';
      if (mins === 0)
        return suffix
          ? `${parseInt(h, 10)}${sfx}`
          : `${parseInt(h, 10)} o'clock`;
      if (mins < 10) return `${parseInt(h, 10)} oh ${mins}${sfx}`;
      return `${parseInt(h, 10)} ${mins}${sfx}`;
    },
  );
}

export function spellTimeSuffixes(text: string): string {
  // "10am", "10 a.m.", "3:30 PM" → "a-m-" / "p-m-", spelled as letters.
  // "am" alone would otherwise hit the dictionary as the verb.
  return text.replace(
    /(?<=\d\s?)([ap])\.?m\b(\.?)/gi,
    (m: string, l: string, dot: string, offset: number, src: string) =>
      `${l.toLowerCase()}-m-${dot && endsSentence(src, offset + m.length) ? '.' : ''}`,
  );
}

const SCALE_WORDS: Record<string, string> = {
  k: 'thousand',
  m: 'million',
  b: 'billion',
  t: 'trillion',
};

export function expandScaledCurrency(text: string): string {
  // "$4.2 billion" / "$2.5M" → "4.2 billion dollars" (otherwise read as
  // "four dollars and twenty cents billion").
  return text
    .replace(
      /([$€£])\s?(\d[\d,]*(?:\.\d+)?)\s+(thousand|million|billion|trillion)\b/gi,
      (_m: string, sym: string, num: string, scale: string) =>
        `${num} ${scale} ${CURRENCY_NAMES[sym]}`,
    )
    .replace(
      /([$€£])\s?(\d[\d,]*(?:\.\d+)?)(bn|mn|[KMBTkmbt])(?![A-Za-z\d])/g,
      (_m: string, sym: string, num: string, scale: string) =>
        `${num} ${SCALE_WORDS[scale.toLowerCase()[0]!]} ${CURRENCY_NAMES[sym]}`,
    );
}

export function expandNumericForms(text: string): string {
  return (
    text
      // ISO dates: "2024-05-01" → "May 1st, 2024"
      .replace(
        /\b(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g,
        (_m: string, y: string, mo: string, d: string) => {
          const day = parseInt(d, 10);
          const sfx =
            day % 10 === 1 && day !== 11
              ? 'st'
              : day % 10 === 2 && day !== 12
                ? 'nd'
                : day % 10 === 3 && day !== 13
                  ? 'rd'
                  : 'th';
          return `${MONTHS[parseInt(mo, 10) - 1]} ${day}${sfx}, ${y}`;
        },
      )
      // Time ranges: "9am-5pm", "9:00am–5:30pm" → "... to ..."
      .replace(/(\d(?::\d\d)?\s?[ap]\.?m\.?)\s*[-–—]\s*(?=\d)/gi, '$1 to ')
      // Model sizes: "Qwen2.5-7B", "Llama-3.1-8B" — not a range. Needs a
      // name in the same token, so "7-13B" stays a range.
      .replace(/(?<=[A-Za-z][\w.-]*\d)-(?=\d+(?:\.\d+)?[BMK]\b)/g, ' ')
      // Percentage ranges: "10-20%" (else "-20%" reads as negative)
      .replace(/(?<=\d)-(?=\d[\d.]*\s*%)/g, ' to ')
      // Code ranges: "Q1-Q4" → "Q1 to Q4"
      .replace(/(?<=[A-Za-z]\d+)-(?=[A-Za-z]+\d)/g, ' to ')
      // Dimensions: "4x4", "1920x1080" → "by"
      .replace(/(?<=\d)x(?=\d)/g, ' by ')
      // Ranges with an en/em dash: "10–20" → "10 to 20"
      .replace(/(?<=\d)\s*[–—]\s*(?=\d)/g, ' to ')
      // Leading minus: "-5", "−5" → "minus 5" (not "5-10" ranges, not bullets)
      .replace(/(?<![\w.])[-−](?=\d)/g, 'minus ')
      // Exponents and multipliers: "10^6", "1.5x faster", "3x"
      .replace(/(?<=\d)\s*\^\s*(?=\d)/g, ' to the power of ')
      .replace(/(?<=\d)x\b/g, ' times')
      // Single-digit K is usually a name ("4K video", "5K run"), not a
      // count; multi-digit is a count ("100k users").
      .replace(/\b([1-9])K\b/g, '$1 kay')
      .replace(/(?<=\d)k\b/g, ' thousand')
      // "3 ML models" / "2 MS degrees" are acronyms, not milliliters /
      // milliseconds (those are written lowercase). Emitted as lowercase
      // spelled letters so the uppercase scale rule ("3 M" → million)
      // can't match either.
      .replace(
        /(?<=\d\s?)(ML|MS)\b/g,
        (m: string) => `${m[0]!.toLowerCase()}-${m[1]!.toLowerCase()}-`,
      )
      // "100s of users": not a decade
      .replace(/\b100s\b/g, 'hundreds')
      .replace(/\b1000s\b/g, 'thousands')
      // Common units the shared unit list lacks: "6ft", "5 min", "2 lbs"
      .replace(
        /(?<=\d)\s?(ft|lbs?|oz|cm|mm|secs?|mins?|hrs?)\b/g,
        (_m: string, u: string) => ` ${EXTRA_UNITS[u]}`,
      )
      // Bare version triples: "2.1.0" → "2 point 1 point 0" (not IPs)
      .replace(
        /(?<![\d.])(\d+)\.(\d+)\.(\d+)(?!\.?\d)/g,
        (_m: string, a: string, b: string, c: string) =>
          `${a} point ${b} point ${c}`,
      )
      // Slashed numbers: "24/7" and "50/50" are idioms, not fractions;
      // dates ("05/01/2024") read as their parts.
      .replace(/\b24\/7\b/g, '24 7')
      .replace(/\b(\d+)\/\1\b/g, '$1 $1')
      .replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g, '$1 $2 $3')
  );
}

/** "v2.1.0" / "version 1.2.3.4" → "version 2 point 1 point 0" (before IPs). */
export function expandVersions(text: string): string {
  return text.replace(
    /\b(v|[Vv]ersion\s)(\d+(?:\.\d+){1,3})(?!\.?\d)/g,
    (_m: string, prefix: string, ver: string) =>
      `${prefix === 'v' ? 'version ' : prefix}${ver.split('.').join(' point ')}`,
  );
}

const SINGULAR_UNITS: Record<string, string> = {
  feet: 'foot',
  inches: 'inch',
  degrees: 'degree',
};
/** "one kilograms" / "1 minutes" → singular. */
export function singularizeUnits(text: string): string {
  return text.replace(
    /(?<!point )\b(one|1) (kilometers|kilograms|milligrams|milliliters|gigabytes|megabytes|kilobytes|terabytes|milliseconds|nanoseconds|microseconds|centimeters|millimeters|feet|pounds|ounces|seconds|minutes|hours|degrees)\b/g,
    (_m: string, one: string, unit: string) =>
      `${one} ${SINGULAR_UNITS[unit] ?? unit.slice(0, -1)}`,
  );
}

/**
 * Number + single scale letter with no space: "7B", "10K", "2.5M".
 * Stricter than the Kitten preprocessor's rule (which allows a space and
 * so turned "B 2 B" and "3 T-shirts" into billion/trillion).
 */
export function expandTightScaleSuffixes(text: string): string {
  return text.replace(
    /(?<![A-Za-z\d.])(\d+(?:\.\d+)?)([KMBT])(?![\w-])/g,
    (_m: string, num: string, scale: string) =>
      `${num} ${SCALE_WORDS[scale.toLowerCase()]}`,
  );
}

export function splitAlphanumeric(text: string): string {
  return (
    text
      // "GPT-4o", "COVID-19": hyphen between letters and digits is not a
      // range or compound, read the parts separately.
      .replace(/(?<=[A-Za-z])-(?=\d)/g, ' ')
      // "4o", "3D", "H2O", "MP3", "x86": split at letter/digit boundaries.
      // Ordinals and units were already expanded, so what remains here is
      // a model/product name.
      // A plural "s" stays on the number ("2022s").
      .replace(/(?<=\d)(?=[A-Za-rt-z]|s\w)|(?<=[A-Za-z])(?=\d)/g, ' ')
  );
}

export function markDottedAcronyms(text: string): string {
  // "U.S.", "a.m.", "Ph.D" → "U-S-", "a-m-": hyphenated single letters,
  // which the phonemizer spells letter by letter. A trailing period that
  // also ends the sentence is kept as punctuation.
  // Before "-" or "/" ("U.S.-based", "a.m./p.m.") the joining mark is
  // dropped: "U-S based", so the token doesn't become "U-S--based".
  return text.replace(
    /\b((?:[A-Za-z]\.){2,})([-/–—](?=\w))?/g,
    (
      m: string,
      letters: string,
      joiner: string | undefined,
      offset: number,
      src: string,
    ) => {
      if (joiner) return `${letters.slice(0, -1).replace(/\./g, '-')} `;
      const spelled = letters.replace(/\./g, '-');
      return endsSentence(src, offset + m.length) ? `${spelled}.` : spelled;
    },
  );
}

export function normalizeForSpeech(text: string): string {
  text = normalizeQuotes(text);
  text = verbalizeEmailsAndUrls(text);
  text = expandLatinAbbreviations(text);
  text = verbalizeSymbols(text);
  text = expandScaledCurrency(text);
  text = expandScientificNotation(text);
  text = expandVersions(text);
  text = expandIpAddresses(text);
  text = expandNumericForms(text);
  // Only unambiguous cooking/measure fractions; "4/5 stars" or "5/1" are
  // left to each engine as before.
  text = text.replace(
    /(?<![/\d])\b(\d+)\s*\/\s*(\d+)\b(?!\s*\/\s*\d)/g,
    (m: string, a: string, b: string) =>
      +a < +b && [2, 3, 4, 8, 16].includes(+b) ? expandFractions(m) : m,
  );
  text = expandTightScaleSuffixes(text);
  text = expandOrdinals(text);
  text = expandDecades(text);
  text = expandPercentages(text);
  text = expandUnits(text);
  text = singularizeUnits(text);
  text = expandClockTimes(text);
  text = spellTimeSuffixes(text);
  text = splitAlphanumeric(text);
  text = markDottedAcronyms(text);
  return text.replace(/ {2,}/g, ' ');
}
