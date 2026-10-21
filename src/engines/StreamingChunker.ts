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
import {SENTENCE_END_RE, findFirstClauseEnd} from '../utils/firstClause';

export {findFirstClauseEnd} from '../utils/firstClause';

export class StreamingChunker {
  private buffer = '';
  private absoluteOffset = 0;
  private finalized = false;
  private cancelled = false;
  private maxChunkSize: number;
  private firstChunk: FirstChunkMode;
  private firstTaken = false;

  private waiter: ((chunk: TextChunk | null) => void) | null = null;

  constructor(
    maxChunkSize: number = 400,
    firstChunk: FirstChunkMode = 'sentence',
  ) {
    this.maxChunkSize = maxChunkSize;
    this.firstChunk = firstChunk;
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
        : this.extractSentences();
    if (chunk) {
      this.firstTaken = true;
    }
    return chunk;
  }

  private extractFirstClause(): TextChunk | null {
    const end = findFirstClauseEnd(this.buffer);
    if (end <= 0) {
      return null;
    }
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
   * Extract complete sentence(s) from the front of the buffer, up to
   * `maxChunkSize`. Returns null if no sentence boundary is found.
   */
  private extractSentences(): TextChunk | null {
    const re = new RegExp(SENTENCE_END_RE.source, 'g');
    let m: RegExpExecArray | null;
    let lastGoodEnd = -1;

    while ((m = re.exec(this.buffer)) !== null) {
      // Once the buffer is past maxChunkSize, abbreviation periods count
      // as boundaries again so text with no other break still flushes.
      if (
        this.buffer.length <= this.maxChunkSize &&
        isAbbreviationPeriod(this.buffer, m.index)
      ) {
        continue;
      }
      const candidateEnd = m.index + m[0].length;
      if (candidateEnd <= this.maxChunkSize || lastGoodEnd === -1) {
        lastGoodEnd = candidateEnd;
      }
      if (candidateEnd >= this.maxChunkSize && lastGoodEnd > 0) {
        break;
      }
    }

    if (lastGoodEnd === -1) {
      return null;
    }

    const end = lastGoodEnd;
    const text = this.buffer.slice(0, end);
    if (text.trim().length === 0) {
      return null;
    }

    const chunk: TextChunk = {
      text,
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
