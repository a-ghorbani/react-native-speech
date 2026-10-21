/**
 * EngineStreamSession — pipelined synth + play loop over a
 * StreamingChunker.
 *
 * This is the core of Tier 3 streaming: the loop never resets
 * between "batches" — it just keeps pulling chunks from the chunker
 * as they become ready, synthesizing the next chunk while the current
 * one plays. The only gap is genuine token-rate underrun (LLM slower
 * than playback).
 *
 * Used by all neural engines via dependency injection:
 *   - `synthesizeChunk(text) → TAudio`  (`AudioBuffer` by default)
 *   - `playAudio(audio) → void`  (resolves when audio finishes)
 *   - `stopPlayback()` — abort native playback
 *
 * Engines whose audio lives natively (passing ids, not samples) use
 * the optional hooks: `hasAudio` decides whether a chunk produced
 * audio, `discard` releases audio that will never be played, and
 * `onCancel` aborts native synthesis synchronously on cancel.
 *
 * OS engine does not use this — SpeechStream falls back to the
 * adaptive batcher there.
 */

import type {AudioBuffer, ChunkProgressEvent, FirstChunkMode} from '../types';
import type {PlaybackOptions} from './NeuralAudioPlayer';
import {StreamingChunker} from './StreamingChunker';
import {createComponentLogger} from '../utils/logger';

const log = createComponentLogger('EngineStream', 'Engine');

export interface EngineStreamSessionConfig<TAudio = AudioBuffer> {
  synthesizeChunk: (text: string) => Promise<TAudio>;
  playAudio: (audio: TAudio, options?: PlaybackOptions) => Promise<void>;
  stopPlayback: () => Promise<void>;
  maxChunkSize: number;
  firstChunk?: FirstChunkMode;
  playbackOptions?: PlaybackOptions;
  postProcess?: (audio: TAudio) => void;
  onChunkProgress?: (event: ChunkProgressEvent) => void;
  /**
   * Whether a synthesized chunk has audio to play. Chunks without audio
   * are skipped (and passed to `discard`). Default: `samples.length > 0`.
   */
  hasAudio?: (audio: TAudio) => boolean;
  /**
   * Called exactly once for every synthesized chunk that will never be
   * played: results that arrive after `cancel()`, skipped no-audio
   * chunks, and a prefetched chunk left over when the loop ends early.
   * Never called for a chunk that was handed to `playAudio`.
   */
  discard?: (audio: TAudio) => void;
  /**
   * Called synchronously at the start of `cancel()`, before
   * `stopPlayback`, so the engine can abort native synthesis.
   */
  onCancel?: () => void;
}

type ChunkInfo = {text: string; startIndex: number; endIndex: number};

function defaultHasAudio(audio: unknown): boolean {
  return (audio as AudioBuffer).samples.length > 0;
}

export interface EngineStreamHandle {
  append(text: string): void;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
}

export class EngineStreamSession<
  TAudio = AudioBuffer,
