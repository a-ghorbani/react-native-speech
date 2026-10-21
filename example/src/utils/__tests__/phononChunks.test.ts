/**
 * Per-chunk Phonon metrics: the collector sees the chunks played between
 * start() and flush(); the utterance summary reports the first played chunk.
 */

jest.mock('@pocketpalai/react-native-speech', () => ({
  __esModule: true,
  default: {},
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
  const listeners = new Set<(m: PhononChunkMetrics) => void>();
  return {
    play: (m: PhononChunkMetrics) => listeners.forEach(l => l(m)),
    listeners,
    source: (listener: (m: PhononChunkMetrics) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

describe('ChunkCollector', () => {
  it('collects the chunks played between start and flush', () => {
    const f = fakeSource();
    const seen: number[] = [];
    const c = new ChunkCollector(m => seen.push(m.requestId), f.source);
    f.play(chunk(1, 1000)); // before start
    c.start();
    f.play(chunk(2, 2000));
    f.play(chunk(3, 3000));
    const out = c.flush();
    f.play(chunk(4, 4000)); // after flush

    expect(out.map(m => m.requestId)).toEqual([2, 3]);
    expect(seen).toEqual([2, 3]);
    expect(f.listeners.size).toBe(0);
  });

  it('restarting resets the chunks and keeps one subscription', () => {
    const f = fakeSource();
    const c = new ChunkCollector(undefined, f.source);
    c.start();
    f.play(chunk(1, 1000));
    c.start();
    expect(c.chunks).toEqual([]);
    expect(f.listeners.size).toBe(1);
    expect(c.flush()).toEqual([]);
  });

  it('collects nothing when the Phonon engine is not registered', () => {
    const {engineManager} = jest.requireMock(
      '@pocketpalai/react-native-speech',
    );
    engineManager.getEngine.mockImplementation(() => {
      throw new Error('not registered');
    });
    const c = new ChunkCollector();
    c.start();
    expect(c.flush()).toEqual([]);
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
