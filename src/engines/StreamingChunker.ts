/**
 * StreamingChunker — incremental sentence-aware text splitter for
 * streaming TTS.
 *
 * Text is pushed in via `append()` as it arrives (e.g. LLM tokens).
 * The consumer loop calls `getNextChunk()` which resolves as soon as
 * a complete sentence is available, or returns `null` when the stream
 * is finalized and the buffer is drained.
 *
 * All returned chunks carry absolute character offsets into the total
 * appended text so progress events can map directly to the consumer's
 * accumulated buffer.
 */

import type {FirstChunkMode} from '../types';
import type {TextChunk} from '../utils/TextChunker';
import {isAbbreviationPeriod} from '../utils/abbreviations';
import {
  SENTENCE_END_RE,
  assertFirstChunkMaxWords,
  endsAtBreak,
  findFirstClauseEnd,
  lastCjkCharEnd,
  lastClauseEnd,
  lastWordEnd,
  nextWordEnd,
} from '../utils/firstClause';

export {findFirstClauseEnd} from '../utils/firstClause';

/**
 * With `firstChunk: 'clause'`, each chunk after the first may be at most
 * this many times the previous one, so it is synthesized while the
 * previous one plays (#70). The ramp ends once the cap reaches
 * maxChunkSize.
 */
const RAMP_FACTOR = 4;

export class StreamingChunker {
  private buffer = '';
  private absoluteOffset = 0;
  private finalized = false;
  private cancelled = false;
  private maxChunkSize: number;
  private firstChunk: FirstChunkMode;
  private firstChunkMaxWords: number | undefined;
  private firstTaken = false;
  /** Size limit for the next chunk while ramping up; null once the ramp ends. */
  private rampCap: number | null = null;
  /** The last chunk was cut between two words of a phrase (#137). */
  private midPhrase = false;
  /** Consumer's size limit, read when a chunk is cut (`setChunkCap`). */
  private chunkCap: (() => number | null) | null = null;

  private waiter: ((chunk: TextChunk | null) => void) | null = null;

  constructor(
    maxChunkSize: number = 400,
    firstChunk: FirstChunkMode = 'sentence',
    firstChunkMaxWords?: number,
  ) {
    assertFirstChunkMaxWords(firstChunkMaxWords);
    this.maxChunkSize = maxChunkSize;
    this.firstChunk = firstChunk;
    this.firstChunkMaxWords = firstChunkMaxWords;
  }

  append(text: string): void {
    if (this.finalized || this.cancelled) {
      return;
    }
    this.buffer += text;
    this.wake();
  }

  finalize(): void {
    if (this.finalized || this.cancelled) {
      return;
    }
    this.finalized = true;
    this.wake();
  }

  cancel(): void {
    this.cancelled = true;
    this.buffer = '';
    if (this.waiter) {
      this.waiter(null);
      this.waiter = null;
    }
  }

  /**
   * Returns the next chunk of complete sentence(s) up to
   * `maxChunkSize`. Blocks (via promise) until a sentence boundary
   * appears in the buffer, more text arrives, or finalize/cancel is
   * called.
   *
   * Returns `null` when the stream is fully consumed (finalized + buffer
   * drained) or cancelled.
   */
  async getNextChunk(): Promise<TextChunk | null> {
    // Try synchronously first — avoids a microtask tick when data is ready.
    const immediate = this.tryTake();
    if (immediate !== undefined) {
      return immediate;
    }

    // Block until append/finalize/cancel wakes us.
    return new Promise<TextChunk | null>(resolve => {
      this.waiter = resolve;
    });
  }

  /**
   * Non-blocking peek: returns the next chunk if one is ready right
   * now, or `undefined` (not `null`) if the consumer should wait.
   * `null` means stream is done.
   */
  tryPeek(): TextChunk | null | undefined {
    if (this.cancelled) {
      return null;
    }
    const chunk = this.extractReadyChunk();
    if (chunk) {
      return chunk;
    }
    if (this.finalized) {
      return this.extractRemainder();
    }
    return undefined;
  }

