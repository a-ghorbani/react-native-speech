/**
 * Per-chunk Phonon metrics for one speak call. Shared by the benchmark
 * runner and the device self-test.
 */

import {engineManager} from '@pocketpalai/react-native-speech';
import {
  type PhononChunkMetrics,
  type PhononEngine,
  PHONON,
} from '@pocketpalai/react-native-speech-phonon';

/** Subscribes to per-chunk metrics; returns the unsubscribe function. */
export type ChunkMetricsSource = (
  listener: (m: PhononChunkMetrics) => void,
) => () => void;

const engineSource: ChunkMetricsSource = listener => {
  try {
    const engine = engineManager.getEngine(PHONON) as unknown as PhononEngine;
    return engine.onChunkMetrics(listener);
  } catch {
    return () => {};
  }
};

export class ChunkCollector {
  readonly chunks: PhononChunkMetrics[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly onChunk?: (m: PhononChunkMetrics) => void,
    private readonly source: ChunkMetricsSource = engineSource,
  ) {}

  start(): void {
    this.unsubscribe?.();
    this.chunks.length = 0;
    this.unsubscribe = this.source(m => {
      this.chunks.push(m);
      this.onChunk?.(m);
    });
  }

  /** Stop listening; returns the chunks collected since `start()`. */
  flush(): PhononChunkMetrics[] {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return [...this.chunks];
  }
}

export interface UtteranceMetrics {
  /** The chunk that played first (earliest playStartTs) */
  first: PhononChunkMetrics;
  chunkCount: number;
  /** Sum of every chunk's native synthesis time */
  synthTotalMs: number;
  /** Sum of every chunk's audio duration */
  audioSec: number;
}

/** Summarize the chunks of one call; null when none were collected. */
export function utteranceMetrics(
  chunks: readonly PhononChunkMetrics[],
): UtteranceMetrics | null {
  if (chunks.length === 0) {
    return null;
  }
  let first = chunks[0]!;
  for (const c of chunks) {
    if (c.playStartTs < first.playStartTs) {
      first = c;
    }
  }
  return {
    first,
    chunkCount: chunks.length,
    synthTotalMs: chunks.reduce((a, c) => a + c.totalMs, 0),
    audioSec: chunks.reduce((a, c) => a + c.audioSec, 0),
  };
}

/** Chunks whose playback was requested after `ts` (JS wall clock). */
export function chunksStartedAfter(
  chunks: readonly PhononChunkMetrics[],
  ts: number,
): PhononChunkMetrics[] {
  return chunks.filter(c => c.playStartTs > ts);
}
