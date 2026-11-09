/**
 * release() frees the ONNX session(s) only after every inference the
 * engine started has settled: whichever call started it (speak, stream,
 * a pipelined next chunk) and however that call ended (finished,
 * stopped, abandoned by a stop race). Inference here is a promise the
 * test settles by hand, so "freed while inferring" is observable.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});

const pendingPlays: Array<() => void> = [];
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    // Playback lasts until stop(), like a long reply still speaking.
    play: jest.fn(() => new Promise<void>(r => pendingPlays.push(r))),
    stop: jest.fn(async () => {
      pendingPlays.splice(0).forEach(r => r());
    }),
  },
}));
jest.mock('../../phonemization', () => ({
  loadNativeDict: jest.fn(),
  TextPreprocessor: class {
    process(t: string) {
      return t;
    }
  },
}));

import {KokoroEngine} from '../kokoro/KokoroEngine';
import {KittenEngine} from '../kitten/KittenEngine';
import {SupertonicEngine} from '../supertonic/SupertonicEngine';

const AUDIO = () => ({
  samples: new Float32Array(240).fill(0.1),
  sampleRate: 24000,
  channels: 1,
  duration: 0.01,
});

type Handle = {
  append(t: string): void;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
};
type Engine = {
  synthesize(text: string): Promise<unknown>;
  synthesizeStream(opts?: object): Handle;
  stop(): Promise<void>;
  release(): Promise<{success: boolean; errors: Array<{component: string}>}>;
};

/** How each engine holds its model, so a test can see it detached or swap in a new one. */
type Model = {
  /** Whether release() has taken the model away from the engine. */
  detached(): boolean;
  /** What a re-initialize does: give the engine a new model. */
  attach(freed: jest.Mock): void;
  /** The component release() reports a failed free under. */
  component: string;
};

type Harness = {
  engine: Engine;
  model: Model;
  freed: jest.Mock;
  inferenceStarted(): number;
  /** Settles held inferences, the way the real unit then ends (see `make`). */
  finish(): void;
  running(): number;
};

/**
 * Texts containing `HOLD` stay inferring until `finish()`. Kitten and
 * Kokoro read the session after phonemizing, so a unit that ends after
 * release() detached it fails with "session not initialized"; the
 * Supertonic unit keeps the pipeline it started with.
 */
function harness(make: Make): Harness {
  const held: Array<() => void> = [];
  let started = 0;
  let running = 0;
  let model!: Model;
  let failsWhenDetached = false;
  const infer = jest.fn((text: string) => {
    started++;
    if (!text.includes('HOLD')) return Promise.resolve(AUDIO());
    running++;
    return new Promise((resolve, reject) =>
      held.push(() => {
        running--;
        if (failsWhenDetached && model.detached()) {
          reject(new Error('session not initialized'));
        } else {
          resolve(AUDIO());
        }
      }),
    );
  });
  const freed = jest.fn(async () => []);
  const built = make(infer, freed);
  model = built.model;
  failsWhenDetached = built.failsWhenDetached;
  return {
    engine: built.engine,
    model,
    freed,
    inferenceStarted: () => started,
    finish: () => held.splice(0).forEach(f => f()),
    running: () => running,
  };
}

type Make = (
  infer: jest.Mock,
  freed: jest.Mock,
) => {engine: Engine; model: Model; failsWhenDetached: boolean};

