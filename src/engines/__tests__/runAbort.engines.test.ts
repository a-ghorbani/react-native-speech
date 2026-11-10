/**
 * #97: stop(), a replacing utterance and release() end the model run in
 * flight, through the real synthesizeChunk of each ONNX engine. The
 * session's run() settles by hand; "patched" rejects it on abort as the
 * patched onnxruntime-react-native binding does. Unpatched bindings
 * (and the 1.23 bridge) must behave exactly as before.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock(
  'onnxruntime-react-native',
  () => ({
    Tensor: function Tensor(this: object, type: string, data: unknown) {
      Object.assign(this, {type, data});
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
jest.mock('../../phonemization', () => ({
  loadNativeDict: jest.fn(),
}));

import {KokoroEngine} from '../kokoro/KokoroEngine';
import {KittenEngine} from '../kitten/KittenEngine';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';

const play = neuralAudioPlayer.play as jest.Mock;
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const TERMINATED = 'Exiting due to terminate flag being set to true.';
const TWO = 'The first sentence is here. The second one follows it.';

type Binding = 'bridge' | 'unpatched' | 'patched';

/** A model session; each run waits for `finish()` or `fail()`. */
function session(binding: Binding) {
  const runs: Array<{
    signal?: AbortSignal;
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];
  const run = jest.fn(
    (_feeds: unknown, opts?: {signal?: AbortSignal}) =>
      new Promise((resolve, reject) => {
        const signal = opts?.signal;
        runs.push({
          signal,
          resolve: () =>
            resolve({
              waveform: {data: new Float32Array(9600).fill(0.1)},
            }),
          reject,
        });
        if (binding === 'patched') {
          signal?.addEventListener('abort', () =>
            reject(new Error(TERMINATED)),
          );
        }
      }),
  );
  const release = jest.fn(async () => {});
  return {
    session: {run, release},
    runs,
    finish: () => runs.forEach(r => r.resolve()),
    fail: (e: Error) => runs.forEach(r => r.reject(e)),
  };
}

const ENGINES: Array<[string, (s: object) => any]> = [
  [
    'Kokoro',
    s => {
      const e = new KokoroEngine() as any;
      e.isInitialized = true;
      e.session = s;
      e.config = {maxChunkSize: 30};
      e.voiceLoader = {
        getVoiceEmbedding: jest.fn(async () => new Float32Array(256)),
        clear: jest.fn(),
      };
      e.tokenizer = {clear: jest.fn()};
      e.synthesizeTextChunk = () =>
        e.inflight.track(
          e.synthesizeChunk([0, 5, 6, 0], 'af_heart', e.utteranceGen),
        );
      return e;
    },
  ],
  [
    'Kitten',
    s => {
      const e = new KittenEngine() as any;
      e.isInitialized = true;
      e.session = s;
      e.config = {maxChunkSize: 30};
      e.voiceLoader = {
        getStyleEmbedding: jest.fn(async () => new Float32Array(256)),
        clear: jest.fn(),
      };
      e.synthesizeTextChunk = (text: string) =>
        e.inflight.track(
          e.synthesizeChunk([0, 5, 6, 0], 'Bella', text.length, e.utteranceGen),
        );
      return e;
    },
  ],
];

async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  if (!cond()) throw new Error('timed out');
}

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

