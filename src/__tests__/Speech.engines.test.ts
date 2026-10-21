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
import {neuralAudioPlayer} from '../engines/NeuralAudioPlayer';
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

function fakeEngine<T extends object = {}>(name: string, overrides?: T) {
  const base = {
    name,
    initialize: jest.fn(async () => {}),
    isReady: jest.fn(async () => true),
    synthesize: jest.fn(async () => {}),
    synthesizeStream: jest.fn(() => ({
      append: jest.fn(),
      finalize: jest.fn(async () => {}),
      cancel: jest.fn(async () => {}),
    })),
    getAvailableVoices: jest.fn(async () => ['v1']),
    getVoicesWithMetadata: jest.fn(async () => [{id: 'v1'}]),
    setChunkProgressCallback: jest.fn(),
    stop: jest.fn(async () => {}),
    destroy: jest.fn(async () => {}),
    release: jest.fn(async () => ({
      success: true,
      partialRelease: false,
      errors: [{component: name, error: new Error('x')}],
    })),
  };
  return {...base, ...overrides} as typeof base & T;
}

const mockTurbo = (require('../NativeSpeech').default as any).__store as Record<
  string,
  jest.Mock
>;
const turboPause = () =>
  (require('../NativeSpeech').default as any).pause as jest.Mock;
const nativePlayer = require('../NativeAudioPlayer').default as Record<
  string,
  jest.Mock
>;

describe('Speech.registerEngine', () => {
  it('rejects built-in ids and empty names', () => {
    for (const id of Object.values(TTSEngine)) {
      expect(() => Speech.registerEngine(fakeEngine(id) as any)).toThrow(
        'reserved',
      );
    }
    expect(() => Speech.registerEngine(fakeEngine('') as any)).toThrow(
      'non-empty',
    );
  });

  it('is idempotent for the same instance and refuses to replace an initialized one', async () => {
    const first = fakeEngine('dup');
    Speech.registerEngine(first as any);
    Speech.registerEngine(first as any);
    // Not initialized yet: a new instance may replace it.
    const second = fakeEngine('dup');
    Speech.registerEngine(second as any);
    await Speech.initialize({engine: 'dup'} as any);
    expect(first.initialize).not.toHaveBeenCalled();
    expect(second.initialize).toHaveBeenCalledTimes(1);
    expect(() => Speech.registerEngine(fakeEngine('dup') as any)).toThrow(
      'already registered and initialized',
    );
    Speech.registerEngine(second as any);
  });
});

describe('overlapping Speech.initialize calls', () => {
  it('the latest call wins even when an earlier one resolves later', async () => {
    let finishSlow!: () => void;
    const slow = fakeEngine('slow-init', {
      initialize: jest.fn(() => new Promise<void>(r => (finishSlow = r))),
    });
    Speech.registerEngine(slow as any);
    const first = Speech.initialize({engine: 'slow-init'} as any);
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
    expect(Speech.getCurrentEngineId()).toBe(TTSEngine.OS_NATIVE);
    finishSlow();
    await first;
    expect(Speech.getCurrentEngineId()).toBe(TTSEngine.OS_NATIVE);
    expect(slow.setChunkProgressCallback).toHaveBeenCalled();
  });

  it('a failed latest call still beats an earlier one resolving later', async () => {
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
    let finishSlow!: () => void;
    const slow = fakeEngine('slow-init-2', {
      initialize: jest.fn(() => new Promise<void>(r => (finishSlow = r))),
    });
    Speech.registerEngine(slow as any);
    const first = Speech.initialize({engine: 'slow-init-2'} as any);
    mockInitFail[TTSEngine.KITTEN] = true;
    await expect(
      Speech.initialize({engine: TTSEngine.KITTEN} as any),
    ).rejects.toThrow('init failed');
    finishSlow();
    await first;
    expect(Speech.getCurrentEngineId()).toBe(TTSEngine.OS_NATIVE);
  });
});

