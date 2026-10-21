/**
 * Abbreviations whose trailing period does not end a sentence. Chunkers
 * consult this so "Dr. Smith" or "e.g. Python" stay in one chunk —
 * splitting there synthesizes "Doctor." as its own utterance with a
 * sentence-final fall and a pause.
 *
 * Deliberately excludes abbreviations that commonly end sentences
 * ("etc.", "Inc.", "St.").
 */
const NON_TERMINAL = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'vs',
  'e.g',
  'i.e',
  'cf',
  'approx',
  'fig',
]);

/**
 * True when the `.` at `dotIndex` belongs to a non-terminal abbreviation
 * or a single-letter initial ("John F. Kennedy").
 */
export function isAbbreviationPeriod(text: string, dotIndex: number): boolean {
  if (text[dotIndex] !== '.' || text[dotIndex + 1] === '.') return false;
  // Bounded lookback: callers probe every boundary of a long buffer.
  const word = /([\p{L}.]+)$/u.exec(
    text.slice(Math.max(0, dotIndex - 16), dotIndex),
  )?.[1];
  if (!word) return false;
  if (/^\p{Lu}$/u.test(word)) return word !== 'I';
  return NON_TERMINAL.has(word.toLowerCase());
}
