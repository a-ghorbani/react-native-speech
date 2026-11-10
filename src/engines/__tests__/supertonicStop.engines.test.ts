/**
 * #105: one Supertonic chunk is several model runs (duration, text
 * encoder, one per diffusion step, vocoder). stop(), a replacing
 * utterance and release() must not start another run of the old chunk,
 * and with the patched onnxruntime-react-native binding they also end
 * the run in flight (#97's RunAborter). Each run here waits until the
 * test settles it.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
// Sessions handed out by InferenceSession.create, keyed by model path.
const mockSessions: Record<string, object> = {};
jest.mock(
  'onnxruntime-react-native',
  () => ({
    InferenceSession: {create: async (path: string) => mockSessions[path]},
    Tensor: function Tensor(
      this: object,
      type: string,
      data: unknown,
      dims: number[],
    ) {
      Object.assign(this, {type, data, dims});
    },
  }),
  {virtual: true},
);

const pendingPlays: Array<() => void> = [];
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    play: jest.fn(() => new Promise<void>(r => pendingPlays.push(r))),
    stop: jest.fn(async () => {
      pendingPlays.splice(0).forEach(r => r());
    }),
  },
}));

import {SupertonicEngine} from '../supertonic/SupertonicEngine';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';

const play = neuralAudioPlayer.play as jest.Mock;
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const TERMINATED = 'Exiting due to terminate flag being set to true.';
const STEPS = 5;

type Binding = 'bridge' | 'unpatched' | 'patched';
type Model = 'dp' | 'te' | 've' | 'voc';

interface Run {
  model: Model;
  /** Text length of the utterance; 0 for the vocoder. */
  text: number;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (e: Error) => void;
}

const OUTPUTS: Record<Model, (seqLen: number) => object> = {
  dp: () => ({duration: {data: [0.5], dims: [1]}}),
  te: seqLen => ({
    text_emb: {data: new Float32Array(4 * seqLen), dims: [1, 4, seqLen]},
  }),
  ve: () => ({denoised_latent: {data: new Float32Array(144 * 8)}}),
  voc: () => ({wav_tts: {data: new Float32Array(22050).fill(0.1)}}),
};

/** The 4 model sessions; every run is logged and waits to be settled. */
function models(binding: Binding) {
  const runs: Run[] = [];
  const make = (model: Model) => ({
    run: jest.fn(
      (
        feeds: {text_ids?: {dims: number[]}; text_emb?: {dims: number[]}},
        opts?: {signal?: AbortSignal},
      ) =>
        new Promise((resolve, reject) => {
          const signal = opts?.signal;
          // The text length tells the utterances apart (not on the vocoder).
          const seqLen =
            feeds.text_ids?.dims[1] ?? feeds.text_emb?.dims[2] ?? 0;
          runs.push({
            model,
            text: seqLen,
            signal,
            resolve: () => resolve(OUTPUTS[model](seqLen)),
            reject,
          });
          if (binding === 'patched') {
            signal?.addEventListener('abort', () =>
              reject(new Error(TERMINATED)),
            );
          }
        }),
    ),
    release: jest.fn(async () => {}),
  });
  const sessions = {
    dp: make('dp'),
    te: make('te'),
    ve: make('ve'),
    voc: make('voc'),
  };
  return {
    sessions,
    runs,
    /** Settles the latest run; runs of other utterances may be pending. */
    finishLast: () => runs[runs.length - 1]!.resolve(),
  };
}

async function engine(m: ReturnType<typeof models>) {
  const e = new SupertonicEngine() as any;
  e.isInitialized = true;
  e.config = {maxChunkSize: 400};
  const unicode = {
    isReady: () => true,
    normalize: (t: string) => t,
    textToUnicodeIds: (t: string) => new BigInt64Array(t.length),
    clear: jest.fn(),
  };
  e.unicodeProcessor = unicode;
  e.styleLoader = {
    getVoiceStyle: jest.fn(async () => ({
      styleDp: new Float32Array(128),
      styleTtl: new Float32Array(12800),
    })),
    clear: jest.fn(),
  };
  Object.assign(mockSessions, m.sessions);
  e.inference.setUnicodeProcessor(unicode);
  await e.inference.initialize({
    durationPredictorPath: 'dp',
    textEncoderPath: 'te',
    vectorEstimatorPath: 've',
    vocoderPath: 'voc',
  });
  return e;
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  if (!cond()) throw new Error('timed out');
}

/** Lets the runs of the latest chunk proceed until `count` have started. */
async function advanceTo(m: ReturnType<typeof models>, count: number) {
  await until(() => m.runs.length >= 1);
  while (m.runs.length < count) {
    const n = m.runs.length;
    m.finishLast();
    await until(() => m.runs.length > n);
  }
}

const A = 'The first reply is here.';
const B = 'A new reply.';
const opts = {inferenceSteps: STEPS};
// duration, text encoder, the diffusion steps, vocoder
const RUNS_PER_CHUNK = 3 + STEPS;

