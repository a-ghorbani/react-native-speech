/**
 * release() awaits the player stop and, with nothing inferring, the
 * native session free. An initialize() that runs during either await
 * (Speech.initialize → destroy() + initialize()) is newer than the
 * release: release must neither free what it loaded nor reset the engine
 * (#62).
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});

/** While set, the player's stop() waits for it. */
const mockStop: {gate: Promise<void> | null} = {gate: null};
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    play: jest.fn(() => new Promise<void>(() => {})),
    stop: jest.fn(async () => {
      await mockStop.gate;
    }),
  },
}));
jest.mock('../../phonemization', () => ({
  loadNativeDict: jest.fn(async () => ({})),
}));

import {KokoroEngine} from '../kokoro/KokoroEngine';
import {KittenEngine} from '../kitten/KittenEngine';
import {SupertonicEngine} from '../supertonic/SupertonicEngine';
import {SupertonicInference} from '../supertonic/SupertonicInference';

const {neuralAudioPlayer} = require('../NeuralAudioPlayer') as {
  neuralAudioPlayer: {play: jest.Mock; stop: jest.Mock};
};

type Engine = {
  release(): Promise<{success: boolean}>;
  destroy(): Promise<void>;
  initialize(config: object): Promise<void>;
  getStatus(): {isReady: boolean; isLoading: boolean; error: string | null};
  synthesizeStream(): {append(t: string): void; finalize(): Promise<void>};
};

/** A model (ONNX session or Supertonic pipeline) and whether it was freed. */
type Model = {loaded: boolean; freed: boolean};

type Built = {
  engine: Engine;
  config: object;
  /** The model release() starts with. */
  first: Model;
  /** The model the engine holds now, or null. */
  current(): Model | null;
  /** Whether the loaders the last initialize() filled are still filled. */
  loadersFilled(): boolean;
};

/** While set, a model's free waits for it. */
let freeGate: Promise<void> | null = null;
const model = (): Model & {release: jest.Mock} => {
  const m: any = {loaded: true, freed: false};
  m.release = jest.fn(async () => {
    await freeGate;
    m.freed = true;
    return [];
  });
  return m;
};

const AUDIO = () => ({
  samples: new Float32Array(240).fill(0.1),
  sampleRate: 24000,
  channels: 1,
  duration: 0.01,
});

/** A loader whose clear() drops what load() put there. */
function loader() {
  let has = false;
  return {
    load: () => (has = true),
    clear: jest.fn(() => (has = false)),
    has: () => has,
  };
}

function sessionEngine(e: any, loadTokenizer: string): Built {
  const voices = loader();
  const tok = loader();
  const first = model();
  e.isInitialized = true;
  e.config = {maxChunkSize: 25};
  e.session = first;
  e.voiceLoader = {clear: voices.clear};
  e.tokenizer = {clear: tok.clear};
  e[loadTokenizer] = jest.fn(async () => tok.load());
  e.loadVoices = jest.fn(async () => voices.load());
  e.loadModel = jest.fn(async () => (e.session = model()));
  e.synthesizeTextChunk = jest.fn(async () => AUDIO());
  return {
    engine: e,
    config: {dictPath: 'd', tokenizerPath: 't', voicesPath: 'v'},
    first,
    current: () => e.session,
    loadersFilled: () => voices.has() && tok.has(),
  };
}

const ENGINES: Array<[string, () => Built]> = [
  ['Kokoro', () => sessionEngine(new KokoroEngine(), 'loadTokenizerFromHF')],
  ['Kitten', () => sessionEngine(new KittenEngine(), 'loadTokenizer')],
  [
    'Supertonic',
    () => {
      const e = new SupertonicEngine() as any;
      const styles = loader();
      const uni = loader();
      const first = Object.assign(model(), {
        destroy: jest.fn(async () => {}),
        setUnicodeProcessor: jest.fn(),
        initialize: jest.fn(async () => {}),
      });
      e.isInitialized = true;
      e.config = {maxChunkSize: 25};
      e.inference = first;
      e.styleLoader = {
        getVoiceStyle: jest.fn(async () => ({})),
        clear: styles.clear,
      };
      e.synthesizeChunk = jest.fn(async () => AUDIO());
      e.unicodeProcessor = {
        initialize: jest.fn(async () => uni.load()),
        clear: uni.clear,
      };
      e.loadVoices = jest.fn(async () => styles.load());
      return {
        engine: e,
        config: {voicesPath: 'v', unicodeIndexerPath: 'u'},
        first,
        current: () => e.inference,
        loadersFilled: () => styles.has() && uni.has(),
      };
    },
  ],
];

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

