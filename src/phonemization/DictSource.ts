/**
 * DictSource — abstraction over a phonemizer dict.
 *
 * Implementations:
 *   - JsDictSource: in-memory Record<string,string> (legacy / web / tests)
 *   - NativeDictSource: mmap'd EPD1 binary via the RNSpeech Turbo Module
 *
 * The contract is intentionally minimal: the phonemizer only ever needs
 * synchronous lookup. Loading / opening is done by the implementation.
 */
export interface DictSource {
  /** Look up a (cleaned, lowercased) word. Returns null on miss. */
  lookup(word: string): string | null;
  /** Optional: total entry count, for logging only. May return undefined. */
  size?(): number | undefined;
}
