/**
 * release() awaits the player stop and, with nothing inferring, the
 * native session free. An initialize() that runs during those awaits
 * (Speech.initialize → destroy() + initialize()) is newer than the
 * release: release must not undo it (#62).
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    play: jest.fn(() => new Promise<void>(() => {})),
    stop: jest.fn(async () => {}),
  },
}));
jest.mock('../../phonemization', () => ({
  loadNativeDict: jest.fn(async () => ({})),
}));

import {KokoroEngine} from '../kokoro/KokoroEngine';
import {KittenEngine} from '../kitten/KittenEngine';
import {SupertonicEngine} from '../supertonic/SupertonicEngine';
import {SupertonicInference} from '../supertonic/SupertonicInference';

type Engine = {
  release(): Promise<{success: boolean}>;
  destroy(): Promise<void>;
  initialize(config: object): Promise<void>;
  getStatus(): {isReady: boolean; isLoading: boolean; error: string | null};
};

type Built = {
  engine: Engine;
  config: object;
  /** Whether what the last initialize() loaded is still there. */
  loaded(): boolean;
};

/** A loader whose clear() drops what load() put there. */
function loader() {
  let has = false;
  return {
    load: () => (has = true),
    clear: jest.fn(() => (has = false)),
    has: () => has,
  };
}

const ENGINES: Array<[string, (free: jest.Mock) => Built]> = [
  [
    'Kokoro',
    free => {
      const e = new KokoroEngine() as any;
      const voices = loader();
      const tok = loader();
      e.isInitialized = true;
      e.config = {maxChunkSize: 25};
      e.session = {release: free};
      e.voiceLoader = {clear: voices.clear};
      e.tokenizer = {clear: tok.clear};
      e.loadTokenizerFromHF = jest.fn(async () => tok.load());
      e.loadVoices = jest.fn(async () => voices.load());
      e.loadModel = jest.fn(async () => (e.session = {release: jest.fn()}));
      return {
        engine: e,
        config: {dictPath: 'd', tokenizerPath: 't', voicesPath: 'v'},
        loaded: () => voices.has() && tok.has() && e.session !== null,
      };
    },
  ],
  [
    'Kitten',
    free => {
      const e = new KittenEngine() as any;
      const voices = loader();
      const tok = loader();
      e.isInitialized = true;
      e.config = {maxChunkSize: 25};
      e.session = {release: free};
      e.voiceLoader = {clear: voices.clear};
      e.tokenizer = {clear: tok.clear};
      e.loadTokenizer = jest.fn(async () => tok.load());
      e.loadVoices = jest.fn(async () => voices.load());
      e.loadModel = jest.fn(async () => (e.session = {release: jest.fn()}));
      return {
        engine: e,
        config: {dictPath: 'd', tokenizerPath: 't', voicesPath: 'v'},
        loaded: () => voices.has() && tok.has() && e.session !== null,
      };
    },
  ],
  [
    'Supertonic',
    free => {
      const e = new SupertonicEngine() as any;
      const styles = loader();
      const uni = loader();
      e.isInitialized = true;
      e.config = {maxChunkSize: 25};
      e.inference = {
        release: free,
        destroy: jest.fn(async () => {}),
        setUnicodeProcessor: jest.fn(),
        initialize: jest.fn(async () => {}),
      };
      e.styleLoader = {
        getVoiceStyle: jest.fn(async () => ({})),
        clear: styles.clear,
      };
      e.unicodeProcessor = {
        initialize: jest.fn(async () => uni.load()),
        clear: uni.clear,
      };
      e.loadVoices = jest.fn(async () => styles.load());
      return {
        engine: e,
        config: {voicesPath: 'v', unicodeIndexerPath: 'u'},
        loaded: () => styles.has() && uni.has(),
      };
    },
  ],
];

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  jest
    .spyOn(SupertonicInference.prototype, 'initialize')
    .mockResolvedValue(undefined as never);
  jest
    .spyOn(SupertonicInference.prototype, 'destroy')
    .mockResolvedValue(undefined as never);
});
afterEach(() => jest.restoreAllMocks());

/** A session free that takes until `done()`, like a native free. */
function slowFree() {
  let done!: () => void;
  const free = jest.fn(
    () =>
      new Promise<[]>(resolve => {
        done = () => resolve([]);
      }),
  );
  return {free, done: () => done()};
}

describe.each(ENGINES)(
  '%s: release() vs a newer initialize() (#62)',
  (_n, make) => {
    test('an initialize() that finishes while release() frees the session stays', async () => {
      const {free, done} = slowFree();
      const {engine, config, loaded} = make(free);

      const rel = engine.release();
      await tick();
      expect(free).toHaveBeenCalledTimes(1);
      await engine.destroy();
      await engine.initialize(config);
      expect(loaded()).toBe(true);

      done();
      await rel;

      expect(engine.getStatus()).toEqual({
        isReady: true,
        isLoading: false,
        error: null,
      });
      expect((engine as any).config).toBe(config);
      expect(loaded()).toBe(true);
    });

    test('an initialize() still loading when release() ends is not undone', async () => {
      const {free, done} = slowFree();
      const {engine, config, loaded} = make(free);
      let resume!: () => void;
      const gate = new Promise<void>(r => (resume = r));
      const e = engine as any;
      const loadVoices = e.loadVoices;
      e.loadVoices = jest.fn(async (p: string) => {
        await gate;
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
      resume();
      await init;

      expect(engine.getStatus().isReady).toBe(true);
      expect(e.config).toBe(config);
      expect(loaded()).toBe(true);
    });

    test('without a newer initialize(), release() still clears everything', async () => {
      const {free, done} = slowFree();
      const {engine, config, loaded} = make(free);
      await engine.destroy();
      await engine.initialize(config);
      const e = engine as any;
      if (e.session) e.session = {release: free};

      const rel = engine.release();
      await tick();
      done();
      expect((await rel).success).toBe(true);

      expect(engine.getStatus().isReady).toBe(false);
      expect(e.config).toBeNull();
      expect(loaded()).toBe(false);
    });
  },
);