> implements EngineStreamHandle {
  private readonly chunker: StreamingChunker;
  private readonly config: EngineStreamSessionConfig<TAudio>;
  private readonly hasAudio: (audio: TAudio) => boolean;
  private readonly loopPromise: Promise<void>;
  private cancelled = false;
  private stopSignalResolver: (() => void) | null = null;
  private firstError: Error | null = null;
  private readonly sessionStartTs = Date.now();
  private chunkCount = 0;
  private lastChunkEndTs: number | null = null;

  constructor(config: EngineStreamSessionConfig<TAudio>) {
    this.config = config;
    this.hasAudio = config.hasAudio ?? defaultHasAudio;
    this.chunker = new StreamingChunker(config.maxChunkSize, config.firstChunk);
    this.loopPromise = this.runLoop();
  }

  append(text: string): void {
    if (this.cancelled) {
      return;
    }
    this.chunker.append(text);
  }

  async finalize(): Promise<void> {
    this.chunker.finalize();
    await this.loopPromise;
    if (this.firstError) {
      throw this.firstError;
    }
  }

  async cancel(): Promise<void> {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    if (this.config.onCancel) {
      try {
        this.config.onCancel();
      } catch (err) {
        log.warn('onCancel failed during cancel:', err);
      }
    }
    this.chunker.cancel();
    if (this.stopSignalResolver) {
      this.stopSignalResolver();
      this.stopSignalResolver = null;
    }
    try {
      await this.config.stopPlayback();
    } catch (err) {
      log.warn('stopPlayback failed during cancel:', err);
    }
    await this.loopPromise.catch(() => {});
  }

  private rel(): number {
    return Date.now() - this.sessionStartTs;
  }

  private discard(audio: TAudio): void {
    if (!this.config.discard) {
      return;
    }
    try {
      this.config.discard(audio);
    } catch (err) {
      log.warn('discard failed:', err);
    }
  }

  /** Discard whatever a pending prefetch eventually yields. */
  private discardPrefetch(
    prefetch: Promise<{chunk: ChunkInfo; audio: TAudio} | null>,
  ): void {
    prefetch.then(
      next => {
        if (next) {
          this.discard(next.audio);
        }
      },
      () => {},
    );
  }

  private createStopSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      this.stopSignalResolver = () => resolve(null);
    });
  }

  private raceWithStop<T>(
    promise: Promise<T>,
    stopSignal: Promise<null>,
  ): Promise<T | null> {
    return Promise.race([promise, stopSignal]);
  }

  private async runLoop(): Promise<void> {
    const {synthesizeChunk, playAudio, playbackOptions, postProcess} =
      this.config;
    const stopSignal = this.createStopSignal();
    // Discarded if the loop ends early (cancel or error).
    let currentAudio: TAudio | null = null;
    let prefetchPromise: Promise<{
      chunk: ChunkInfo;
      audio: TAudio;
    } | null> | null = null;

    log.info(`stream session started, t+0ms`);

    try {
      // Bootstrap: pull chunks until we find one that produces audio.
      // Engines may legitimately return an empty buffer for no-content
      // chunks (e.g. an isolated horizontal rule converted to `.`); we
      // skip those rather than ending the whole session.
      const bootstrap = await this.fetchNextWithAudio(
        synthesizeChunk,
        stopSignal,
      );
      if (!bootstrap) {
        return;
      }
      let currentChunk = bootstrap.chunk;
      currentAudio = bootstrap.audio;
      let chunkIdx = 0;

      // Main loop: play current chunk while synthesizing next.
      while (true) {
        if (this.cancelled) {
          return;
        }

        const chunkStartTs = Date.now();
        this.chunkCount++;
        const gapFromPrev =
          this.lastChunkEndTs !== null
            ? chunkStartTs - this.lastChunkEndTs
            : null;
        log.info(
          `chunk#${this.chunkCount} START: ${currentChunk.text.length} chars` +
            (gapFromPrev !== null ? `, gap_since_prev=${gapFromPrev}ms` : '') +
            `, offset=${currentChunk.startIndex}, t+${this.rel()}ms`,
        );

        const audio: TAudio = currentAudio!;

        if (postProcess) {
          postProcess(audio);
        }

        this.emitProgress(currentChunk, chunkIdx);

        // Start fetching + synthesizing next chunk in background. Skips
        // any no-audio chunks until it finds one with audio (or chunker
        // drains).
        prefetchPromise = this.fetchNextWithAudio(synthesizeChunk, stopSignal);
        // Observed when awaited; avoids an unhandled rejection on early return.
        prefetchPromise.catch(() => {});

        // Play current chunk (concurrent with prefetch). The player now owns
        // the audio, so it is never discarded.
        currentAudio = null;
        await this.raceWithStop(playAudio(audio, playbackOptions), stopSignal);

        if (this.cancelled) {
          return;
        }

        this.lastChunkEndTs = Date.now();
        log.info(
          `chunk#${this.chunkCount} DONE: play=${this.lastChunkEndTs - chunkStartTs}ms, t+${this.rel()}ms`,
        );

        // Get prefetched result.
        const pending = prefetchPromise;
        prefetchPromise = null;
        const next = await pending;
        if (!next) {
          return;
        }

        currentChunk = next.chunk;
        currentAudio = next.audio;
        chunkIdx++;
      }
    } catch (err) {
      if (this.cancelled) {
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this.firstError) {
        this.firstError = error;
      }
      log.error(`stream session error: ${error.message}`);
    } finally {
      if (currentAudio !== null) {
        this.discard(currentAudio);
      }
      if (prefetchPromise) {
        this.discardPrefetch(prefetchPromise);
      }
      log.info(
        `stream session ended: chunks=${this.chunkCount}, elapsed=${this.rel()}ms`,
      );
    }
  }

  /**
   * Fetch chunks from the chunker, synthesizing each, until we find one
   * that produced audio. Returns null when the chunker is drained or the
   * session was cancelled.
   *
   * Engines may legitimately produce an empty `AudioBuffer` for chunks
   * that have no synthesizable content — e.g. Kitten skips a chunk that
   * tokenizes to only framing tokens (which crashes its BERT expand op).
   * Treating that as "stream done" would cut playback off mid-document,
   * so we keep pulling until we have audio.
   */
  private async fetchNextWithAudio(
    synthesizeChunk: (text: string) => Promise<TAudio>,
    stopSignal: Promise<null>,
  ): Promise<{chunk: ChunkInfo; audio: TAudio} | null> {
    while (true) {
      const chunk = await this.chunker.getNextChunk();
      if (!chunk || this.cancelled) {
        return null;
      }
      const synth = synthesizeChunk(chunk.text);
      // If the stop signal wins the race the result still arrives later
      // and must be discarded; cancel() sets `cancelled` before resolving
      // the stop signal, so that late result always sees it.
      let settled = false;
      synth.then(
        result => {
          if (this.cancelled) {
            settled = true;
            this.discard(result);
          }
        },
        () => {},
      );
      const audio = await this.raceWithStop(synth, stopSignal);
      if (audio === null) {
        return null;
      }
      if (this.cancelled) {
        if (!settled) {
          this.discard(audio);
        }
        return null;
      }
      if (!this.hasAudio(audio)) {
        log.debug(
          `skipping no-audio chunk (${chunk.text.length} chars), pulling next`,
        );
        this.discard(audio);
        continue;
      }
      return {chunk, audio};
    }
  }

  private emitProgress(chunk: ChunkInfo, chunkIndex: number): void {
    if (!this.config.onChunkProgress) {
      return;
    }
    this.config.onChunkProgress({
      id: 0,
      chunkIndex,
      totalChunks: 0,
      chunkText: chunk.text,
      textRange: {start: chunk.startIndex, end: chunk.endIndex},
      progress: 0,
    });
  }
}
