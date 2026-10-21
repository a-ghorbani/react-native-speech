/**
 * Per-chunk Phonon metrics: the collector sees every chunk of a call once
 * (and none from earlier calls); the utterance summary reports the first
 * played chunk.
 */

jest.mock('@pocketpalai/react-native-speech', () => ({
  __esModule: true,
  default: {onChunkProgress: jest.fn(() => () => {})},
  TTSEngine: {},
  engineManager: {getEngine: jest.fn()},
}));

jest.mock('@pocketpalai/react-native-speech-phonon', () => ({
  __esModule: true,
  PHONON: 'phonon',
}));

import {
  ChunkCollector,
  chunksStartedAfter,
  utteranceMetrics,
} from '../phononChunks';
import type {PhononChunkMetrics} from '@pocketpalai/react-native-speech-phonon';

function chunk(
  requestId: number,
  playStartTs: number,
  extra: Partial<PhononChunkMetrics> = {},
): PhononChunkMetrics {
  return {
    event: 'PHONON_CHUNK',
    path: 'synth',
    requestId,
    chars: 10,
    samples: 24000,
    audioSec: 1,
    ttfaMs: 100 + requestId,
    totalMs: 200 + requestId,
    queuedMs: requestId,
    startedAtMs: 0,
    finishedAtMs: 0,
    playStartTs,
    playEndTs: playStartTs + 1000,
    voiceChanged: false,
    ...extra,
  };
}

function fakeSource() {
  let last: PhononChunkMetrics | null = null;
  const listeners = new Set<() => void>();
  return {
    set: (m: PhononChunkMetrics | null) => {
      last = m;
    },
    progress: () => listeners.forEach(l => l()),
    listeners,
    source: {
      read: () => last,
      subscribe: (cb: () => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
  };
}

describe('ChunkCollector', () => {
  it('collects each chunk of the call once and skips earlier calls', () => {
    const f = fakeSource();
    f.set(chunk(1, 1000)); // left over from an earlier call
    const seen: number[] = [];
    const c = new ChunkCollector(m => seen.push(m.requestId), f.source);
    c.start();

    f.progress(); // chunk 0 starts: only the stale chunk is recorded
    f.set(chunk(2, 2000));
    f.progress(); // chunk 1 starts: chunk 0 recorded
    f.progress(); // duplicate event
    f.set(chunk(3, 3000));
    f.set(chunk(4, 4000)); // last chunk, picked up by flush
    const out = c.flush();

    expect(out.map(m => m.requestId)).toEqual([2, 4]);
    expect(seen).toEqual([2, 4]);
    expect(f.listeners.size).toBe(0);
  });

  it('restarting resets the chunks and keeps one subscription', () => {
    const f = fakeSource();
    const c = new ChunkCollector(undefined, f.source);
    c.start();
    f.set(chunk(1, 1000));
    c.poll();
    c.start();
    expect(c.chunks).toEqual([]);
    expect(f.listeners.size).toBe(1);
    expect(c.flush()).toEqual([]); // chunk 1 is now stale
  });
});

describe('utteranceMetrics', () => {
  it('reports the earliest played chunk and sums the totals', () => {
    const u = utteranceMetrics([
      chunk(3, 3000),
      chunk(1, 1000, {voiceChanged: true}),
      chunk(2, 2000),
    ])!;
    expect(u.first.requestId).toBe(1);
    expect(u.first.ttfaMs).toBe(101);
    expect(u.first.voiceChanged).toBe(true);
    expect(u.chunkCount).toBe(3);
    expect(u.synthTotalMs).toBe(201 + 202 + 203);
    expect(u.audioSec).toBe(3);
  });

  it('is null without chunks', () => {
    expect(utteranceMetrics([])).toBeNull();
  });
});

describe('chunksStartedAfter', () => {
  it('keeps only chunks whose playback was requested after the time', () => {
    const out = chunksStartedAfter(
      [chunk(1, 900), chunk(2, 1000), chunk(3, 1004)],
      1000,
    );
    expect(out.map(m => m.requestId)).toEqual([3]);
  });
});
