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
export const SENTENCE_END_RE = /(?:[.!?]+\s+|[。！？]+\s*)/g;

/** ASCII clause marks; need trailing whitespace like sentence ends. */
const CLAUSE_END_RE = /[,;:—–]\s+/g;
/** CJK clause marks; CJK text has no spaces, so none are required. */
const CJK_CLAUSE_END_RE = /[，；：、]\s*/g;
/** Han, kana and CJK compatibility ideographs. */
const CJK_CHAR_RE = /[぀-ヿ㐀-鿿豈-﫿]/g;
const WORD_RE = /\S+\s+/g;
const HAS_LETTER_RE = /[\p{L}\p{N}]/u;

/** Minimum words before an ASCII clause mark may end the first chunk. */
const CLAUSE_MIN_WORDS = 3;
/** Minimum CJK characters before a CJK clause mark may end it. */
const CLAUSE_MIN_CJK_CHARS = 4;
/** Upper bound on first-chunk words when no boundary has appeared. */
const CLAUSE_MAX_WORDS = 12;

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
 *   - the end of the `CLAUSE_MAX_WORDS`-th whitespace-terminated word.
 * Returns -1 when none is present yet.
 */
export function findFirstClauseEnd(text: string): number {
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
    if (HAS_LETTER_RE.test(m[0]) && ++words === CLAUSE_MAX_WORDS) {
      consider(m.index + m[0].length);
      break;
    }
  }

  return end;
}