  /**
   * With `firstChunk: 'clause'`, limit the chunks after the first to
   * `cap()` chars, read when each chunk is cut, e.g. to what can be
   * synthesized while the queued audio plays (#83). It cuts like the ramp:
   * at a clause mark in its second half, else after whole sentences. A
   * null result, or null `cap`, sets no limit.
   */
  setChunkCap(cap: (() => number | null) | null): void {
    this.chunkCap = cap;
  }

  /**
   * Whether the last chunk ended between two words: a first chunk cut at
   * `firstChunkMaxWords`, or a chunk after it cut at a word to fit the
   * consumer cap.
   */
  get endsMidPhrase(): boolean {
    return this.midPhrase;
  }

  /** Total chars appended so far. */
  get totalAppended(): number {
    return this.absoluteOffset + this.buffer.length;
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Try to produce a result synchronously. Returns `undefined` when
   * the consumer should block.
   */
  private tryTake(): TextChunk | null | undefined {
    if (this.cancelled) {
      return null;
    }
    const chunk = this.extractReadyChunk();
    if (chunk) {
      return chunk;
    }
    if (this.finalized) {
      return this.extractRemainder();
    }
    return undefined;
  }

  /** With `firstChunk: 'clause'`, only the first chunk may end at a clause boundary. */
  private extractReadyChunk(): TextChunk | null {
    const chunk =
      this.firstChunk === 'clause' && !this.firstTaken
        ? this.extractFirstClause()
        : (this.extractRamped() ??
          this.extractSentences() ??
          this.extractSoftCut());
    if (chunk) {
      if (
        (!this.firstTaken && this.firstChunk === 'clause') ||
        this.rampCap !== null
      ) {
        const cap = RAMP_FACTOR * chunk.text.length;
        this.rampCap = cap < this.maxChunkSize ? cap : null;
      }
      this.firstTaken = true;
    }
    return chunk;
  }

  /**
   * The tighter of the ramp cap and the consumer's, and whether the
   * consumer's is the one that applies; null when neither is below
   * maxChunkSize.
   */
  private currentCap(): {cap: number; byConsumer: boolean} | null {
    const consumer =
      this.firstChunk === 'clause' && this.chunkCap ? this.chunkCap() : null;
    const cap = Math.min(this.rampCap ?? Infinity, consumer ?? Infinity);
    return cap < this.maxChunkSize ? {cap, byConsumer: cap === consumer} : null;
  }

  /**
   * While ramping: sentences up to the cap; else, once the buffer reaches
   * the cap, the last clause mark in its second half, or, when the last
   * chunk already ended mid-phrase and the consumer's cap applies, the last
   * word end within it, or the end of the word that crosses it when that
   * word ends the sentence or a clause (#137); else the first sentence
   * alone, however long. Null (no sentence end yet) leaves the cut to the soft
   * cut.
   */
  private extractRamped(): TextChunk | null {
    const limit = this.currentCap();
    if (limit === null) {
      return null;
    }
    const {cap, byConsumer} = limit;
    const sentences = this.extractSentences(cap, false);
    if (sentences) {
      return sentences;
    }
    if (this.buffer.length >= cap) {
      const end = lastClauseEnd(this.buffer, cap);
      if (end >= cap / 2) {
        return this.take(end);
      }
      if (this.midPhrase && byConsumer) {
        const over = nextWordEnd(this.buffer, cap);
        if (over > 0 && endsAtBreak(this.buffer.slice(0, over))) {
          return this.take(over);
        }
        const word = lastWordEnd(this.buffer, cap);
        if (over > 0 && word > end) {
          return this.take(word, true);
        }
      }
    }
    return this.extractSentences(cap);
  }

  private extractFirstClause(): TextChunk | null {
    const end = findFirstClauseEnd(this.buffer, this.firstChunkMaxWords);
    if (end <= 0) {
      return null;
    }
    return this.take(end, !endsAtBreak(this.buffer.slice(0, end)));
  }

  /**
   * Extract complete sentence(s) from the front of the buffer, up to
   * `limit` (default `maxChunkSize`). A first sentence longer than that
   * comes alone, unless `allowLonger` is false. Returns null if no
   * sentence boundary is found.
   */
  private extractSentences(
    limit?: number,
    allowLonger = true,
  ): TextChunk | null {
    const max = limit ?? this.maxChunkSize;
    const re = new RegExp(SENTENCE_END_RE.source, 'g');
    let m: RegExpExecArray | null;
    let lastGoodEnd = -1;

    while ((m = re.exec(this.buffer)) !== null) {
      // Once the buffer is past maxChunkSize, abbreviation periods count
      // as boundaries again so text with no other break still flushes;
      // a ramp-limited chunk never ends at one.
      if (
        (limit !== undefined || this.buffer.length <= this.maxChunkSize) &&
        isAbbreviationPeriod(this.buffer, m.index)
      ) {
        continue;
      }
      const candidateEnd = m.index + m[0].length;
      if (candidateEnd <= max || (lastGoodEnd === -1 && allowLonger)) {
        lastGoodEnd = candidateEnd;
      }
      if (candidateEnd >= max) {
        break;
      }
    }

    if (lastGoodEnd === -1) {
      return null;
    }

    if (this.buffer.slice(0, lastGoodEnd).trim().length === 0) {
      return null;
    }
    return this.take(lastGoodEnd);
  }

  /**
   * For a buffer with no sentence end that has reached `maxChunkSize`:
   * cut at the last clause mark within it, else at the last word end, so
   * a long run of clauses doesn't wait for the stream to end (#48). A
   * clause mark in the first half loses to a word end: a tiny chunk would
   * play out before the next one is synthesized.
   */
  private extractSoftCut(): TextChunk | null {
    const max = this.maxChunkSize;
    if (this.buffer.length < max) {
      return null;
    }
    let end = lastClauseEnd(this.buffer, max);
    if (end < max / 2) {
      end = Math.max(
        end,
        lastWordEnd(this.buffer, max),
        lastCjkCharEnd(this.buffer, max),
      );
    }
    if (end <= 0) {
      // A single word longer than maxChunkSize: cut right after it.
      const word = /\S\s+/.exec(this.buffer);
      end = word ? word.index + word[0].length : -1;
    }
    if (end <= 0) {
      return null;
    }
    return this.take(end);
  }

  /** Remove the first `end` chars of the buffer as a chunk. */
  private take(end: number, midPhrase = false): TextChunk {
    this.midPhrase = midPhrase;
    const chunk: TextChunk = {
      text: this.buffer.slice(0, end),
      startIndex: this.absoluteOffset,
      endIndex: this.absoluteOffset + end,
    };
    this.buffer = this.buffer.slice(end);
    this.absoluteOffset += end;
    return chunk;
  }

  /**
   * Drain whatever remains. Returns null if buffer is empty.
   */
  private extractRemainder(): TextChunk | null {
    if (this.buffer.length === 0 || this.buffer.trim().length === 0) {
      this.buffer = '';
      return null;
    }
    const chunk: TextChunk = {
      text: this.buffer,
      startIndex: this.absoluteOffset,
      endIndex: this.absoluteOffset + this.buffer.length,
    };
    this.absoluteOffset += this.buffer.length;
    this.buffer = '';
    return chunk;
  }

  /**
   * Wake the blocked consumer if one is waiting.
   */
  private wake(): void {
    if (!this.waiter) {
      return;
    }
    const result = this.tryTake();
    if (result !== undefined) {
      const w = this.waiter;
      this.waiter = null;
      w(result);
    }
  }
}
