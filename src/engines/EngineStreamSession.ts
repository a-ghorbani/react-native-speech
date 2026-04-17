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
 *   - `synthesizeChunk(text) → AudioBuffer`
 *   - `playAudio(buffer) → void`  (resolves when audio finishes)
 *   - `onStop()` — abort native playback
 *
 * OS engine does not use this — SpeechStream falls back to the
 * adaptive batcher there.
 */

import type {AudioBuffer, ChunkProgressEvent} from '../types';
import type {PlaybackOptions} from './NeuralAudioPlayer';
import {StreamingChunker} from './StreamingChunker';
import {createComponentLogger} from '../utils/logger';

const log = createComponentLogger('EngineStream', 'Engine');

export interface EngineStreamSessionConfig {
  synthesizeChunk: (text: string) => Promise<AudioBuffer>;
  playAudio: (buffer: AudioBuffer, options?: PlaybackOptions) => Promise<void>;
  stopPlayback: () => Promise<void>;
  maxChunkSize: number;
  playbackOptions?: PlaybackOptions;
  postProcess?: (buffer: AudioBuffer) => void;
  onChunkProgress?: (event: ChunkProgressEvent) => void;
}

export interface EngineStreamHandle {
  append(text: string): void;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
}

export class EngineStreamSession implements EngineStreamHandle {
  private readonly chunker: StreamingChunker;
  private readonly config: EngineStreamSessionConfig;
  private readonly loopPromise: Promise<void>;
  private cancelled = false;
  private stopSignalResolver: (() => void) | null = null;
  private firstError: Error | null = null;
  private readonly sessionStartTs = Date.now();
  private chunkCount = 0;
  private lastChunkEndTs: number | null = null;

  constructor(config: EngineStreamSessionConfig) {
    this.config = config;
    this.chunker = new StreamingChunker(config.maxChunkSize);
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

    log.info(`stream session started, t+0ms`);

    try {
      // Bootstrap: get first chunk and synthesize it. No pipelining yet
      // since there's nothing to play concurrently.
      const firstChunk = await this.chunker.getNextChunk();
      if (!firstChunk || this.cancelled) {
        return;
      }

      let currentAudio = await this.raceWithStop(
        synthesizeChunk(firstChunk.text),
        stopSignal,
      );
      if (!currentAudio || this.cancelled) {
        return;
      }
      if (currentAudio.samples.length === 0) {
        return;
      }

      let currentChunk = firstChunk;
      let chunkIdx = 0;

      // Main loop: play current chunk while synthesizing next.
      // eslint-disable-next-line no-constant-condition
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

        if (postProcess) {
          postProcess(currentAudio!);
        }

        this.emitProgress(currentChunk, chunkIdx);

        // Start fetching + synthesizing next chunk in background.
        const prefetchPromise = this.prefetchNext(synthesizeChunk, stopSignal);

        // Play current chunk (concurrent with prefetch).
        await this.raceWithStop(
          playAudio(currentAudio!, playbackOptions),
          stopSignal,
        );

        if (this.cancelled) {
          return;
        }

        this.lastChunkEndTs = Date.now();
        log.info(
          `chunk#${this.chunkCount} DONE: play=${this.lastChunkEndTs - chunkStartTs}ms, t+${this.rel()}ms`,
        );

        // Get prefetched result.
        const next = await prefetchPromise;
        if (!next || this.cancelled) {
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
      log.info(
        `stream session ended: chunks=${this.chunkCount}, elapsed=${this.rel()}ms`,
      );
    }
  }

  /**
   * Fetch the next chunk from the chunker and synthesize it. Returns
   * null if there are no more chunks or the session was cancelled.
   */
  private async prefetchNext(
    synthesizeChunk: (text: string) => Promise<AudioBuffer>,
    stopSignal: Promise<null>,
  ): Promise<{
    chunk: {text: string; startIndex: number; endIndex: number};
    audio: AudioBuffer;
  } | null> {
    const chunk = await this.chunker.getNextChunk();
    if (!chunk || this.cancelled) {
      return null;
    }
    const audio = await this.raceWithStop(
      synthesizeChunk(chunk.text),
      stopSignal,
    );
    if (!audio || this.cancelled || audio.samples.length === 0) {
      return null;
    }
    return {chunk, audio};
  }

  private emitProgress(
    chunk: {text: string; startIndex: number; endIndex: number},
    chunkIndex: number,
  ): void {
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
