/**
 * `ducking` / `silentMode` given to Speech.initialize() apply to every
 * engine's speak() and createSpeechStream(), a call's own value wins, and
 * the defaults belong to the engine they were given with (#151).
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});
jest.mock('../phonemization', () => ({loadNativeDict: jest.fn()}));

jest.mock('../NativeSpeech', () => {
  const store: Record<string, unknown> = {};
  return {
    __esModule: true,
    default: new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'getConstants') return () => ({maxInputLength: 4000});
          if (prop === 'onStart' || prop === 'onFinish' || prop === 'onStopped')
            return () => ({remove: () => {}});
          if (!store[prop]) store[prop] = jest.fn(async () => 1);
          return store[prop];
        },
      },
    ),
  };
});

/** Native neural playAudio configs, in call order. */
const mockPlayConfigs: Array<Record<string, unknown>> = [];
jest.mock('../NativeAudioPlayer', () => ({
  __esModule: true,
  default: {
    playAudio: jest.fn(
      async (_b64: string, config: Record<string, unknown>) => {
        mockPlayConfigs.push(config);
      },
    ),
    endUtterance: jest.fn(async () => {}),
    endHeldPause: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    pause: jest.fn(async () => true),
    resume: jest.fn(async () => true),
    isSpeaking: jest.fn(async () => false),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

import Speech from '../Speech';
import {KittenEngine} from '../engines/kitten/KittenEngine';
import {KokoroEngine} from '../engines/kokoro/KokoroEngine';
import {SupertonicEngine} from '../engines/supertonic/SupertonicEngine';
import type {SynthesisOptions} from '../types';

const AUDIO = {
  samples: new Float32Array(240).fill(0.1),
  sampleRate: 24000,
  channels: 1,
  duration: 0.01,
};

// Real engine classes; initialize() only sets the state a synthesis needs.
jest
  .spyOn(KittenEngine.prototype, 'initialize')
  .mockImplementation(async function (this: any) {
    this.isInitialized = true;
    this.session = {};
    this.config = {maxChunkSize: 70};
    this.synthesizeTextChunk = jest.fn(async () => AUDIO);
  });
jest
  .spyOn(KokoroEngine.prototype, 'initialize')
  .mockImplementation(async function (this: any) {
    this.isInitialized = true;
    this.session = {};
    this.config = {maxChunkSize: 70};
    this.synthesizeTextChunk = jest.fn(async () => AUDIO);
  });
jest
  .spyOn(SupertonicEngine.prototype, 'initialize')
  .mockImplementation(async function (this: any) {
    this.isInitialized = true;
    this.config = {maxChunkSize: 70};
    this.styleLoader = {getVoiceStyle: jest.fn(async () => ({}))};
    this.synthesizeChunk = jest.fn(async () => AUDIO);
  });
for (const cls of [KittenEngine, KokoroEngine, SupertonicEngine]) {
  jest.spyOn(cls.prototype, 'destroy').mockImplementation(async () => {});
}

/** An add-on engine: records the options of every call it gets. */
class MockAddon {
  calls: Array<{via: string; options?: SynthesisOptions}> = [];
  constructor(
    readonly name: string,
    streaming: boolean,
  ) {
    if (!streaming) {
      (this as any).synthesizeStream = undefined;
    }
  }
  async initialize() {}
  async isReady() {
    return true;
  }
  async synthesize(_text: string, options?: SynthesisOptions) {
    this.calls.push({via: 'synthesize', options});
    return AUDIO;
  }
  synthesizeStream(options?: SynthesisOptions) {
    this.calls.push({via: 'stream', options});
    return {
      append: () => {},
      finalize: async () => {},
      cancel: async () => {},
    };
  }
  async getAvailableVoices() {
    return [];
  }
  async stop() {}
  async destroy() {}
}
const addon = new MockAddon('mock-addon', true);
const batchAddon = new MockAddon('mock-batch-addon', false);
Speech.registerEngine(addon as any);
Speech.registerEngine(batchAddon as any);

const TEXT =
  'The river ran past the old mill. The children used to play there.';

const audioOf = (c?: Record<string, unknown> | SynthesisOptions) => ({
  ducking: c?.ducking,
  silentMode: c?.silentMode,
});

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  mockPlayConfigs.length = 0;
  addon.calls.length = 0;
  batchAddon.calls.length = 0;
});

afterEach(async () => {
  await Speech.stop();
});

const NEURAL = ['kitten', 'kokoro', 'supertonic'] as const;
const DEFAULTS = {ducking: true, silentMode: 'ignore'} as const;

describe.each(NEURAL)('%s: init defaults', engine => {
  test('speak() with no options plays with the init defaults', async () => {
    await Speech.initialize({engine, ...DEFAULTS} as any);
    await Speech.speak(TEXT);
    expect(mockPlayConfigs.length).toBeGreaterThan(0);
    mockPlayConfigs.forEach(c => expect(audioOf(c)).toEqual(DEFAULTS));
  });

  test('createSpeechStream() with no options plays with the init defaults', async () => {
    await Speech.initialize({engine, ...DEFAULTS} as any);
    const stream = Speech.createSpeechStream();
    stream.append(TEXT);
    await stream.finalize();
    expect(mockPlayConfigs.length).toBeGreaterThan(0);
    mockPlayConfigs.forEach(c => expect(audioOf(c)).toEqual(DEFAULTS));
  });

  test("a call's own values win", async () => {
    await Speech.initialize({engine, ...DEFAULTS} as any);
    await Speech.speak(TEXT, undefined, {ducking: false, silentMode: 'obey'});
    const stream = Speech.createSpeechStream(undefined, {
      ducking: false,
      silentMode: 'obey',
    });
    stream.append(TEXT);
    await stream.finalize();
    expect(mockPlayConfigs.length).toBeGreaterThan(1);
    mockPlayConfigs.forEach(c =>
      expect(audioOf(c)).toEqual({ducking: false, silentMode: 'obey'}),
    );
  });

  test('a call that sets only one value keeps the other default', async () => {
    await Speech.initialize({engine, ...DEFAULTS} as any);
    await Speech.speak(TEXT, undefined, {ducking: false});
    mockPlayConfigs.forEach(c =>
      expect(audioOf(c)).toEqual({ducking: false, silentMode: 'ignore'}),
    );
  });
});

describe('add-on engines get the init defaults with no change', () => {
  test('speak() and a stream on an add-on with synthesizeStream', async () => {
    await Speech.initialize({engine: 'mock-addon', ...DEFAULTS} as any);
    await Speech.speak(TEXT);
    const stream = Speech.createSpeechStream('v1');
    stream.append(TEXT);
    await stream.finalize();
    expect(addon.calls.map(c => c.via)).toEqual(['synthesize', 'stream']);
    addon.calls.forEach(c => expect(audioOf(c.options)).toEqual(DEFAULTS));
  });

  test('a stream on an add-on without synthesizeStream (batched speak)', async () => {
    await Speech.initialize({engine: 'mock-batch-addon', ...DEFAULTS} as any);
    const stream = Speech.createSpeechStream();
    stream.append(TEXT);
    await stream.finalize();
    expect(batchAddon.calls.length).toBeGreaterThan(0);
    batchAddon.calls.forEach(c => {
      expect(c.via).toBe('synthesize');
      expect(audioOf(c.options)).toEqual(DEFAULTS);
    });
  });

  test("a call's own values win", async () => {
    await Speech.initialize({engine: 'mock-addon', ...DEFAULTS} as any);
    await Speech.speak(TEXT, undefined, {ducking: false});
    expect(audioOf(addon.calls[0]!.options)).toEqual({
      ducking: false,
      silentMode: 'ignore',
    });
  });
});

describe('defaults belong to the engine they were given with', () => {
  test("initialize(A, defaults) then initialize(B) without: B gets none of A's", async () => {
    await Speech.initialize({engine: 'kitten', ...DEFAULTS} as any);
    await Speech.initialize({engine: 'mock-addon'} as any);
    await Speech.speak(TEXT);
    expect(audioOf(addon.calls[0]!.options)).toEqual({
      ducking: undefined,
      silentMode: undefined,
    });
  });

  test('the last initialize() of an engine wins', async () => {
    await Speech.initialize({engine: 'kokoro', ...DEFAULTS} as any);
    await Speech.initialize({engine: 'kokoro'} as any);
    await Speech.speak(TEXT);
    expect(mockPlayConfigs.length).toBeGreaterThan(0);
    mockPlayConfigs.forEach(c =>
      expect(audioOf(c)).toEqual({ducking: undefined, silentMode: undefined}),
    );
  });

  test('neural init defaults do not reach the OS engine', async () => {
    await Speech.initialize({engine: 'supertonic', ...DEFAULTS} as any);
    await Speech.initialize({engine: 'os-native'} as any);
    const native = (await import('../NativeSpeech')).default as any;
    native.speakWithOptions.mockClear();
    native.speak.mockClear();
    await Speech.speak('Hello there.');
    const call = native.speakWithOptions.mock.calls[0];
    expect(audioOf(call?.[1])).toEqual({
      ducking: undefined,
      silentMode: undefined,
    });
  });
});
