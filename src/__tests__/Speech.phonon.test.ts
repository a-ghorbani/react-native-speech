/**
 * Speech facade: Phonon routing, getEngineSupport, and currentEngine
 * changing only after a successful init (every engine).
 */
import type {FakeNativePhonon} from '../engines/phonon/__tests__/fakeNativePhonon.shared';

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

jest.mock('../engines/phonon/NativePhonon', () => {
  const {createFakeNativePhonon, NOT_COMPILED} = jest.requireActual(
    '../engines/phonon/__tests__/fakeNativePhonon.shared',
  );
  const fake = createFakeNativePhonon();
  return {
    __esModule: true,
    default: fake.api,
    NOT_COMPILED_SUPPORT: NOT_COMPILED,
    __fake: fake,
  };
});

// Stand-ins for the ONNX engines: initialize() fails on demand.
const mockInitFail: Record<string, boolean> = {};
function mockEngineClass(name: string) {
  return class {
    name = name;
    initialize = jest.fn(async () => {
      if (mockInitFail[name]) throw new Error(`${name} init failed`);
    });
    isReady = jest.fn(async () => true);
    synthesize = jest.fn(async () => {});
    synthesizeStream = jest.fn();
    getAvailableVoices = jest.fn(async () => []);
    getVoicesWithMetadata = jest.fn(() => []);
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
import {PhononEngine} from '../engines/phonon';
import {engineManager} from '../engines/EngineManager';
import NativeNeuralAudioPlayer from '../NativeAudioPlayer';

const fake: FakeNativePhonon = (
  require('../engines/phonon/NativePhonon') as any
).__fake;
const mockTurbo = (require('../NativeSpeech').default as any).__store as Record<
  string,
  jest.Mock
>;
const nativePlayer = NativeNeuralAudioPlayer as unknown as Record<
  string,
  jest.Mock
>;

const PHONON = {
  engine: TTSEngine.PHONON,
  modelPath: '/models/phonon',
} as const;

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

beforeEach(() => {
  fake.reset();
  PhononEngine.clearSupportCache();
  for (const k of Object.keys(mockInitFail)) delete mockInitFail[k];
  Object.values(nativePlayer).forEach(fn => fn.mockClear());
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const s of fake.synths) s.resolve({cancelled: true});
  for (const p of fake.plays) p.resolve();
  await flush();
  jest.restoreAllMocks();
});

describe('Speech.getEngineSupport', () => {
  it.each([
    TTSEngine.OS_NATIVE,
    TTSEngine.KOKORO,
    TTSEngine.SUPERTONIC,
    TTSEngine.KITTEN,
  ])('%s is always supported', async engine => {
    await expect(Speech.getEngineSupport(engine)).resolves.toEqual({
      supported: true,
      reason: 'ok',
    });
  });

  it('phonon delegates to the native probe without creating an engine', async () => {
    await expect(Speech.getEngineSupport(TTSEngine.PHONON)).resolves.toEqual({
      supported: true,
      reason: 'ok',
      detail: '',
    });
    expect(fake.api.create).not.toHaveBeenCalled();
    expect(engineManager.hasEngine(TTSEngine.PHONON)).toBe(false);
  });

  it('never throws: native rejection and unknown engines', async () => {
    fake.api.getSupport.mockRejectedValueOnce(new Error('dead'));
    await expect(Speech.getEngineSupport(TTSEngine.PHONON)).resolves.toEqual({
      supported: false,
      reason: 'error',
      detail: 'dead',
    });
    await expect(
      Speech.getEngineSupport('nope' as TTSEngine),
    ).resolves.toMatchObject({supported: false, reason: 'unknown-engine'});
  });

  it('never throws even if the probe itself throws synchronously', async () => {
    const spy = jest
      .spyOn(PhononEngine, 'getSupport')
      .mockImplementationOnce(() => {
        throw new Error('sync');
      });
    await expect(Speech.getEngineSupport(TTSEngine.PHONON)).resolves.toEqual({
      supported: false,
      reason: 'error',
      detail: 'sync',
    });
    spy.mockRestore();
  });

  it('reports a negative reason', async () => {
    fake.state.support = {
      ...fake.state.support,
      supported: false,
      reason: 'missing-cpu-features',
      detail: 'asimddp',
    };
    await expect(Speech.getEngineSupport(TTSEngine.PHONON)).resolves.toEqual({
      supported: false,
      reason: 'missing-cpu-features',
      detail: 'asimddp',
    });
  });
});

describe('Speech.resetEngineSupport', () => {
  it('is a no-op success for engines that persist nothing', async () => {
    await expect(Speech.resetEngineSupport(TTSEngine.KOKORO)).resolves.toBe(
      true,
    );
    expect(fake.api.resetSupport).not.toHaveBeenCalled();
  });

  it('phonon: clears the native record and the cached probe', async () => {
    fake.state.support = {
      ...fake.state.support,
      supported: false,
      reason: 'library-missing',
    };
    await expect(
      Speech.getEngineSupport(TTSEngine.PHONON),
    ).resolves.toMatchObject({reason: 'library-missing'});
    // A fixed local build was installed; the record is still there.
    fake.state.support = {...fake.state.support, supported: true, reason: 'ok'};
    await expect(Speech.resetEngineSupport(TTSEngine.PHONON)).resolves.toBe(
      true,
    );
    expect(fake.api.resetSupport).toHaveBeenCalledTimes(1);
    await expect(
      Speech.getEngineSupport(TTSEngine.PHONON),
    ).resolves.toMatchObject({supported: true, reason: 'ok'});
  });

  it('never throws', async () => {
    fake.api.resetSupport.mockRejectedValueOnce(new Error('io'));
    await expect(Speech.resetEngineSupport(TTSEngine.PHONON)).resolves.toBe(
      false,
    );
  });
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

  it('phonon unsupported: rejects without create, current engine unchanged', async () => {
    await Speech.initialize({engine: TTSEngine.KITTEN} as any);
    fake.state.support = {
      ...fake.state.support,
      supported: false,
      reason: 'not-compiled',
    };
    const err = await Speech.initialize(PHONON).catch(e => e);
    expect(err.code).toBe('ERR_PHONON_UNSUPPORTED');
    expect(fake.api.create).not.toHaveBeenCalled();
    expect(Speech.getCurrentEngine()).toBe(TTSEngine.KITTEN);
    // Speaking still uses the previous engine.
    await expect(Speech.speak('Hi.')).resolves.toBeUndefined();
  });

  it('unknown engine throws and keeps the current engine', async () => {
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
    await expect(Speech.initialize({engine: 'nope'} as any)).rejects.toThrow(
      'Unknown engine',
    );
    expect(Speech.getCurrentEngine()).toBe(TTSEngine.OS_NATIVE);
  });
});

describe('Speech routing with Phonon', () => {
  beforeEach(async () => {
    await Speech.initialize(PHONON);
  });

  it('becomes current and reinitializes on a second initialize', async () => {
    expect(Speech.getCurrentEngine()).toBe(TTSEngine.PHONON);
    await expect(Speech.isReady()).resolves.toBe(true);
    await Speech.initialize(PHONON);
    expect(fake.api.destroy).toHaveBeenCalled();
    expect(fake.api.create).toHaveBeenCalledTimes(2);
  });

  it('speak forwards voice and options; chunk progress is dispatched', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const progress = jest.fn();
    const un = Speech.onChunkProgress(progress);
    await Speech.speak('Hello there.', 'Marius', {language: 'en-US'});
    un();
    expect(fake.synths[0]).toMatchObject({voice: 'Marius', language: 'en'});
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('getVoices / getVoicesWithMetadata', async () => {
    await expect(Speech.getVoices()).resolves.toEqual(['Alba', 'Marius']);
    await expect(Speech.getVoicesWithMetadata()).resolves.toEqual([
      {id: 'Alba', name: 'Alba', language: 'en'},
      {id: 'Marius', name: 'Marius', language: 'en'},
    ]);
  });

  it('createSpeechStream uses the engine stream with the voice', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const stream = Speech.createSpeechStream('Alba');
    stream.append('Streaming works. ');
    await stream.finalize();
    expect(fake.synths).toHaveLength(1);
    expect(fake.synths[0]!.voice).toBe('Alba');
  });

  it('stop cancels in-flight synthesis natively', async () => {
    const done = Speech.speak('Hello there.');
    await flush();
    const s = fake.synths[0]!;
    await Speech.stop();
    expect(fake.api.cancelUpTo).toHaveBeenCalledWith(s.requestId);
    expect(mockTurbo.stop).toHaveBeenCalled();
    await done;
  });

  it('pause/resume go to the neural player', async () => {
    const done = Speech.speak('Hello there.');
    await flush();
    fake.synths[0]!.resolve();
    await flush();
    await expect(Speech.pause()).resolves.toBe(true);
    expect(nativePlayer.pause).toHaveBeenCalled();
    await expect(Speech.resume()).resolves.toBe(true);
    expect(nativePlayer.resume).toHaveBeenCalled();
    fake.plays[0]!.resolve();
    await done;
  });

  it('a load-failed device is offered again once the model changes', async () => {
    await Speech.release();
    fake.api.create.mockClear();
    fake.state.support = {
      ...fake.state.support,
      supported: false,
      reason: 'load-failed',
    };
    // As on a later launch: the record is on disk, nothing cached yet.
    PhononEngine.clearSupportCache();
    await expect(Speech.initialize(PHONON)).rejects.toMatchObject({
      code: 'ERR_PHONON_UNSUPPORTED',
    });
    expect(fake.api.create).not.toHaveBeenCalled();
    // Model re-downloaded: native drops the record, and JS never cached it.
    fake.state.support = {...fake.state.support, supported: true, reason: 'ok'};
    await Speech.initialize(PHONON);
    expect(fake.api.create).toHaveBeenCalledTimes(1);
  });

  it('two concurrent re-initializations run one after the other', async () => {
    const pending: Array<() => void> = [];
    fake.api.create.mockImplementation(
      (_dir: string, _opts: unknown) =>
        new Promise(resolve => {
          const handleId = 900 + pending.length;
          pending.push(() => resolve({...fake.state.load, handleId}));
        }),
    );
    try {
      fake.api.destroy.mockClear();
      const a = Speech.initialize(PHONON);
      const b = Speech.initialize(PHONON);
      const settled = Promise.allSettled([a, b]);
      await flush();
      // Both destroys ran first (in call order), then exactly one create.
      expect(pending).toHaveLength(1);
      pending[0]!();
      const results = await settled;
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
      // No second create replaced (and freed) the live handle 900.
      expect(pending).toHaveLength(1);
      expect(fake.api.destroy).not.toHaveBeenCalledWith(900);
      await expect(Speech.isReady()).resolves.toBe(true);
    } finally {
      fake.api.create.mockReset();
      fake.api.create.mockImplementation(async () => ({
        ...fake.state.load,
        handleId: 1000,
      }));
    }
  });

  it('release destroys the native handle', async () => {
    await expect(Speech.release()).resolves.toMatchObject({success: true});
    expect(fake.api.destroy).toHaveBeenCalled();
  });
});

describe('getVoicesWithMetadata before phonon exists', () => {
  it('is covered by the unknown-engine branch for os-native', async () => {
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
    await expect(Speech.getVoicesWithMetadata()).rejects.toThrow('Phonon');
  });
});
