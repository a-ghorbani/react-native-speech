/**
 * Per-chunk Phonon metrics for one speak call.
 *
 * `PhononEngine.getLastMetrics()` holds only the last played chunk, and
 * the engine records a chunk after it finishes playing. A collector reads
 * it on each chunk-progress event (which picks up the previous chunk) and
 * once more on `flush()` (the last chunk), so every chunk of a call is
 * seen once. Shared by the benchmark runner and the device self-test.
 */

import Speech, {engineManager} from '@pocketpalai/react-native-speech';
import {
  type PhononChunkMetrics,
  type PhononEngine,
  PHONON,
} from '@pocketpalai/react-native-speech-phonon';

export interface ChunkCollectorSource {
  /** Last recorded chunk (default: the Phonon engine's getLastMetrics) */
  read: () => PhononChunkMetrics | null;
  /** Subscribe to chunk progress; returns the unsubscribe function */
  subscribe: (cb: () => void) => () => void;
}

function phononEngine(): PhononEngine | null {
  try {
    return engineManager.getEngine(PHONON) as unknown as PhononEngine;
  } catch {
    return null;
  }
}

const DEFAULT_SOURCE: ChunkCollectorSource = {
  read: () => phononEngine()?.getLastMetrics() ?? null,
  subscribe: cb => Speech.onChunkProgress(() => cb()),
};

export class ChunkCollector {
  readonly chunks: PhononChunkMetrics[] = [];
  private seen = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly onChunk?: (m: PhononChunkMetrics) => void,
    private readonly source: ChunkCollectorSource = DEFAULT_SOURCE,
  ) {}

  start(): void {
    this.unsubscribe?.();
    this.chunks.length = 0;
    // Whatever is recorded now belongs to an earlier call.
    const stale = this.source.read();
    if (stale) {
      this.seen.add(chunkKey(stale));
    }
    this.unsubscribe = this.source.subscribe(() => this.poll());
  }

  /** Read the last recorded chunk now (also called on chunk progress). */
  poll(): void {
    const m = this.source.read();
    if (!m) {
      return;
    }
    const key = chunkKey(m);
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.chunks.push(m);
    this.onChunk?.(m);
  }

  /** Stop listening and pick up the last chunk. */
  flush(): PhononChunkMetrics[] {
    this.poll();
    this.unsubscribe?.();
    this.unsubscribe = null;
    return [...this.chunks];
  }
}

function chunkKey(m: PhononChunkMetrics): string {
  return `${m.requestId}:${m.playStartTs}`;
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
