/**
 * First-clause boundary detection for `firstChunk: 'clause'` streaming.
 * Shared by `StreamingChunker` and `createMarkdownStreamBuffer` so both
 * cut the first chunk at the same place.
 */

import {isAbbreviationPeriod} from './abbreviations';

/**
 * Regex matching sentence-ending punctuation. Two alternations because
 * ASCII and CJK behave differently:
 *
 * - ASCII `[.!?]+` **requires** trailing whitespace. Without it we can't
 *   tell whether a terminal `.` is end-of-sentence or a mid-stream token
 *   that will grow into `3.14`, `Dr.`, `...`, etc. Waiting for the next
 *   whitespace is the reliable commit signal.
 *
 * - CJK `[。！？]+` **does not** require trailing whitespace. These
 *   characters are unambiguous sentence boundaries (not used inside
 *   words the way `.` is), and Chinese/Japanese prose typically runs
 *   sentences together with no space. Requiring whitespace would mean
 *   nothing ever flushes during a CJK stream — strictly worse than the
 *   per-sentence fallback the stream is meant to replace.
 *
 * `finalize()` flushes the tail regardless, so a stream that ends
 * without any matching punctuation still completes correctly.
 */
/**
 * Sentence-final marks that are unambiguous on their own, so no space is
 * needed after them: CJK `。！？．`, Devanagari danda `।` and double danda
 * `॥`, Arabic `؟`, Urdu `۔`.
 */
export const UNSPACED_SENTENCE_ENDS = '。！？．।॥؟۔';

export const SENTENCE_END_RE = new RegExp(
  `(?:[.!?]+\\s+|[${UNSPACED_SENTENCE_ENDS}]+\\s*)`,
  'g',
);

/** ASCII clause marks; need trailing whitespace like sentence ends. */
// `، ؛` are the Arabic comma and semicolon.
const CLAUSE_END_RE = /[,;:—–،؛]\s+/g;
/** CJK clause marks; CJK text has no spaces, so none are required. */
const CJK_CLAUSE_END_RE = /[，；：、]\s*/g;
/** Han, kana and CJK compatibility ideographs. */
/** Kana, CJK ideographs and compatibility ideographs: scripts written without spaces. */
export const CJK_CHARS = '぀-ヿ㐀-鿿豈-﫿';
const CJK_CHAR_RE = new RegExp(`[${CJK_CHARS}]`, 'g');
const WORD_RE = /\S+\s+/g;
const HAS_LETTER_RE = /[\p{L}\p{N}]/u;

/** Minimum words before an ASCII clause mark may end the first chunk. */
const CLAUSE_MIN_WORDS = 3;
/** Minimum CJK characters before a CJK clause mark may end it. */
const CLAUSE_MIN_CJK_CHARS = 4;
/** Default upper bound on first-chunk words when no boundary has appeared. */
export const DEFAULT_FIRST_CHUNK_MAX_WORDS = 12;

/** End offset of the last match of `re` ending at or before `limit`, or -1. */
function lastMatchEnd(re: RegExp, text: string, limit: number): number {
  const all = new RegExp(re.source, 'g');
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = all.exec(text)) !== null && m.index + m[0].length <= limit) {
    end = m.index + m[0].length;
  }
  return end;
}

/** End of the last clause mark (ASCII or CJK) at or before `limit`, or -1. */
export function lastClauseEnd(text: string, limit: number): number {
  return Math.max(
    lastMatchEnd(CLAUSE_END_RE, text, limit),
    lastMatchEnd(CJK_CLAUSE_END_RE, text, limit),
  );
}

/** End of the last whitespace-terminated word at or before `limit`, or -1. */
export function lastWordEnd(text: string, limit: number): number {
  return lastMatchEnd(/\S\s+/, text, limit);
}

/**
 * End of the first whitespace-terminated word that ends at or after
 * `limit` (the word that crosses it), or -1 while that word is still
 * incomplete.
 */
export function nextWordEnd(text: string, limit: number): number {
  const re = /\S\s+/g;
  re.lastIndex = Math.max(0, limit - 1);
  const m = re.exec(text);
  return m ? m.index + m[0].length : -1;
}

/**
 * Whether `text` ends at a sentence end (not an abbreviation's period) or
 * a clause mark.
 */
export function endsAtBreak(text: string): boolean {
  const clause = new RegExp(
    `(?:${CLAUSE_END_RE.source}|${CJK_CLAUSE_END_RE.source})$`,
  );
  if (clause.test(text)) {
    return true;
  }
  const sentence = new RegExp(`(?:${SENTENCE_END_RE.source})$`).exec(text);
  return sentence !== null && !isAbbreviationPeriod(text, sentence.index);
}

/**
 * End of the last CJK character within `limit`, for text written without
 * spaces when it has no punctuation to cut at either. -1 if there is none.
 */
export function lastCjkCharEnd(text: string, limit: number): number {
  return lastMatchEnd(CJK_CHAR_RE, text, limit);
}

/** Throws unless `value` is `undefined` or an integer >= 1. */
export function assertFirstChunkMaxWords(value: unknown): void {
  if (value === undefined || (Number.isInteger(value) && Number(value) >= 1)) {
    return;
  }
  const shown =
    typeof value === 'string' ? JSON.stringify(value) : String(value);
  throw new Error(
    `firstChunkMaxWords must be a positive integer (got ${shown})`,
  );
}

/** Whitespace-separated tokens containing a letter or digit. */
function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).filter(t => HAS_LETTER_RE.test(t)).length;
}

function countCjkChars(text: string): number {
  return (text.match(CJK_CHAR_RE) ?? []).length;
}

/**
 * End offset of the first clause in `text`: the earliest of
 *   - a sentence end,
 *   - an ASCII clause mark (`, ; : — –` + whitespace) after at least
 *     `CLAUSE_MIN_WORDS` words,
 *   - a CJK clause mark (`，；：、`) after at least `CLAUSE_MIN_CJK_CHARS`
 *     CJK characters,
 *   - the end of the `maxWords`-th whitespace-terminated word.
 * Returns -1 when none is present yet.
 */
export function findFirstClauseEnd(
  text: string,
  maxWords: number = DEFAULT_FIRST_CHUNK_MAX_WORDS,
): number {
  let end = -1;
  const consider = (candidate: number) => {
    if (end === -1 || candidate < end) {
      end = candidate;
    }
  };

  // Skip periods after abbreviations ("Dr. Smith") — same rule as the
  // regular sentence chunkers.
  const sentenceRe = new RegExp(SENTENCE_END_RE.source, 'g');
  let sentence: RegExpExecArray | null;
  while ((sentence = sentenceRe.exec(text)) !== null) {
    if (isAbbreviationPeriod(text, sentence.index)) continue;
    consider(sentence.index + sentence[0].length);
    break;
  }

  const scanClauses = (re: RegExp, enough: (prefix: string) => boolean) => {
    const clauseRe = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = clauseRe.exec(text)) !== null) {
      if (end !== -1 && m.index >= end) {
        return;
      }
      if (enough(text.slice(0, m.index))) {
        consider(m.index + m[0].length);
        return;
      }
    }
  };
  scanClauses(CLAUSE_END_RE, p => countWords(p) >= CLAUSE_MIN_WORDS);
  scanClauses(CJK_CLAUSE_END_RE, p => countCjkChars(p) >= CLAUSE_MIN_CJK_CHARS);

  const wordRe = new RegExp(WORD_RE.source, 'g');
  let words = 0;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) {
    if (HAS_LETTER_RE.test(m[0]) && ++words === maxWords) {
      consider(m.index + m[0].length);
      break;
    }
  }

  return end;
}