function gate() {
  let open!: () => void;
  const p = new Promise<void>(r => (open = r));
  return {p, open: () => open()};
}

beforeEach(() => {
  // The pipeline release() puts in place is empty until initialize() loads it.
  jest
    .spyOn(SupertonicInference.prototype, 'initialize')
    .mockImplementation(async function (this: any) {
      this.loaded = true;
    });
  jest
    .spyOn(SupertonicInference.prototype, 'release')
    .mockImplementation(async function (this: any) {
      await freeGate;
      this.freed = true;
      return [];
    });
  jest
    .spyOn(SupertonicInference.prototype, 'destroy')
    .mockResolvedValue(undefined as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  neuralAudioPlayer.play.mockClear();
  mockStop.gate = null;
  freeGate = null;
});

const WINDOWS = ['stream cancel', 'player stop', 'session free'] as const;

/** Holds release() at the given await; returns what lets it go on. */
async function openWindow(
  w: (typeof WINDOWS)[number],
  engine: Engine,
): Promise<() => void> {
  const g = gate();
  if (w === 'stream cancel') {
    // A stream is playing: release() first awaits its cancel, whose
    // player stop is held.
    const s = engine.synthesizeStream();
    s.append('A stream is playing here. ');
    s.finalize().catch(() => {});
    while (neuralAudioPlayer.play.mock.calls.length === 0) await tick(5);
    mockStop.gate = g.p;
  } else if (w === 'player stop') mockStop.gate = g.p;
  else freeGate = g.p;
  return g.open;
}

describe.each(ENGINES)(
  '%s: release() vs a newer initialize() (#62)',
  (_n, make) => {
    test.each(WINDOWS)(
      'an initialize() that finishes during the %s stays, with its model',
      async w => {
        const {engine, config, first, current, loadersFilled} = make();
        const done = await openWindow(w, engine);

        const rel = engine.release();
        await tick();
        await engine.destroy();
        await engine.initialize(config);
        const loaded = current();

        done();
        await rel;
        await tick();

        expect(engine.getStatus()).toEqual({
          isReady: true,
          isLoading: false,
          error: null,
        });
        expect((engine as any).config).toBe(config);
        expect(loadersFilled()).toBe(true);
        expect(current()).toBe(loaded);
        expect(current()).not.toBe(first);
        expect(current()).toMatchObject({loaded: true});
        expect((current() as Model).freed).toBeFalsy();
        expect(first.freed).toBe(true);
      },
    );

    test.each(WINDOWS)(
      'an initialize() still loading when the %s ends is not undone',
      async w => {
        const {engine, config, first, current, loadersFilled} = make();
        const done = await openWindow(w, engine);
        const e = engine as any;
        const voices = gate();
        const loadVoices = e.loadVoices;
        e.loadVoices = jest.fn(async (p: string) => {
          await voices.p;
          return loadVoices(p);
        });

        const rel = engine.release();
        await tick();
        await engine.destroy();
        const init = engine.initialize(config);
        await tick();
        expect(engine.getStatus().isLoading).toBe(true);

        done();
        await rel;
        voices.open();
        await init;
        await tick();

        expect(engine.getStatus().isReady).toBe(true);
        expect(e.config).toBe(config);
        expect(loadersFilled()).toBe(true);
        expect(current()).not.toBe(first);
        expect(current()).toMatchObject({loaded: true});
        expect((current() as Model).freed).toBeFalsy();
        expect(first.freed).toBe(true);
      },
    );

    test('without a newer initialize(), release() frees and clears everything', async () => {
      const {engine, config, current, loadersFilled} = make();
      await engine.destroy();
      await engine.initialize(config);
      const loaded = current()!;

      expect((await engine.release()).success).toBe(true);

      expect(engine.getStatus().isReady).toBe(false);
      expect((engine as any).config).toBeNull();
      expect(loadersFilled()).toBe(false);
      expect(loaded.freed).toBe(true);
    });
  },
);
