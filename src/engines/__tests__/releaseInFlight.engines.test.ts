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
  release(): Promise<unknown>;
};

/** Inference the test holds open: texts containing `HOLD` never settle until `finish()`. */
type Harness = {
  engine: Engine;
  freed: jest.Mock;
  inferenceStarted(): number;
  finish(): void;
  running(): number;
};

function harness(
  make: (infer: jest.Mock, freed: jest.Mock) => Engine,
): Harness {
  const held: Array<() => void> = [];
  let started = 0;
  let running = 0;
  const infer = jest.fn((text: string) => {
    started++;
    if (!text.includes('HOLD')) return Promise.resolve(AUDIO());
    running++;
    return new Promise(r =>
      held.push(() => {
        running--;
        r(AUDIO());
      }),
    );
  });
  const freed = jest.fn(async () => []);
  return {
    engine: make(infer, freed),
    freed,
    inferenceStarted: () => started,
    finish: () => held.splice(0).forEach(f => f()),
    running: () => running,
  };
}

const ENGINES: Array<[string, (infer: jest.Mock, freed: jest.Mock) => Engine]> =
  [
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
        return e;
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
        return e;
      },
    ],
    [
      'Supertonic',
      (infer, freed) => {
        const e = new SupertonicEngine() as any;
        e.isInitialized = true;
        e.config = {maxChunkSize: 25};
        e.inference = {release: freed};
        e.styleLoader = {
          getVoiceStyle: jest.fn(async () => ({})),
          clear: jest.fn(),
        };
        e.unicodeProcessor = {clear: jest.fn()};
        e.synthesizeChunk = infer;
        return e;
      },
    ],
  ];

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

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

beforeEach(() => {
  pendingPlays.splice(0);
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
      const speak = h.engine.synthesize('Speak HOLD sentence.').catch(() => {});
      await tick();
      expect(h.running()).toBe(1);
      // The stream ends while the speak() inference is still running.
      pendingPlays.splice(0).forEach(r => r());
      await streamDone;

      expect(await releaseRace(h)).toEqual({freedWhileInferring: false});
      expect(h.freed).toHaveBeenCalledTimes(1);
      await speak;
    });

    test("a speak()'s prefetched next chunk, abandoned when release() stops playback", async () => {
      const h = harness(make);
      const speak = h.engine
        .synthesize('First sentence here. Second HOLD sentence here.')
        .catch(() => {});
      await tick();
      expect(h.inferenceStarted()).toBe(2);
      expect(h.running()).toBe(1);

      expect(await releaseRace(h)).toEqual({freedWhileInferring: false});
      expect(h.freed).toHaveBeenCalledTimes(1);
      await speak;
    });

    test('a speak() inference abandoned by stop()', async () => {
      const h = harness(make);
      const speak = h.engine.synthesize('Speak HOLD sentence.').catch(() => {});
      await tick();
      expect(h.running()).toBe(1);
      await h.engine.stop();
      await speak;

      expect(await releaseRace(h)).toEqual({freedWhileInferring: false});
      expect(h.freed).toHaveBeenCalledTimes(1);
    });

    test('a stream chunk inference when release() cancels the stream', async () => {
      const h = harness(make);
      const stream = h.engine.synthesizeStream({stripMarkdown: false});
      stream.append('Stream HOLD sentence here. ');
      const streamDone = stream.finalize().catch(() => {});
      await tick();
      expect(h.running()).toBe(1);

      expect(await releaseRace(h)).toEqual({freedWhileInferring: false});
      expect(h.freed).toHaveBeenCalledTimes(1);
      await streamDone;
    });
  },
);
