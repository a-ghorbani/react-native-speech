/**
 * SpeechStream — incremental text input for TTS.
 *
 * Consumers (e.g. apps playing LLM token streams through TTS) call
 * `append()` as tokens arrive and `finalize()` when the source closes.
 * The stream decides when to flush batches to the underlying synth so
 * that the audio sounds like one continuous utterance instead of a
 * series of per-sentence speaks.
 *
 * ## Batching policy
 *
 * The state machine is engine-agnostic — it sits above `Speech.speak()`
 * and simply controls how much text each `speak()` sees. Each flushed
 * batch still goes through the per-engine chunker + pipelined synth
 * internally, so sentences share prosody within a batch natively.
 *
 * - **First batch**: flushed as soon as the buffer contains a single
 *   complete sentence. Minimises time-to-first-audio.
 * - **Subsequent batches**: held back until one of:
 *     (a) buffer size crosses `targetChars`, OR
 *     (b) the prior batch finishes with text still buffered (underrun),
 *     (c) `finalize()` is called.
 *
 * Batches are serialised — at most one batch is in flight and at most
 * one is pre-queued. The `synthesize` and `stop` hooks are injected so
 * the class has no compile-time dependency on Speech / engines (which
 * keeps it trivially unit-testable).
 */

import type {
  SpeechStream as ISpeechStream,
  SpeechStreamOptions,
} from '../types';
import {createComponentLogger} from '../utils/logger';

const log = createComponentLogger('SpeechStream', 'Api');

const DEFAULT_TARGET_CHARS = 300;

/**
 * Regex matching one or more sentence-ending punctuation chars followed
 * by whitespace. Requiring trailing whitespace is deliberate: while the
 * stream is open we can't tell whether a terminal `.` is the end of a
 * sentence or a still-arriving `...`, so we wait for whitespace as the
 * commit signal. `finalize()` flushes the tail regardless.
 */
const SENTENCE_END_RE = /[.!?]+\s+/g;

export interface SpeechStreamConfig {
  /** Maps a text batch to a promise that resolves when its audio has finished playing. */
  synthesize: (text: string) => Promise<void>;
  /** Aborts any in-flight synth/playback. Called from `cancel()`. */
  stop: () => Promise<void>;
  /** User-supplied options — only `targetChars` and `onError` are read here. */
  options?: SpeechStreamOptions;
}

export class SpeechStreamImpl implements ISpeechStream {
  private buffer = '';
  private queue: string[] = [];
  private inflight: Promise<void> | null = null;

  private firstFlushDone = false;
  private finalized = false;
  private cancelled = false;
  private firstError: Error | null = null;

  private drainResolvers: Array<() => void> = [];

  private readonly targetChars: number;
  private readonly synthesize: (text: string) => Promise<void>;
  private readonly stopFn: () => Promise<void>;
  private readonly onError?: (err: Error) => void;

  constructor(config: SpeechStreamConfig) {
    this.synthesize = config.synthesize;
    this.stopFn = config.stop;
    this.targetChars = Math.max(
      1,
      config.options?.targetChars ?? DEFAULT_TARGET_CHARS,
    );
    this.onError = config.options?.onError;
  }

  append(text: string): void {
    if (this.finalized || this.cancelled) {
      return;
    }
    if (!text) {
      return;
    }
    this.buffer += text;
    this.tryFlush();
  }

  async finalize(): Promise<void> {
    if (this.cancelled) {
      // Already cancelled — just wait for any still-resolving state.
      return this.waitForDrain();
    }
    if (!this.finalized) {
      this.finalized = true;
      this.tryFlush();
    }
    await this.waitForDrain();
    if (this.firstError) {
      throw this.firstError;
    }
  }

  async cancel(): Promise<void> {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    this.buffer = '';
    this.queue = [];

    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    resolvers.forEach(r => r());

    try {
      await this.stopFn();
    } catch (err) {
      log.warn('Stop failed during cancel:', err);
    }
  }