describe('Speech.stop with a rejecting engine stop()', () => {
  it('logs instead of leaving an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const e = fakeEngine('stop-rejects', {
        stop: jest.fn(async () => {
          throw new Error('stop failed');
        }),
      });
      Speech.registerEngine(e as any);
      await Speech.initialize({engine: 'stop-rejects'} as any);
      await Speech.stop();
      await new Promise(r => setTimeout(r, 10));
      expect(e.stop).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
  });

  it('still stops natively when a JS add-on stop() returns no promise', async () => {
    const e = fakeEngine('stop-sync', {stop: jest.fn(() => undefined)});
    Speech.registerEngine(e as any);
    await Speech.initialize({engine: 'stop-sync'} as any);
    const nativeStop = jest.requireMock('../NativeSpeech').default.stop;
    nativeStop.mockClear();
    await expect(Speech.stop()).resolves.toBeUndefined();
    expect(nativeStop).toHaveBeenCalledTimes(1);
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
  });

  it('still stops natively when a JS add-on stop() throws synchronously', async () => {
    const e = fakeEngine('stop-throws', {
      stop: jest.fn(() => {
        throw new Error('stop failed');
      }),
    });
    Speech.registerEngine(e as any);
    await Speech.initialize({engine: 'stop-throws'} as any);
    const nativeStop = jest.requireMock('../NativeSpeech').default.stop;
    nativeStop.mockClear();
    await expect(Speech.stop()).resolves.toBeUndefined();
    expect(e.stop).toHaveBeenCalledTimes(1);
    expect(nativeStop).toHaveBeenCalledTimes(1);
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
  });
});

describe('Speech dispatch to a registered engine', () => {
  const fake = fakeEngine('fake');

  beforeAll(() => {
    Speech.registerEngine(fake as any);
  });

  beforeEach(async () => {
    Object.values(fake).forEach(v => jest.isMockFunction(v) && v.mockClear());
    Object.values(nativePlayer).forEach(fn => fn.mockClear());
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
  });

  it('initializes with the config, then reinitializes on later calls', async () => {
    await Speech.initialize({engine: 'fake', modelPath: '/m'} as any);
    expect(fake.initialize).toHaveBeenCalledWith({modelPath: '/m'});
    expect(fake.setChunkProgressCallback).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(Speech.getCurrentEngine()).toBe('fake');
    expect(Speech.getAvailableEngines()).toContain('fake');

    await Speech.initialize({engine: 'fake', modelPath: '/n'} as any);
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(fake.initialize).toHaveBeenLastCalledWith({modelPath: '/n'});
  });

  it('a failed init keeps the previous engine', async () => {
    fake.initialize.mockRejectedValueOnce(new Error('fake init failed'));
    await expect(Speech.initialize({engine: 'fake'} as any)).rejects.toThrow(
      'fake init failed',
    );
    expect(Speech.getCurrentEngine()).toBe(TTSEngine.OS_NATIVE);
  });

  it('routes speak, voices, stop, release, pause, resume and streams', async () => {
    await Speech.initialize({engine: 'fake'} as any);

    await Speech.speak('Hi.', 'v1', {speed: 1.2});
    expect(fake.synthesize).toHaveBeenCalledWith('Hi.', {
      voiceId: 'v1',
      speed: 1.2,
    });
    await expect(Speech.getVoices()).resolves.toEqual(['v1']);
    await expect(Speech.getVoicesWithMetadata('en')).resolves.toEqual([
      {id: 'v1'},
    ]);
    expect(fake.getVoicesWithMetadata).toHaveBeenCalledWith('en');

    await Speech.stop();
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(mockTurbo.stop).toHaveBeenCalled();

    await expect(Speech.release()).resolves.toMatchObject({
      errors: [{component: 'fake'}],
    });

    let finish!: () => void;
    const playing = neuralAudioPlayer.playNative(
      () => new Promise<void>(res => (finish = res)),
    );
    turboPause().mockClear();
    await expect(Speech.pause()).resolves.toBe(true);
    expect(nativePlayer.pause).toHaveBeenCalledTimes(1);
    expect(turboPause()).not.toHaveBeenCalled();
    await Speech.resume();
    expect(nativePlayer.resume).toHaveBeenCalledTimes(1);
    finish();
    await playing;

    const stream = Speech.createSpeechStream('v1', {speed: 2});
    stream.append('Hello there. ');
    await stream.cancel();
    expect(fake.synthesizeStream).toHaveBeenCalledWith(
      expect.objectContaining({voiceId: 'v1', speed: 2}),
    );
  });

  it('getVoicesWithMetadata rejects for engines without it and for os-native', async () => {
    const bare = fakeEngine('bare', {getVoicesWithMetadata: undefined});
    Speech.registerEngine(bare as any);
    await Speech.initialize({engine: 'bare'} as any);
    await expect(Speech.getVoicesWithMetadata()).rejects.toThrow(
      "Engine 'bare' does not provide getVoicesWithMetadata()",
    );
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
    await expect(Speech.getVoicesWithMetadata()).rejects.toThrow(
      'getVoicesWithMetadata() is only available for neural engines (Kokoro, Supertonic, Kitten)',
    );
  });
});

