/**
 * Speech engine dispatch: initialize switches the current engine only
 * after success.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});

jest.mock('../NativeSpeech', () => {
  const store: Record<string, unknown> = {};
  return {
    __esModule: true,
    default: new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'getConstants') return () => ({maxInputLength: 4000});
          if (prop === '__store') return store;
          if (!store[prop]) store[prop] = jest.fn(async () => false);
          return store[prop];
        },
      },
    ),
  };
});

jest.mock('../NativeAudioPlayer', () => ({
  __esModule: true,
  default: {
    playAudio: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    pause: jest.fn(async () => true),
    resume: jest.fn(async () => true),
    isSpeaking: jest.fn(async () => false),
  },
}));

// Stand-ins for the ONNX engines: initialize() fails on demand.
const mockInitFail: Record<string, boolean> = {};
const mockConstructed: string[] = [];
function mockEngineClass(name: string) {
  return class {
    name = name;
    constructor() {
      mockConstructed.push(name);
    }
    initialize = jest.fn(async () => {
      if (mockInitFail[name]) throw new Error(`${name} init failed`);
    });
    isReady = jest.fn(async () => true);
    synthesize = jest.fn(async () => {});
    synthesizeStream = jest.fn();
    getAvailableVoices = jest.fn(async () => []);
    getVoicesWithMetadata = jest.fn(async () => [{id: `${name}-voice`}]);
    setChunkProgressCallback = jest.fn();
    stop = jest.fn(async () => {});
    destroy = jest.fn(async () => {});
    release = jest.fn(async () => ({
      success: true,
      partialRelease: false,
      errors: [],
    }));
  };
}
jest.mock('../engines/kokoro', () => ({
  KokoroEngine: mockEngineClass('kokoro'),
}));
jest.mock('../engines/supertonic', () => ({
  SupertonicEngine: mockEngineClass('supertonic'),
}));
jest.mock('../engines/kitten', () => ({
  KittenEngine: mockEngineClass('kitten'),
}));

import Speech from '../Speech';
import {TTSEngine} from '../types';

beforeEach(() => {
  for (const k of Object.keys(mockInitFail)) delete mockInitFail[k];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Speech.initialize keeps the previous engine on failure', () => {
  it.each([TTSEngine.KOKORO, TTSEngine.SUPERTONIC, TTSEngine.KITTEN])(
    '%s',
    async engine => {
      await Speech.initialize({engine: TTSEngine.OS_NATIVE});
      expect(Speech.getCurrentEngine()).toBe(TTSEngine.OS_NATIVE);
      mockInitFail[engine] = true;
      await expect(Speech.initialize({engine} as any)).rejects.toThrow(
        'init failed',
      );
      expect(Speech.getCurrentEngine()).toBe(TTSEngine.OS_NATIVE);
      // Second attempt takes the reinitialize path; still unchanged.
      await expect(Speech.initialize({engine} as any)).rejects.toThrow(
        'init failed',
      );
      expect(Speech.getCurrentEngine()).toBe(TTSEngine.OS_NATIVE);
      mockInitFail[engine] = false;
      await Speech.initialize({engine} as any);
      expect(Speech.getCurrentEngine()).toBe(engine);
    },
  );

  it('unknown engine throws and keeps the current engine', async () => {
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
    await expect(Speech.initialize({engine: 'nope'} as any)).rejects.toThrow(
      'Unknown engine',
    );
    expect(Speech.getCurrentEngine()).toBe(TTSEngine.OS_NATIVE);
  });
});