beforeEach(() => {
  play.mockClear();
  pendingPlays.length = 0;
});
afterEach(() => {
  delete (globalThis as any).OrtApi;
});

function bind(binding: Binding) {
  if (binding !== 'bridge') (globalThis as any).OrtApi = {};
}

test('a chunk runs duration, encoder, every diffusion step and the vocoder, then plays', async () => {
  const m = models('unpatched');
  const e = await engine(m);
  const spoken = e.synthesize(A, opts);
  await advanceTo(m, RUNS_PER_CHUNK);
  m.finishLast();
  await until(() => play.mock.calls.length === 1);
  pendingPlays.splice(0).forEach(r => r());
  await expect(spoken).resolves.toBeUndefined();
  expect(m.runs.map(r => r.model)).toEqual([
    'dp',
    'te',
    've',
    've',
    've',
    've',
    've',
    'voc',
  ]);
});

describe.each<Binding>(['bridge', 'unpatched', 'patched'])(
  '%s binding',
  binding => {
    beforeEach(() => bind(binding));

    test.each([
      ['after the duration run', 1],
      ['after the text encoder', 2],
      ['between diffusion steps', 4],
      ['before the vocoder', 7],
    ])(
      'stop() %s: no further run of the chunk starts; speak resolves, nothing plays',
      async (_where, started) => {
        const m = models(binding);
        const e = await engine(m);
        const spoken = e.synthesize(A, opts);
        await advanceTo(m, started);
        await e.stop();
        m.finishLast();
        await expect(spoken).resolves.toBeUndefined();
        await tick(20);
        expect(m.runs).toHaveLength(started);
        expect(play).not.toHaveBeenCalled();
      },
    );

    test('a new speak() mid-chunk: the old chunk starts no further run; the new one plays (#104)', async () => {
      const m = models(binding);
      const e = await engine(m);
      const a = e.synthesize(A, opts);
      await advanceTo(m, 4);
      const aRun = m.runs[3]!;
      const b = e.synthesize(B, opts);
      aRun.resolve();
      await tick(20);
      await until(() => m.runs.some(r => r.text === B.length));
      const fromA = () => m.runs.filter(r => r.text === A.length);
      expect(fromA()).toHaveLength(4);
      await advanceTo(m, 4 + RUNS_PER_CHUNK);
      m.finishLast();
      await until(() => play.mock.calls.length === 1);
      pendingPlays.splice(0).forEach(r => r());
      await expect(a).resolves.toBeUndefined();
      await expect(b).resolves.toBeUndefined();
      expect(fromA()).toHaveLength(4);
      expect(play).toHaveBeenCalledTimes(1);
    });

    test('a new stream mid-chunk: the old stream starts no further run and settles', async () => {
      const m = models(binding);
      const e = await engine(m);
      const a = e.synthesizeStream(opts);
      a.append(A);
      const aDone = a.finalize();
      await advanceTo(m, 4);
      const aRun = m.runs[3]!;
      const b = e.synthesizeStream(opts);
      b.append(B);
      const bDone = b.finalize();
      aRun.resolve();
      await expect(aDone).resolves.toBeUndefined();
      await until(() => m.runs.some(r => r.text === B.length));
      await advanceTo(m, 4 + RUNS_PER_CHUNK);
      m.finishLast();
      await until(() => play.mock.calls.length === 1);
      pendingPlays.splice(0).forEach(r => r());
      await expect(bDone).resolves.toBeUndefined();
      expect(m.runs.filter(r => r.text === A.length)).toHaveLength(4);
    });

    test('release() mid-chunk: no further run starts; the sessions are freed once the run in flight ends', async () => {
      const m = models(binding);
      const e = await engine(m);
      const spoken = e.synthesize(A, opts);
      await advanceTo(m, 4);
      const released = e.release();
      m.finishLast();
      const res = await released;
      expect(res.success).toBe(true);
      await expect(spoken).resolves.toBeUndefined();
      await tick(20);
      expect(m.runs).toHaveLength(4);
      expect(m.sessions.ve.release).toHaveBeenCalledTimes(1);
      expect(play).not.toHaveBeenCalled();
    });

    test('a chunk stopped mid-diffusion resolves to empty audio, not an error', async () => {
      const m = models(binding);
      const e = await engine(m);
      const style = await e.styleLoader.getVoiceStyle('F1');
      const chunk = e.synthesizeChunk(A, style, STEPS, 1, 'en', e.utteranceGen);
      await advanceTo(m, 4);
      await e.stop();
      m.finishLast();
      const audio = await chunk;
      expect(audio.samples.length).toBe(0);
      expect(audio.duration).toBe(0);
      expect(m.runs).toHaveLength(4);
    });

    test('a run that fails on its own still fails speak()', async () => {
      const m = models(binding);
      const e = await engine(m);
      const spoken = e.synthesize(A, opts);
      await advanceTo(m, 4);
      m.runs[3]!.reject(new Error('model exploded'));
      await expect(spoken).rejects.toThrow('model exploded');
    });
  },
);

const TWO = 'The first reply is here. The second one follows it.';