const ENGINES: Array<[string, Make]> = [
  [
    'Kokoro',
    (infer, freed) => {
      const e = new KokoroEngine() as any;
      e.isInitialized = true;
      e.config = {maxChunkSize: 25};
      e.session = {release: freed};
      e.voiceLoader = {clear: jest.fn()};
      e.tokenizer = {clear: jest.fn()};
      e.synthesizeTextChunk = infer;
      return {
        engine: e,
        failsWhenDetached: true,
        model: {
          detached: () => e.session === null,
          attach: f => (e.session = {release: f}),
          component: 'session',
        },
      };
    },
  ],
  [
    'Kitten',
    (infer, freed) => {
      const e = new KittenEngine() as any;
      e.isInitialized = true;
      e.config = {maxChunkSize: 25};
      e.session = {release: freed};
      e.voiceLoader = {clear: jest.fn()};
      e.tokenizer = {clear: jest.fn()};
      e.synthesizeTextChunk = infer;
      return {
        engine: e,
        failsWhenDetached: true,
        model: {
          detached: () => e.session === null,
          attach: f => (e.session = {release: f}),
          component: 'session',
        },
      };
    },
  ],
  [
    'Supertonic',
    (infer, freed) => {
      const e = new SupertonicEngine() as any;
      const original = {release: freed};
      e.isInitialized = true;
      e.config = {maxChunkSize: 25};
      e.inference = original;
      e.styleLoader = {
        getVoiceStyle: jest.fn(async () => ({})),
        clear: jest.fn(),
      };
      e.unicodeProcessor = {clear: jest.fn()};
      e.synthesizeChunk = infer;
      return {
        engine: e,
        failsWhenDetached: false,
        model: {
          detached: () => e.inference !== original,
          attach: f => (e.inference = {release: f}),
          component: 'inference',
        },
      };
    },
  ],
];

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

const outcome = (p: Promise<unknown>) =>
  p.then(
    v => ({resolved: v}),
    e => ({rejected: String(e)}),
  );

