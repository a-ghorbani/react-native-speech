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
 *   - "&"                             ("R&D" → "R and D")
 *   - ordinals, percentages, decades  ("5th", "12%", "1990s")
 *   - clock times                     ("3:30 pm")
 *   - letter/digit tokens             ("GPT-4o" → "GPT 4 o")
 *   - dotted acronyms                 ("U.S." → "U-S-", spelled by the
 *                                      phonemizer's letter-sequence layer)
 *
 * Every step is idempotent on its own output, so the downstream engine
 * normalizers can still run their (overlapping) expansions safely.
 */

import {
  expandDecades,
  expandOrdinals,
  expandPercentages,
  expandScientificNotation,
} from './KittenPreprocessor';

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

// "&lt;"/"&gt;" are deliberately not decoded: Kitten's HTML-tag stripper
// would then delete the text between them.
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function normalizeQuotes(text: string): string {
  return text
    .replace(/&(amp|quot|apos|nbsp|#39);/g, (_m, e: string) =>
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

/**
 * Number + single scale letter with no space: "7B", "10K", "2.5M".
 * Stricter than the Kitten preprocessor's rule (which allows a space and
 * so turned "B 2 B" and "3 T-shirts" into billion/trillion).
 */
export function expandTightScaleSuffixes(text: string): string {
  return (
    text
      // Model sizes: "Qwen2.5-7B", "Llama-3.1-8B" — not a range. Needs a
      // name in the same token, so "7-13B" stays a range.
      .replace(/(?<=[A-Za-z][\w.-]*\d)-(?=\d+(?:\.\d+)?[BMK]\b)/g, ' ')
      // Single-digit K is usually a name ("4K video", "5K run").
      .replace(/\b([1-9])K\b/g, '$1 kay')
      .replace(
        /(?<![A-Za-z\d.])(\d+(?:\.\d+)?)([KMBT])(?![\w-])/g,
        (_m: string, num: string, scale: string) =>
          `${num} ${SCALE_WORDS[scale.toLowerCase()]}`,
      )
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
  // "&" in prose and in compounds ("R&D", "AT&T")
  text = text.replace(/\s*&\s*/g, ' and ');
  // Kitten's preprocessor reads "1e-3", but only before the letter/digit
  // split below would break it apart.
  text = expandScientificNotation(text);
  text = expandTightScaleSuffixes(text);
  text = expandOrdinals(text);
  // "100s of users" is not a decade
  text = text
    .replace(/\b100s\b/g, 'hundreds')
    .replace(/\b1000s\b/g, 'thousands');
  text = expandDecades(text);
  // "10-20%": else "-20%" reads as negative
  text = text.replace(/(?<=\d)-(?=\d[\d.]*\s*%)/g, ' to ');
  text = expandPercentages(text);
  // Time ranges: "9am-5pm", "9:00am–5:30pm" → "... to ..."
  text = text.replace(
    /(\d(?::\d\d)?\s?[ap]\.?m\.?)\s*[-–—]\s*(?=\d)/gi,
    '$1 to ',
  );
  text = expandClockTimes(text);
  text = spellTimeSuffixes(text);
  text = splitAlphanumeric(text);
  text = markDottedAcronyms(text);
  return text.replace(/ {2,}/g, ' ');
}