describe.each(ENGINES)('%s', (_name, make) => {
  test('patched binding: stop() terminates the run in flight; speak resolves, nothing plays', async () => {
    bind('patched');
    const m = session('patched');
    const e = make(m.session);
    const spoken = e.synthesize(TWO);
    await until(() => m.runs.length === 1);
    await e.stop();
    expect(m.runs[0]!.signal?.aborted).toBe(true);
    await expect(spoken).resolves.toBeUndefined();
    await tick(20);
    expect(play).not.toHaveBeenCalled();
    expect(m.session.run).toHaveBeenCalledTimes(1);
  });

  test('patched binding: a chunk whose run was terminated resolves to empty audio, not an error', async () => {
    bind('patched');
    const m = session('patched');
    const e = make(m.session);
    const chunk = e.synthesizeTextChunk('The first sentence is here.');
    await until(() => m.runs.length === 1);
    await e.stop();
    const audio = await chunk;
    expect(audio.samples.length).toBe(0);
    expect(audio.duration).toBe(0);
  });

  test('patched binding: a new utterance terminates the old run, never its own', async () => {
    bind('patched');
    const m = session('patched');
    const e = make(m.session);
    const a = e.synthesize(TWO);
    await until(() => m.runs.length === 1);
    const b = e.synthesize('A new reply.');
    await until(() => m.runs.length === 2);
    expect(m.runs[0]!.signal?.aborted).toBe(true);
    expect(m.runs[1]!.signal?.aborted).toBe(false);
    await expect(a).resolves.toBeUndefined();
    m.runs[1]!.resolve();
    await until(() => play.mock.calls.length === 1);
    pendingPlays.splice(0).forEach(r => r());
    await expect(b).resolves.toBeUndefined();
  });

  test('patched binding: stop() mid-stream terminates the run; the stream settles without error', async () => {
    bind('patched');
    const m = session('patched');
    const e = make(m.session);
    const h = e.synthesizeStream();
    h.append(TWO);
    const done = h.finalize();
    await until(() => m.runs.length >= 1);
    await e.stop();
    expect(m.runs.every(r => r.signal?.aborted)).toBe(true);
    await expect(done).resolves.toBeUndefined();
    expect(play).not.toHaveBeenCalled();
  });

  test("patched binding: a new stream terminates the old stream's run, never its own", async () => {
    bind('patched');
    const m = session('patched');
    const e = make(m.session);
    const a = e.synthesizeStream();
    a.append(TWO);
    const aDone = a.finalize();
    await until(() => m.runs.length >= 1);
    const before = m.runs.length;
    const b = e.synthesizeStream();
    b.append('A new reply.');
    const bDone = b.finalize();
    await until(() => m.runs.length === before + 1);
    expect(m.runs.slice(0, before).every(r => r.signal?.aborted)).toBe(true);
    expect(m.runs[before]!.signal?.aborted).toBe(false);
    await expect(aDone).resolves.toBeUndefined();
    m.runs[before]!.resolve();
    await until(() => play.mock.calls.length === 1);
    pendingPlays.splice(0).forEach(r => r());
    await expect(bDone).resolves.toBeUndefined();
  });

  test('a run that fails differently after the abort is still a stop', async () => {
    bind('unpatched');
    const m = session('unpatched');
    const e = make(m.session);
    const spoken = e.synthesize(TWO);
    await until(() => m.runs.length === 1);
    await e.stop();
    m.fail(new Error('Session is released'));
    await expect(spoken).resolves.toBeUndefined();
  });

  test('patched binding: release() terminates the run and frees the session once it ends', async () => {
    bind('patched');
    const m = session('patched');
    const e = make(m.session);
    const spoken = e.synthesize(TWO);
    await until(() => m.runs.length === 1);
    const res = await e.release();
    expect(res.success).toBe(true);
    expect(m.runs[0]!.signal?.aborted).toBe(true);
    await expect(spoken).resolves.toBeUndefined();
    await until(() => m.session.release.mock.calls.length === 1);
  });

  test.each<Binding>(['bridge', 'unpatched'])(
    '%s binding: stop() leaves the run alone; it completes and nothing plays (as before)',
    async binding => {
      bind(binding);
      const m = session(binding);
      const e = make(m.session);
      const spoken = e.synthesize(TWO);
      await until(() => m.runs.length === 1);
      expect(m.session.run.mock.calls[0]).toHaveLength(
        binding === 'bridge' ? 1 : 2,
      );
      await e.stop();
      await expect(spoken).resolves.toBeUndefined();
      m.finish();
      await tick(20);
      expect(play).not.toHaveBeenCalled();
    },
  );

  test.each<Binding>(['bridge', 'unpatched', 'patched'])(
    '%s binding: a run that fails on its own still fails speak()',
    async binding => {
      bind(binding);
      const m = session(binding);
      const e = make(m.session);
      const spoken = e.synthesize(TWO);
      await until(() => m.runs.length === 1);
      m.fail(new Error('invalid expand shape'));
      await expect(spoken).rejects.toThrow('invalid expand shape');
    },
  );
});