/** Starts release(), lets it run, and reports whether it freed the session while inference was running. */
async function releaseRace(
  h: Harness,
): Promise<{freedWhileInferring: boolean}> {
  const rel = h.engine.release();
  await tick(100);
  const freedWhileInferring = h.freed.mock.calls.length > 0 && h.running() > 0;
  h.finish();
  await rel;
  return {freedWhileInferring};
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeAll(() => process.on('unhandledRejection', onUnhandled));
afterAll(() => process.off('unhandledRejection', onUnhandled));

beforeEach(() => {
  pendingPlays.splice(0);
  unhandled.splice(0);
});

afterEach(async () => {
  // An abandoned inference that fails late must not surface as an
  // unhandled rejection.
  await tick();
  expect(unhandled).toEqual([]);
});

describe.each(ENGINES)(
  '%s: release() waits for every inference',
  (_n, make) => {
    test('a speak() still inferring after an overlapping stream finished (#59)', async () => {
      const h = harness(make);
      const stream = h.engine.synthesizeStream({stripMarkdown: false});
      stream.append('Stream sentence here. ');
      const streamDone = stream.finalize();
      await tick();
      const speak = outcome(h.engine.synthesize('Speak HOLD sentence.'));
      await tick();
      expect(h.running()).toBe(1);
      // The stream ends while the speak() inference is still running.
      pendingPlays.splice(0).forEach(r => r());
      await streamDone;

      expect(await releaseRace(h)).toEqual({freedWhileInferring: false});
      expect(h.freed).toHaveBeenCalledTimes(1);
      // Released mid-inference, speak() ends quietly, as it does on stop().
      expect(await speak).toEqual({resolved: undefined});
    });

    test("a speak()'s prefetched next chunk, abandoned when release() stops playback", async () => {
      const h = harness(make);
      const speak = outcome(
        h.engine.synthesize('First sentence here. Second HOLD sentence here.'),
      );
      await tick();
      expect(h.inferenceStarted()).toBe(2);
      expect(h.running()).toBe(1);

      expect(await releaseRace(h)).toEqual({freedWhileInferring: false});
      expect(h.freed).toHaveBeenCalledTimes(1);
      expect(await speak).toEqual({resolved: undefined});
    });

    test('a speak() inference abandoned by stop()', async () => {
      const h = harness(make);
      const speak = outcome(h.engine.synthesize('Speak HOLD sentence.'));
      await tick();
      expect(h.running()).toBe(1);
      await h.engine.stop();
      expect(await speak).toEqual({resolved: undefined});

      expect(await releaseRace(h)).toEqual({freedWhileInferring: false});
      expect(h.freed).toHaveBeenCalledTimes(1);
    });

    test('a stream chunk inference when release() cancels the stream', async () => {
      const h = harness(make);
      const stream = h.engine.synthesizeStream({stripMarkdown: false});
      stream.append('Stream HOLD sentence here. ');
      const streamDone = outcome(stream.finalize());
      await tick();
      expect(h.running()).toBe(1);

      expect(await releaseRace(h)).toEqual({freedWhileInferring: false});
      expect(h.freed).toHaveBeenCalledTimes(1);
      expect(await streamDone).toEqual({resolved: undefined});
    });

    test('a model attached while release() waits (re-initialize) is not the one it frees', async () => {
      const h = harness(make);
      const speak = outcome(h.engine.synthesize('Speak HOLD sentence.'));
      await tick();
      const rel = h.engine.release();
      await tick();
      // Detached at once, so nothing new can start on the model being freed.
      expect(h.model.detached()).toBe(true);
      expect(h.freed).not.toHaveBeenCalled();
      const freedNew = jest.fn(async () => []);
      h.model.attach(freedNew);

      h.finish();
      await rel;
      await speak;
      expect(h.freed).toHaveBeenCalledTimes(1);
      expect(freedNew).not.toHaveBeenCalled();
    });

    test('stop() then release() (an engine switch) does not wait for the abandoned inference', async () => {
      const h = harness(make);
      const speak = outcome(h.engine.synthesize('Speak HOLD sentence.'));
      await tick();
      await h.engine.stop();
      const released = await Promise.race([
        h.engine.release().then(() => 'resolved'),
        tick(50).then(() => 'pending'),
      ]);
      expect(released).toBe('resolved');
      expect(h.running()).toBe(1);
      expect(h.freed).not.toHaveBeenCalled();

      h.finish();
      await tick();
      expect(h.freed).toHaveBeenCalledTimes(1);
      await speak;
    });

    test('with nothing in flight, release() frees at once', async () => {
      const h = harness(make);
      const t0 = Date.now();
      const result = await h.engine.release();
      expect(Date.now() - t0).toBeLessThan(100);
      expect(h.freed).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    test('a free that fails is reported in the release result', async () => {
      const h = harness(make);
      h.freed.mockRejectedValueOnce(new Error('boom'));
      const result = await h.engine.release();
      expect(result.success).toBe(false);
      expect(result.errors.map(e => e.component)).toContain(h.model.component);
    });
  },
);

/**
 * Below the stubbed unit: a chunk still preparing its inputs (voice
 * embedding) when release() detaches the session ends quietly with an
 * empty buffer, rather than failing and logging "session not initialized".
 */
describe.each([
  ['Kokoro', () => new KokoroEngine() as any, 'getVoiceEmbedding'],
  ['Kitten', () => new KittenEngine() as any, 'getStyleEmbedding'],
] as const)(
  '%s: a chunk preparing when release() runs',
  (_n, create, embed) => {
    test('ends empty without touching the session or logging an error', async () => {
      const e = create();
      const run = jest.fn();
      let embedded!: (v: Float32Array) => void;
      e.isInitialized = true;
      e.session = {run, release: jest.fn(async () => {})};
      e.tokenizer = {clear: jest.fn()};
      e.voiceLoader = {
        clear: jest.fn(),
        [embed]: jest.fn(() => new Promise(r => (embedded = r))),
      };
      const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const chunk = e.inflight.track(e.synthesizeChunk([1, 2, 3], 'v', 3));
        await tick();
        await e.release();
        embedded(new Float32Array(4));
        const audio = await chunk;
        expect(audio.samples.length).toBe(0);
        expect(run).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
  },
);