describe('Speech.pause on os-native', () => {
  it('goes to the system synthesizer, not the neural player', async () => {
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
    nativePlayer.pause!.mockClear();
    turboPause().mockClear();
    await Speech.pause();
    expect(turboPause()).toHaveBeenCalledTimes(1);
    expect(nativePlayer.pause).not.toHaveBeenCalled();
  });
});

describe('Speech.getEngineSupport / resetEngineSupport', () => {
  it.each(Object.values(TTSEngine))('%s is supported', async engine => {
    await expect(Speech.getEngineSupport(engine)).resolves.toEqual({
      supported: true,
      reason: 'ok',
    });
    await expect(Speech.resetEngineSupport(engine)).resolves.toBe(true);
  });

  it('asks a registered engine, and never throws', async () => {
    const probe = fakeEngine('probe', {
      getSupport: jest.fn(async () => ({
        supported: false,
        reason: 'missing-cpu-features',
        detail: 'no dotprod',
      })),
      resetSupport: jest.fn(async () => true),
    });
    Speech.registerEngine(probe as any);
    await expect(Speech.getEngineSupport('probe')).resolves.toEqual({
      supported: false,
      reason: 'missing-cpu-features',
      detail: 'no dotprod',
    });
    await expect(Speech.resetEngineSupport('probe')).resolves.toBe(true);
    expect(probe.resetSupport).toHaveBeenCalledTimes(1);

    probe.getSupport.mockRejectedValueOnce(new Error('io'));
    probe.resetSupport.mockRejectedValueOnce(new Error('io'));
    await expect(Speech.getEngineSupport('probe')).resolves.toEqual({
      supported: false,
      reason: 'error',
      detail: 'io',
    });
    await expect(Speech.resetEngineSupport('probe')).resolves.toBe(false);
  });

  it('engines without getSupport are supported; unknown ids are not', async () => {
    Speech.registerEngine(fakeEngine('plain') as any);
    await expect(Speech.getEngineSupport('plain')).resolves.toEqual({
      supported: true,
      reason: 'ok',
    });
    await expect(Speech.getEngineSupport('nope')).resolves.toEqual({
      supported: false,
      reason: 'unknown-engine',
      detail: 'nope',
    });
    await expect(Speech.resetEngineSupport('nope')).resolves.toBe(true);
  });
});

describe('built-in engines', () => {
  it('are constructed only by their first initialize', async () => {
    let isolated!: typeof Speech;
    jest.isolateModules(() => {
      mockConstructed.length = 0;
      isolated = require('../Speech').default;
    });
    expect(mockConstructed).toEqual([]);
    await isolated.getEngineSupport(TTSEngine.KOKORO);
    expect(mockConstructed).toEqual([]);
    await isolated.initialize({engine: TTSEngine.KOKORO} as any);
    await isolated.initialize({engine: TTSEngine.KOKORO} as any);
    expect(mockConstructed).toEqual(['kokoro']);
  });
});

describe('Speech.getCurrentEngineId / getAvailableEngineIds', () => {
  let isolated!: typeof Speech;
  beforeEach(() => {
    jest.isolateModules(() => {
      isolated = require('../Speech').default;
    });
  });

  it('lists every built-in before any is constructed', () => {
    expect(isolated.getCurrentEngineId()).toBe(TTSEngine.OS_NATIVE);
    expect(isolated.getAvailableEngineIds()).toEqual(Object.values(TTSEngine));
  });

  it('includes a registered add-on once, and tracks it as current', async () => {
    const addon = fakeEngine('addon');
    isolated.registerEngine(addon as any);
    await isolated.initialize({engine: TTSEngine.KOKORO} as any);
    expect(isolated.getAvailableEngineIds()).toEqual([
      ...Object.values(TTSEngine),
      'addon',
    ]);
    await isolated.initialize({engine: 'addon'} as any);
    expect(isolated.getCurrentEngineId()).toBe('addon');
  });

  it('keeps the previous id when initialize rejects', async () => {
    const addon = fakeEngine('addon');
    isolated.registerEngine(addon as any);
    await isolated.initialize({engine: 'addon'} as any);
    mockInitFail[TTSEngine.KITTEN] = true;
    await expect(
      isolated.initialize({engine: TTSEngine.KITTEN} as any),
    ).rejects.toThrow('init failed');
    expect(isolated.getCurrentEngineId()).toBe('addon');
    addon.initialize.mockRejectedValueOnce(new Error('addon init failed'));
    await expect(isolated.initialize({engine: 'addon'} as any)).rejects.toThrow(
      'addon init failed',
    );
    expect(isolated.getCurrentEngineId()).toBe('addon');
  });
});
