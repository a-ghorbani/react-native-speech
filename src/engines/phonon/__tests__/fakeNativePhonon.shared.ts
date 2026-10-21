/**
 * Deferred-controlled fake of `NativePhonon` for engine tests.
 *
 * It models the native contract closely enough for race tests:
 * - process-wide monotonic request ids and a `fetch_max` cancel
 *   watermark; a request resolved at or below the watermark comes back
 *   `cancelled: true` without a buffer,
 * - a buffer store: play consumes, release is idempotent, copy does not
 *   consume, so `liveBuffers()` shows leaks,
 * - synth and play calls stay pending until the test settles them,
 *   unless `autoSynth` / `autoPlay` is on.
 */

import type {
  PhononLoadResult,
  PhononPlayConfig,
  PhononSupportInfo,
  PhononSynthResult,
} from '../../../NativeSpeech';

export interface FakeSynth {
  handleId: number;
  requestId: number;
  text: string;
  voice: string;
  language: string;
  settled: boolean;
  /** Resolve like native would (honors the cancel watermark). */
  resolve: (opts?: {samples?: number; cancelled?: boolean}) => void;
  reject: (err: Error) => void;
}

export interface FakePlay {
  bufferId: number;
  config: PhononPlayConfig;
  settled: boolean;
  resolve: () => void;
  reject: (err: Error) => void;
}

export const OK_SUPPORT: PhononSupportInfo = {
  supported: true,
  reason: 'ok',
  detail: '',
  abi: 'arm64-v8a',
  osVersion: '16',
  libraryVersion: '0.4.0-r1',
  isSimulator: false,
  pageSize: 4096,
};

export const NOT_COMPILED: PhononSupportInfo = {
  supported: false,
  reason: 'not-compiled',
  detail: 'Phonon native methods are not present in this build',
  abi: '',
  osVersion: '',
  libraryVersion: '',
  isSimulator: false,
  pageSize: 0,
};

export function defaultLoadResult(): PhononLoadResult {
  return {
    handleId: 1,
    voices: ['Alba', 'Marius'],
    languages: ['en'],
    defaultVoice: 'Alba',
    sampleRate: 24000,
    loadMs: 120,
    compiled: false,
    numThreads: 4,
    computeUnit: 'cpu',
  };
}

function float32ToBase64(samples: Float32Array): string {
  return Buffer.from(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  ).toString('base64');
}

export function createFakeNativePhonon() {
  let nextId = 0;
  let watermark = 0;
  let nextBuffer = 100;
  let nextHandle = 0;
  const buffers = new Map<number, {requestId: number; samples: number}>();
  const synths: FakeSynth[] = [];
  const plays: FakePlay[] = [];
  const state = {
    autoSynth: false,
    autoPlay: false,
    support: {...OK_SUPPORT} as PhononSupportInfo,
    load: defaultLoadResult(),
    /** Value of every copyBuffer sample before volume */
    pcmValue: 0.5,
    /** destroy() never settles (serial worker stuck behind a hung job) */
    hangDestroy: false,
  };

  const synthResult = (
    requestId: number,
    bufferId: number,
    samples: number,
    cancelled: boolean,
  ): PhononSynthResult => ({
    requestId,
    bufferId,
    samples,
    sampleRate: 24000,
    ttfaMs: 40,
    totalMs: 80,
    queuedMs: 1,
    voiceChanged: false,
    cancelled,
    startedAtMs: 1000,
    finishedAtMs: 1080,
  });

  const api = {
    isPresent: jest.fn(() => true),
    getSupport: jest.fn(async () => ({...state.support})),
    needsCompile: jest.fn(async (_dir: string) => false),
    create: jest.fn(async (_dir: string, _opts: unknown) => ({
      ...state.load,
      handleId: ++nextHandle,
    })),
    allocRequestId: jest.fn(() => ++nextId),
    synthesize: jest.fn(
      (
        handleId: number,
        requestId: number,
        text: string,
        voice: string,
        language: string,
      ) =>
        new Promise<PhononSynthResult>((resolve, reject) => {
          const call: FakeSynth = {
            handleId,
            requestId,
            text,
            voice,
            language,
            settled: false,
            resolve: opts => {
              if (call.settled) return;
              call.settled = true;
              const cancelled = opts?.cancelled ?? requestId <= watermark;
              const samples = opts?.samples ?? text.length * 100;
              if (cancelled || samples === 0) {
                resolve(synthResult(requestId, 0, 0, cancelled));
                return;
              }
              const bufferId = ++nextBuffer;
              buffers.set(bufferId, {requestId, samples});
              resolve(synthResult(requestId, bufferId, samples, false));
            },
            reject: err => {
              if (call.settled) return;
              call.settled = true;
              reject(err);
            },
          };
          synths.push(call);
          if (state.autoSynth) {
            call.resolve();
          }
        }),
    ),
    cancelUpTo: jest.fn((id: number) => {
      watermark = Math.max(watermark, id);
      return true;
    }),
    cancelAll: jest.fn(() => {
      watermark = Math.max(watermark, nextId);
      return true;
    }),
    playBuffer: jest.fn(
      (bufferId: number, config: PhononPlayConfig) =>
        new Promise<void>((resolve, reject) => {
          const known = buffers.delete(bufferId);
          const call: FakePlay = {
            bufferId,
            config,
            settled: false,
            resolve: () => {
              if (call.settled) return;
              call.settled = true;
              resolve();
            },
            reject: err => {
              if (call.settled) return;
              call.settled = true;
              reject(err);
            },
          };
          plays.push(call);
          if (!known) {
            call.reject(
              Object.assign(new Error('unknown buffer'), {
                code: 'PHONON_INVALID_BUFFER',
              }),
            );
          } else if (state.autoPlay) {
            call.resolve();
          }
        }),
    ),
    copyBuffer: jest.fn(async (bufferId: number) => {
      const buf = buffers.get(bufferId);
      if (!buf) {
        throw Object.assign(new Error('unknown buffer'), {
          code: 'PHONON_INVALID_BUFFER',
        });
      }
      return float32ToBase64(
        new Float32Array(buf.samples).fill(state.pcmValue),
      );
    }),
    releaseBuffer: jest.fn((bufferId: number) => {
      buffers.delete(bufferId);
      return true;
    }),
    destroy: jest.fn((_handleId: number): Promise<void> => {
      if (state.hangDestroy) {
        // Queued behind a hung synth on the serial worker: never settles.
        return new Promise<void>(() => {});
      }
      buffers.clear();
      return Promise.resolve();
    }),
    resetSupport: jest.fn(async () => true),
    getDiagnostics: jest.fn(async () => ({
      memKb: 0,
      peakMemKb: 0,
      threads: 0,
      libraryLoaded: true,
      handleOpen: true,
      liveBuffers: buffers.size,
      orphanBuffers: 0,
      busy: 'idle',
      lastIssuedId: nextId,
      cancelWatermark: watermark,
    })),
  };

  return {
    api,
    state,
    synths,
    plays,
    liveBuffers: () => buffers.size,
    watermark: () => watermark,
    lastIssuedId: () => nextId,
    /** Reset per-test state; ids and watermark stay monotonic. */
    reset() {
      synths.length = 0;
      plays.length = 0;
      buffers.clear();
      state.autoSynth = false;
      state.autoPlay = false;
      state.support = {...OK_SUPPORT};
      state.load = defaultLoadResult();
      state.pcmValue = 0.5;
      state.hangDestroy = false;
      for (const fn of Object.values(api)) {
        fn.mockClear();
      }
    },
  };
}

export type FakeNativePhonon = ReturnType<typeof createFakeNativePhonon>;
