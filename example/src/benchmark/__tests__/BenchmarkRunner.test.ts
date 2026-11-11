/**
 * Benchmark runner, Phonon block: a multi-sentence speak reports the
 * first chunk's native timings (not the last chunk's), plus per-call
 * totals.
 */

type Listener = (...args: any[]) => void;

const mockState = {
  start: new Set<Listener>(),
  finish: new Set<Listener>(),
  chunk: new Set<Listener>(),
  metrics: new Set<Listener>(),
  requestId: 0,
  markers: [] as string[],
  /** What performance.now() returns; speak() advances it per chunk. */
  clock: 0,
};

function mockEmit(set: Set<Listener>, ...args: any[]) {
  [...set].forEach(l => l(...args));
}

/** Three chunks; only the first has a small ttfa. */
const MOCK_CHUNKS = [
  {ttfaMs: 90, totalMs: 300, queuedMs: 2, audioSec: 1.5},
  {ttfaMs: 400, totalMs: 900, queuedMs: 600, audioSec: 2},
  {ttfaMs: 500, totalMs: 1000, queuedMs: 800, audioSec: 2.5},
];

jest.mock('@pocketpalai/react-native-speech', () => {
  const sub = (key: 'start' | 'finish') => (cb: Listener) => {
    mockState[key].add(cb);
    return {remove: () => mockState[key].delete(cb)};
  };
  const Speech = {
    initialize: jest.fn(async () => {}),
    release: jest.fn(async () => ({success: true, errors: []})),
    getVoices: jest.fn(async () => ['default']),
    speak: jest.fn(async () => {
      let t = Date.now();
      MOCK_CHUNKS.forEach((c, i) => {
        mockEmit(mockState.chunk, {chunkIndex: i});
        // Native start/finish fire per played chunk (#116): 10 ms of
        // synthesis, then 100 ms of audio.
        mockState.clock += 10;
        mockEmit(mockState.start);
        mockEmit(mockState.metrics, {
          event: 'PHONON_CHUNK',
          path: 'synth',
          requestId: ++mockState.requestId,
          chars: 20,
          samples: c.audioSec * 24000,
          startedAtMs: 0,
          finishedAtMs: 0,
          playStartTs: t,
          playEndTs: t + 1,
          voiceChanged: i === 0,
          ...c,
        });
        t += 10;
        mockState.clock += 100;
        mockEmit(mockState.finish);
      });
    }),
    onStart: sub('start'),
    onFinish: sub('finish'),
    onError: () => ({remove: () => {}}),
    onChunkProgress: (cb: Listener) => {
      mockState.chunk.add(cb);
      return () => mockState.chunk.delete(cb);
    },
  };
  return {
    __esModule: true,
    default: Speech,
    TTSEngine: {KITTEN: 'kitten'},
    engineManager: {
      getEngine: () => ({
        onChunkMetrics: (cb: Listener) => {
          mockState.metrics.add(cb);
          return () => mockState.metrics.delete(cb);
        },
        getLoadInfo: () => ({loadMs: 70, numThreads: 4, computeUnit: 'cpu'}),
      }),
    },
  };
});

jest.mock('../NativeBenchmark', () => ({
  __esModule: true,
  default: {
    logMarker: (m: string) => mockState.markers.push(m),
    clearMarkers: () => {},
    getMemoryStats: async () => ({
      nativeHeapAllocatedMB: 10,
      totalMemoryMB: 8000,
      availableMemoryMB: 4000,
    }),
    startMemoryPolling: () => {},
    stopMemoryPolling: async () => ({peakNativeHeapMB: 12, sampleCount: 1}),
    beginTraceInterval: () => {},
    endTraceInterval: () => {},
  },
}));

jest.mock('@pocketpalai/react-native-speech-phonon', () => ({
  __esModule: true,
  PHONON: 'phonon',
}));

import {runBenchmark} from '../BenchmarkRunner';

beforeEach(() => {
  mockState.clock = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => mockState.clock);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  // Skip the GC pauses between iterations.
  jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void) => {
    cb();
    return 0;
  }) as any);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('reports the first chunk of each call as the Phonon ttfa', async () => {
  const [summary] = await runBenchmark(
    {
      engines: [
        {
          engine: 'phonon',
          label: 'Phonon',
          variant: '31m-en',
          getInitConfig: () => ({modelPath: '/m'}),
        } as any,
      ],
      iterations: 2,
      warmupIterations: 0,
      testPhrase: 'One. Two. Three.',
      providerLabel: 'CPU',
      providers: ['cpu'],
    },
    () => {},
  );

  expect(summary!.iterations).toHaveLength(2);
  for (const r of summary!.iterations) {
    expect(r.phonon).toEqual({
      ttfaMs: 90,
      totalMs: 300,
      queuedMs: 2,
      voiceChanged: true,
      chunkCount: 3,
      synthTotalMs: 2200,
      audioSec: 6,
      numThreads: 4,
      computeUnit: 'cpu',
      loadMs: 70,
    });
  }
  expect(summary!.stats.nativeTtfaMs).toMatchObject({min: 90, max: 90});
  const speakEnd = mockState.markers.find(m => m.includes('SPEAK_END'))!;
  expect(speakEnd).toContain('"ttfaMs":90');
});

it('times a multi-chunk speak from its first chunk to its end (#116)', async () => {
  const [summary] = await runBenchmark(
    {
      engines: [
        {
          engine: 'kitten',
          label: 'Kitten',
          getInitConfig: () => ({modelPath: '/m'}),
        } as any,
      ],
      iterations: 1,
      warmupIterations: 0,
      testPhrase: 'One. Two. Three.',
      providerLabel: 'CPU',
      providers: ['cpu'],
    },
    () => {},
  );

  // Three chunks of 10 ms synthesis + 100 ms audio.
  expect(summary!.iterations[0]).toMatchObject({
    ttfaMs: 10,
    totalSpeakMs: 330,
  });
});