  /**
   * Decide whether to move text from the buffer to the batch queue.
   * Safe to call at any time; it's idempotent when nothing can flush.
   */
  private tryFlush(): void {
    if (this.cancelled) {
      return;
    }
    // Never queue more than one batch ahead — keeps memory bounded and
    // preserves the underrun signal (inflight === null && queue empty).
    if (this.queue.length > 0) {
      return;
    }

    if (this.finalized) {
      if (this.buffer.length === 0) {
        return;
      }
      this.enqueueBatch(this.buffer);
      this.buffer = '';
      return;
    }

    if (!this.firstFlushDone) {
      const split = extractFirstSentence(this.buffer);
      if (split) {
        this.firstFlushDone = true;
        this.enqueueBatch(split.head);
        this.buffer = split.tail;
      }
      return;
    }

    // Subsequent-flush policy: wait for size threshold OR underrun.
    const sizeThresholdHit = this.buffer.length >= this.targetChars;
    const underrun = this.inflight === null;
    if (!sizeThresholdHit && !underrun) {
      return;
    }

    const split = extractAllCompleteSentences(this.buffer);
    if (split) {
      this.enqueueBatch(split.head);
      this.buffer = split.tail;
    }
  }

  private enqueueBatch(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    this.queue.push(text);
    this.pump();
  }

  /**
   * Advance the batch queue. At most one batch runs at a time. When a
   * batch finishes we re-check `tryFlush()` so the underrun guard (b)
   * can pick up buffered text that was waiting for the prior batch.
   */
  private pump(): void {
    if (this.cancelled) {
      this.maybeResolveDrain();
      return;
    }
    if (this.inflight) {
      return;
    }
    if (this.queue.length === 0) {
      this.maybeResolveDrain();
      return;
    }
    const batch = this.queue.shift() as string;
    log.debug(`Synthesizing batch (${batch.length} chars)`);
    this.inflight = this.synthesize(batch)
      .catch(err => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!this.firstError) {
          this.firstError = error;
        }
        if (this.onError) {
          try {
            this.onError(error);
          } catch (cbErr) {
            log.warn('onError callback threw:', cbErr);
          }
        }
      })
      .then(() => {
        this.inflight = null;
        this.pump();
        this.tryFlush();
      });
  }

  private async waitForDrain(): Promise<void> {
    if (this.isIdle()) {
      return;
    }
    return new Promise<void>(resolve => {
      this.drainResolvers.push(resolve);
    });
  }

  private isIdle(): boolean {
    return (
      this.inflight === null &&
      this.queue.length === 0 &&
      this.buffer.length === 0
    );
  }

  private maybeResolveDrain(): void {
    if (!this.isIdle() && !this.cancelled) {
      return;
    }
    if (this.drainResolvers.length === 0) {
      return;
    }
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    resolvers.forEach(r => r());
  }
}

/**
 * Find the first `[.!?]+` followed by whitespace and split the buffer
 * there. Returns null if no complete sentence boundary exists yet.
 */
function extractFirstSentence(
  text: string,
): {head: string; tail: string} | null {
  const re = /[.!?]+\s+/;
  const m = re.exec(text);
  if (!m) {
    return null;
  }
  const end = m.index + m[0].length;
  const head = text.slice(0, end);
  if (head.trim().length === 0) {
    return null;
  }
  return {head, tail: text.slice(end)};
}

/**
 * Split the buffer at the last `[.!?]+` followed by whitespace, so the
 * head contains as many complete sentences as possible and the tail
 * holds any still-streaming incomplete sentence.
 */
function extractAllCompleteSentences(
  text: string,
): {head: string; tail: string} | null {
  const re = new RegExp(SENTENCE_END_RE.source, 'g');
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1) {
    return null;
  }
  const head = text.slice(0, lastEnd);
  if (head.trim().length === 0) {
    return null;
  }
  return {head, tail: text.slice(lastEnd)};
}