describe.each<Binding>(['unpatched', 'patched'])(
  '%s binding, two chunks',
  binding => {
    beforeEach(() => bind(binding));

    test.each(['speak', 'stream'])(
      '%s: stop() while chunk 1 plays and chunk 2 is mid-diffusion: chunk 2 starts no further run',
      async kind => {
        const m = models(binding);
        const e = await engine(m);
        e.config = {maxChunkSize: 30};
        let done: Promise<void>;
        if (kind === 'speak') {
          done = e.synthesize(TWO, opts);
        } else {
          const h = e.synthesizeStream(opts);
          h.append(TWO);
          done = h.finalize();
        }
        await advanceTo(m, RUNS_PER_CHUNK);
        m.finishLast();
        await until(() => play.mock.calls.length === 1);
        await advanceTo(m, RUNS_PER_CHUNK + 4);
        await e.stop();
        m.finishLast();
        await expect(done).resolves.toBeUndefined();
        await tick(20);
        expect(m.runs).toHaveLength(RUNS_PER_CHUNK + 4);
        expect(play).toHaveBeenCalledTimes(1);
      },
    );
  },
);

test('a stream unit still waiting for its voice style starts no run once a new speak() replaced it (#104)', async () => {
  const m = models('unpatched');
  const e = await engine(m);
  let styleReady!: () => void;
  const style = await e.styleLoader.getVoiceStyle('F1');
  e.styleLoader.getVoiceStyle.mockImplementationOnce(
    () => new Promise(r => (styleReady = () => r(style))),
  );
  const a = e.synthesizeStream(opts);
  a.append(A);
  const aDone = a.finalize();
  await tick(20);
  const b = e.synthesize(B, opts);
  await until(() => m.runs.length === 1);
  styleReady();
  await expect(aDone).resolves.toBeUndefined();
  await advanceTo(m, RUNS_PER_CHUNK);
  m.finishLast();
  await until(() => play.mock.calls.length === 1);
  pendingPlays.splice(0).forEach(r => r());
  await expect(b).resolves.toBeUndefined();
  expect(m.runs.filter(r => r.text === A.length)).toHaveLength(0);
});

test('destroy() mid-chunk: no further run starts and speak resolves (no "session not initialized")', async () => {
  const m = models('unpatched');
  const e = await engine(m);
  const spoken = e.synthesize(A, opts);
  await advanceTo(m, 4);
  await e.destroy();
  m.finishLast();
  await expect(spoken).resolves.toBeUndefined();
  expect(m.runs).toHaveLength(4);
  expect(play).not.toHaveBeenCalled();
});

describe('patched binding: the run in flight ends too', () => {
  beforeEach(() => bind('patched'));

  test('stop() aborts the run in flight; nothing else runs; nothing plays', async () => {
    const m = models('patched');
    const e = await engine(m);
    const spoken = e.synthesize(A, opts);
    await advanceTo(m, 4);
    await e.stop();
    expect(m.runs[3]!.signal?.aborted).toBe(true);
    await expect(spoken).resolves.toBeUndefined();
    await tick(20);
    expect(m.runs).toHaveLength(4);
    expect(play).not.toHaveBeenCalled();
  });

  test("a new speak() aborts the old chunk's run, never the new one's", async () => {
    const m = models('patched');
    const e = await engine(m);
    const a = e.synthesize(A, opts);
    await advanceTo(m, 4);
    const b = e.synthesize(B, opts);
    expect(m.runs[3]!.signal?.aborted).toBe(true);
    await expect(a).resolves.toBeUndefined();
    await advanceTo(m, 4 + RUNS_PER_CHUNK);
    expect(m.runs.slice(4).every(r => r.signal?.aborted === false)).toBe(true);
    m.finishLast();
    await until(() => play.mock.calls.length === 1);
    pendingPlays.splice(0).forEach(r => r());
    await expect(b).resolves.toBeUndefined();
  });

  test('release() aborts the run in flight; the sessions are freed once it ends', async () => {
    const m = models('patched');
    const e = await engine(m);
    const spoken = e.synthesize(A, opts);
    await advanceTo(m, 4);
    const res = await e.release();
    expect(res.success).toBe(true);
    expect(m.runs[3]!.signal?.aborted).toBe(true);
    await expect(spoken).resolves.toBeUndefined();
    await until(() => m.sessions.ve.release.mock.calls.length === 1);
    expect(m.runs).toHaveLength(4);
  });

  test('after release() and initialize(), stop() still aborts the run in flight', async () => {
    const m = models('patched');
    const e = await engine(m);
    await e.release();
    e.isInitialized = true;
    e.inference.setUnicodeProcessor(e.unicodeProcessor);
    await e.inference.initialize({
      durationPredictorPath: 'dp',
      textEncoderPath: 'te',
      vectorEstimatorPath: 've',
      vocoderPath: 'voc',
    });
    const spoken = e.synthesize(A, opts);
    await advanceTo(m, 4);
    await e.stop();
    expect(m.runs[3]!.signal?.aborted).toBe(true);
    await expect(spoken).resolves.toBeUndefined();
  });
});
