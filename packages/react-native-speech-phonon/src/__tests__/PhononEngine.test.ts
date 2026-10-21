/**
 * PhononEngine: lifecycle, chunked playback, cancellation races, stream
 * sessions and the watchdog, against a deferred-controlled fake of
 * NativePhonon (the engine's only native seam).
 */

const mockReadFile = jest.fn(async (_p: string, _enc: string) => '');
jest.mock(
  '@dr.pogodin/react-native-fs',
  () => ({
    exists: jest.fn(async () => true),
    readFile: (p: string, enc: string) => mockReadFile(p, enc),
  }),
  {virtual: true},
);

jest.mock('../NativePhonon', () => {
  const {createFakeNativePhonon, NOT_COMPILED} = jest.requireActual(
    './fakeNativePhonon.shared',
  );
  const fake = createFakeNativePhonon();
  return {
    __esModule: true,
    default: fake.api,
    NOT_COMPILED_SUPPORT: NOT_COMPILED,
    __fake: fake,
  };
});

jest.mock('../../../../src/NativeSpeech', () => ({
  __esModule: true,
  default: {getConstants: () => ({maxInputLength: 4000})},
}));

jest.mock('../../../../src/NativeAudioPlayer', () => ({
  __esModule: true,
  default: {
    playAudio: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    pause: jest.fn(async () => true),
    resume: jest.fn(async () => true),
    isSpeaking: jest.fn(async () => false),
  },
}));

import {
  PhononEngine,
  normalizePhononLanguage,
  phononWatchdogMs,
  phononCreateWatchdogMs,
  __resetPhononBrokenStateForTests,
} from '../PhononEngine';
import {PhononError} from '../errors';
import type {FakeNativePhonon} from './fakeNativePhonon.shared';
import type {PhononConfig} from '../types';
import type {
  AudioBuffer,
  ChunkProgressEvent,
} from '@pocketpalai/react-native-speech';
import {neuralAudioPlayer} from '@pocketpalai/react-native-speech/engine-sdk';
import NativeNeuralAudioPlayer from '../../../../src/NativeAudioPlayer';

const fake: FakeNativePhonon = (require('../NativePhonon') as any).__fake;
const nativePlayer = NativeNeuralAudioPlayer as unknown as Record<
  string,
  jest.Mock
>;

const CONFIG: PhononConfig = {modelPath: '/models/phonon-31m-en'};

async function flush(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

async function ready(
  config: Partial<PhononConfig> = {},
): Promise<PhononEngine> {
  const engine = new PhononEngine();
  await engine.initialize({...CONFIG, ...config});
  return engine;
}

/** Latest pending synth call. */
function lastSynth() {
  const s = fake.synths[fake.synths.length - 1];
  if (!s) throw new Error('no synth call');
  return s;
}

function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: {code?: string}) => e.code,
  );
}

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  fake.reset();
  Object.values(nativePlayer).forEach(fn => fn.mockClear());
  mockReadFile.mockReset();
  mockReadFile.mockResolvedValue('');
  PhononEngine.clearSupportCache();
  __resetPhononBrokenStateForTests();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  // Settle whatever a test left pending so no watchdog timer outlives it.
  for (const s of fake.synths) s.resolve({cancelled: true});
  for (const p of fake.plays) p.resolve();
  await flush();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  jest.useRealTimers();
});

describe('PhononEngine.getSupport', () => {
  it('resolves the native probe and caches it', async () => {
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      supported: true,
      reason: 'ok',
    });
    await PhononEngine.getSupport();
    expect(fake.api.getSupport).toHaveBeenCalledTimes(1);
  });

  it('returns a copy, so callers cannot poison the cache', async () => {
    const a = await PhononEngine.getSupport();
    a.supported = false;
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      supported: true,
    });
  });

  it('never throws and does not cache a rejection', async () => {
    fake.api.getSupport.mockRejectedValueOnce(new Error('binder died'));
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      supported: false,
      reason: 'error',
      detail: 'binder died',
    });
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      supported: true,
      reason: 'ok',
    });
    expect(fake.api.getSupport).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error rejections and malformed results', async () => {
    fake.api.getSupport.mockRejectedValueOnce('nope');
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      reason: 'error',
      detail: 'nope',
    });
    fake.api.getSupport.mockResolvedValueOnce(null as any);
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      reason: 'error',
    });
    fake.api.getSupport.mockResolvedValueOnce({supported: 'yes'} as any);
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      supported: false,
      reason: 'error',
    });
  });

  it.each([
    'not-compiled',
    'unsupported-abi',
    'translated-abi',
    'missing-cpu-features',
    'library-missing',
    'symbols-missing',
    'load-failed',
    'os-too-old',
    'low-memory',
    'forced',
    'error',
  ])(
    'reason %s -> supported:false and initialize rejects without create',
    async reason => {
      fake.state.support = {
        ...fake.state.support,
        supported: false,
        reason,
        detail: `why ${reason}`,
      };
      await expect(PhononEngine.getSupport()).resolves.toMatchObject({
        supported: false,
        reason,
      });
      const engine = new PhononEngine();
      const err = await engine.initialize(CONFIG).catch(e => e);
      expect(err).toBeInstanceOf(PhononError);
      expect(err.code).toBe('ERR_PHONON_UNSUPPORTED');
      expect(err.reason).toBe(reason);
      expect(err.message).toContain(`why ${reason}`);
      expect(fake.api.create).not.toHaveBeenCalled();
      expect(await engine.isReady()).toBe(false);
    },
  );

  it('treats supported:true with a non-ok reason as unsupported', async () => {
    fake.state.support = {...fake.state.support, reason: 'forced'};
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      supported: false,
    });
  });

  it('never caches load-failed: native drops it once the model changes', async () => {
    fake.state.support = {
      ...fake.state.support,
      supported: false,
      reason: 'load-failed',
      detail: 'backend initialization failed',
    };
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      reason: 'load-failed',
    });
    // The user re-downloaded the model: native no longer applies the record.
    fake.state.support = {...fake.state.support, supported: true, reason: 'ok'};
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      supported: true,
    });
    expect(fake.api.getSupport).toHaveBeenCalledTimes(2);
  });

  it('resetSupport clears native and the cache, never throws', async () => {
    fake.state.support = {
      ...fake.state.support,
      supported: false,
      reason: 'symbols-missing',
    };
    await PhononEngine.getSupport();
    fake.state.support = {...fake.state.support, supported: true, reason: 'ok'};
    // Still cached.
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      reason: 'symbols-missing',
    });
    await expect(PhononEngine.resetSupport()).resolves.toBe(true);
    expect(fake.api.resetSupport).toHaveBeenCalledTimes(1);
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      reason: 'ok',
    });

    fake.api.resetSupport.mockRejectedValueOnce(new Error('io'));
    await expect(PhononEngine.resetSupport()).resolves.toBe(false);
  });

  it('needsCompile and getDiagnostics never throw', async () => {
    fake.api.needsCompile.mockResolvedValueOnce(true);
    await expect(PhononEngine.needsCompile('/m')).resolves.toBe(true);
    fake.api.needsCompile.mockRejectedValueOnce(new Error('x'));
    await expect(PhononEngine.needsCompile('/m')).resolves.toBe(false);

    await expect(PhononEngine.getDiagnostics()).resolves.toMatchObject({
      libraryLoaded: true,
    });
    fake.api.getDiagnostics.mockRejectedValueOnce(new Error('x'));
    await expect(PhononEngine.getDiagnostics()).resolves.toBeNull();
  });
});

describe('initialize', () => {
  it('probes, then creates with normalized options', async () => {
    const engine = await ready({language: 'en' as any});
    expect(fake.api.create).toHaveBeenCalledWith(CONFIG.modelPath, {
      language: 'en',
      numThreads: 0,
      computeUnit: 'neuralEngine',
      spinBudget: 0,
    });
    expect(await engine.isReady()).toBe(true);
    expect(engine.getLoadInfo()).toMatchObject({voices: ['Alba', 'Marius']});
    expect(engine.getStatus()).toEqual({
      isReady: true,
      isLoading: false,
      error: null,
    });
    await engine.initialize(CONFIG);
    expect(fake.api.create).toHaveBeenCalledTimes(1);
  });

  it('forwards numThreads/computeUnit and normalizes a locale', async () => {
    await ready({
      language: 'EN-us' as any,
      numThreads: 3,
      computeUnit: 'cpu',
    });
    expect(fake.api.create).toHaveBeenCalledWith(CONFIG.modelPath, {
      language: 'en',
      numThreads: 3,
      computeUnit: 'cpu',
      spinBudget: 0,
    });
  });

  it('rejects a missing config or modelPath', async () => {
    await expect(new PhononEngine().initialize()).rejects.toThrow(
      'modelPath required',
    );
    await expect(
      new PhononEngine().initialize({modelPath: ''}),
    ).rejects.toThrow('modelPath required');
    expect(fake.api.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown language before create', async () => {
    const engine = new PhononEngine();
    await expect(
      codeOf(engine.initialize({...CONFIG, language: 'xx' as any})),
    ).resolves.toBe('ERR_PHONON_LANGUAGE');
    expect(fake.api.create).not.toHaveBeenCalled();
  });

  it('rejects a language the model lacks and frees the handle', async () => {
    const engine = new PhononEngine();
    await expect(
      codeOf(engine.initialize({...CONFIG, language: 'fr'})),
    ).resolves.toBe('ERR_PHONON_LANGUAGE');
    expect(fake.api.destroy).toHaveBeenCalledTimes(1);
    expect(await engine.isReady()).toBe(false);
    expect(engine.getStatus().error).toContain("'fr'");
  });

  it('rejects an unknown defaultVoice and frees the handle', async () => {
    const engine = new PhononEngine();
    const err = await engine
      .initialize({...CONFIG, defaultVoice: 'Nobody'})
      .catch(e => e);
    expect(err.code).toBe('ERR_PHONON_VOICE');
    expect(err.message).toContain('Alba, Marius');
    expect(fake.api.destroy).toHaveBeenCalledTimes(1);
  });

  it('maps a load failure and drops the cached probe', async () => {
    fake.api.create.mockRejectedValueOnce(
      Object.assign(new Error('ptts_new failed'), {code: 'PHONON_LOAD_FAILED'}),
    );
    const engine = new PhononEngine();
    const err = await engine.initialize(CONFIG).catch(e => e);
    expect(err.code).toBe('ERR_PHONON_LOAD');
    expect(err.nativeCode).toBe('PHONON_LOAD_FAILED');
    expect(err.message).toBe('ptts_new failed');

    // Native now records a negative capability; the next probe sees it.
    fake.state.support = {
      ...fake.state.support,
      supported: false,
      reason: 'load-failed',
    };
    await expect(codeOf(engine.initialize(CONFIG))).resolves.toBe(
      'ERR_PHONON_UNSUPPORTED',
    );
    expect(fake.api.getSupport).toHaveBeenCalledTimes(2);
  });

  it('keeps the probe cache on other create errors', async () => {
    fake.api.create.mockRejectedValueOnce(
      Object.assign(new Error('jni'), {code: 'PHONON_INTERNAL'}),
    );
    const engine = new PhononEngine();
    await expect(codeOf(engine.initialize(CONFIG))).resolves.toBe(
      'ERR_PHONON_INTERNAL',
    );
    await engine.initialize(CONFIG);
    expect(fake.api.getSupport).toHaveBeenCalledTimes(1);
  });

  it('a load-failed record stops gating once the model changes', async () => {
    fake.state.support = {
      ...fake.state.support,
      supported: false,
      reason: 'load-failed',
    };
    const engine = new PhononEngine();
    await expect(codeOf(engine.initialize(CONFIG))).resolves.toBe(
      'ERR_PHONON_UNSUPPORTED',
    );
    expect(fake.api.create).not.toHaveBeenCalled();
    fake.state.support = {...fake.state.support, supported: true, reason: 'ok'};
    await engine.initialize(CONFIG);
    expect(fake.api.create).toHaveBeenCalledTimes(1);
    expect(await engine.isReady()).toBe(true);
  });

  it('logs expected gating outcomes without console.error', async () => {
    fake.state.support = {
      ...fake.state.support,
      supported: false,
      reason: 'missing-cpu-features',
    };
    await expect(codeOf(new PhononEngine().initialize(CONFIG))).resolves.toBe(
      'ERR_PHONON_UNSUPPORTED',
    );
    fake.state.support = {...fake.state.support, supported: true, reason: 'ok'};
    PhononEngine.clearSupportCache();
    fake.api.create.mockRejectedValueOnce(
      Object.assign(new Error('ptts_new failed'), {code: 'PHONON_LOAD_FAILED'}),
    );
    await expect(codeOf(new PhononEngine().initialize(CONFIG))).resolves.toBe(
      'ERR_PHONON_LOAD',
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(' ')).toContain(
      'missing-cpu-features',
    );
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('ptts_new failed');

    // Unexpected failures still go to console.error.
    fake.api.create.mockRejectedValueOnce(
      Object.assign(new Error('jni'), {code: 'PHONON_INTERNAL'}),
    );
    await new PhononEngine().initialize(CONFIG).catch(() => {});
    expect(errorSpy).toHaveBeenCalled();
  });

  it('destroy during initialize waits for it, so creates never overlap', async () => {
    // EngineManager.reinitializeEngine (destroy + initialize) racing an
    // initialize that is still creating.
    let finishCreate!: () => void;
    fake.api.create.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishCreate = () => resolve({...fake.state.load, handleId: 501});
        }),
    );
    const engine = new PhononEngine();
    const first = engine.initialize(CONFIG);
    await flush();
    let destroyed = false;
    const second = engine.destroy().then(async () => {
      destroyed = true;
      await engine.initialize(CONFIG);
    });
    await flush();
    expect(destroyed).toBe(false);
    expect(engine.getStatus().isLoading).toBe(true);
    // release() still refuses mid-load.
    await expect(engine.release()).resolves.toMatchObject({success: false});
    expect(fake.api.create).toHaveBeenCalledTimes(1);

    finishCreate();
    await first;
    await second;
    // Handle 501 was destroyed after its create finished; one new create.
    expect(fake.api.destroy).toHaveBeenCalledWith(501);
    expect(fake.api.create).toHaveBeenCalledTimes(2);
    expect(await engine.isReady()).toBe(true);
    expect(engine.getLoadInfo()!.handleId).not.toBe(501);
  });

  it('a concurrent initialize waits for the first and creates once', async () => {
    const engine = new PhononEngine();
    const first = engine.initialize(CONFIG);
    const second = engine.initialize(CONFIG);
    await Promise.all([first, second]);
    expect(fake.api.create).toHaveBeenCalledTimes(1);
    expect(await engine.isReady()).toBe(true);
  });

  it('a failed initialize does not block the next lifecycle call', async () => {
    fake.api.create.mockRejectedValueOnce(
      Object.assign(new Error('jni'), {code: 'PHONON_INTERNAL'}),
    );
    const engine = new PhononEngine();
    const first = engine.initialize(CONFIG);
    const second = engine.initialize(CONFIG);
    await expect(codeOf(first)).resolves.toBe('ERR_PHONON_INTERNAL');
    await second;
    expect(await engine.isReady()).toBe(true);
  });

  it('forwards spinBudget to native and logs a pending compile', async () => {
    fake.api.needsCompile.mockResolvedValueOnce(true);
    await ready({spinBudget: 200});
    expect(fake.api.create).toHaveBeenCalledWith(
      CONFIG.modelPath,
      expect.objectContaining({spinBudget: 200}),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Core ML compile');
  });
});

describe('voices', () => {
  it('lists model voices with catalog metadata', async () => {
    mockReadFile.mockResolvedValueOnce(
      [
        '{"name":"Alba","filename":"voices/a.safetensors","language":"en","description":"Warm"}',
        'not json',
        '',
        '{"name":"Zoe","filename":"voices/z.safetensors","language":"fr"}',
      ].join('\n'),
    );
    const engine = await ready({voicesMetadataPath: '/models/voices.jsonl'});
    expect(mockReadFile).toHaveBeenCalledWith('/models/voices.jsonl', 'utf8');
    expect(engine.getVoicesWithMetadata()).toEqual([
      {id: 'Alba', name: 'Alba', language: 'en', description: 'Warm'},
      {id: 'Marius', name: 'Marius', language: 'en'},
    ]);
    await expect(engine.getAvailableVoices('en-US')).resolves.toEqual([
      'Alba',
      'Marius',
    ]);
    await expect(engine.getAvailableVoices('fr')).resolves.toEqual([]);
  });

  it('falls back to ids when the metadata cannot be read', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const engine = await ready({voicesMetadataPath: 'file:///nope.jsonl'});
    expect(engine.getVoicesWithMetadata().map(v => v.name)).toEqual([
      'Alba',
      'Marius',
    ]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('throws when not initialized', async () => {
    const engine = new PhononEngine();
    expect(() => engine.getVoicesWithMetadata()).toThrow('not initialized');
    await expect(engine.getAvailableVoices()).rejects.toThrow(
      'not initialized',
    );
  });

  it('language none leaves voice language unset', async () => {
    const engine = await ready({language: 'none'});
    expect(engine.getVoicesWithMetadata()[0]).toEqual({
      id: 'Alba',
      name: 'Alba',
    });
    // Voices without a language match any filter.
    await expect(engine.getAvailableVoices('fr')).resolves.toHaveLength(2);
  });
});

describe('synthesize: input and options', () => {
  it('requires initialize', async () => {
    await expect(codeOf(new PhononEngine().synthesize('Hello.'))).resolves.toBe(
      'ERR_PHONON_NOT_INITIALIZED',
    );
  });

  it('rejects phoneme input and empty text', async () => {
    const engine = await ready();
    await expect(engine.synthesize({phonemes: 'həˈloʊ'})).rejects.toThrow(
      'no phoneme path',
    );
    await expect(engine.synthesize('   ')).rejects.toThrow('cannot be empty');
    expect(fake.api.synthesize).not.toHaveBeenCalled();
  });

  it("uses '' (upstream default) when no voice is given", async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    await engine.synthesize('Hello there.');
    expect(fake.synths[0]).toMatchObject({voice: '', language: 'en'});
  });

  it('uses config.defaultVoice, then options.voiceId (case-insensitive)', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready({defaultVoice: 'Alba'});
    await engine.synthesize('One.');
    await engine.synthesize('Two.', {voiceId: 'marius'});
    expect(fake.synths.map(s => s.voice)).toEqual(['Alba', 'Marius']);
  });

  it('rejects an unknown voice, listing valid ids', async () => {
    const engine = await ready();
    const err = await engine.synthesize('Hi.', {voiceId: 'Bob'}).catch(e => e);
    expect(err.code).toBe('ERR_PHONON_VOICE');
    expect(err.message).toContain('Available: Alba, Marius');
    expect(fake.api.synthesize).not.toHaveBeenCalled();
  });

  it('allows a model without voices (unconditioned speech)', async () => {
    fake.state.load = {...fake.state.load, voices: [], defaultVoice: ''};
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    await engine.synthesize('Hello.');
    expect(fake.synths[0]!.voice).toBe('');
    const err = await engine
      .synthesize('Hello.', {voiceId: 'Alba'})
      .catch(e => e);
    expect(err.code).toBe('ERR_PHONON_VOICE');
    expect(err.message).toContain('no voices');
  });

  it('normalizes the per-call language and rejects unsupported ones', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    await engine.synthesize('One.', {language: 'en_GB'});
    await engine.synthesize('Two.', {language: 'none'});
    expect(fake.synths.map(s => s.language)).toEqual(['en', 'none']);
    await expect(
      codeOf(engine.synthesize('Three.', {language: 'fr-FR'})),
    ).resolves.toBe('ERR_PHONON_LANGUAGE');
  });

  it('warns once per instance for speed and pitch', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    await engine.synthesize('One.', {speed: 1.5, pitch: 0.8});
    await engine.synthesize('Two.', {speed: 0.7, pitch: 1.2});
    await engine.synthesize('Three.', {speed: 1, pitch: 1});
    const warnings = warnSpy.mock.calls.map(c => String(c[0]));
    expect(warnings.filter(w => w.includes('speed'))).toHaveLength(1);
    expect(warnings.filter(w => w.includes('pitch'))).toHaveLength(1);
  });

  it("splits the first chunk at a clause with firstChunk:'clause'", async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    await engine.synthesize('Well, as I said before, this is it.', {
      firstChunk: 'clause',
    });
    expect(fake.synths.map(s => s.text)).toEqual([
      'Well, as I said before, ',
      'this is it.',
    ]);
    // Without it, one sentence-grouped chunk.
    fake.synths.length = 0;
    await engine.synthesize('Well, as I said before, this is it.');
    expect(fake.synths).toHaveLength(1);
    // A first chunk with no clause boundary is left alone.
    fake.synths.length = 0;
    await engine.synthesize('Short one.', {firstChunk: 'clause'});
    expect(fake.synths.map(s => s.text)).toEqual(['Short one.']);
  });

  it('strips markdown unless told not to', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    await engine.synthesize('**Bold** move.');
    await engine.synthesize('**Bold** move.', {stripMarkdown: false});
    expect(fake.synths[0]!.text).not.toContain('**');
    expect(fake.synths[1]!.text).toContain('**');
  });
});

describe('synthesize: chunked playback', () => {
  const TEXT = 'First sentence here. Second one now. Third and last.';

  it('plays chunks in order, prefetching the next while one plays', async () => {
    const engine = await ready({maxChunkSize: 25});
    const progress: ChunkProgressEvent[] = [];
    engine.setChunkProgressCallback(e => progress.push(e));
    const done = engine.synthesize(TEXT, {ducking: true, volume: 0.8});
    await flush();

    expect(fake.synths).toHaveLength(1);
    fake.synths[0]!.resolve();
    await flush();
    // Chunk 0 plays; chunk 1 was requested before play finished.
    expect(fake.plays).toHaveLength(1);
    expect(fake.synths).toHaveLength(2);
    expect(fake.plays[0]!.config).toEqual({
      sampleRate: 24000,
      ducking: true,
      volume: 0.8,
    });

    fake.synths[1]!.resolve();
    await flush();
    expect(fake.plays).toHaveLength(1);
    fake.plays[0]!.resolve();
    await flush();
    expect(fake.plays).toHaveLength(2);
    expect(fake.synths).toHaveLength(3);

    fake.synths[2]!.resolve();
    fake.plays[1]!.resolve();
    await flush();
    fake.plays[2]!.resolve();
    await done;

    expect(fake.synths.map(s => s.text)).toEqual([
      'First sentence here.',
      'Second one now.',
      'Third and last.',
    ]);
    expect(fake.plays.map(p => p.bufferId)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(new Set(fake.plays.map(p => p.bufferId)).size).toBe(3);
    expect(progress.map(p => [p.chunkIndex, p.totalChunks])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(fake.liveBuffers()).toBe(0);

    const metrics = engine.getLastMetrics()!;
    expect(metrics).toMatchObject({
      event: 'PHONON_CHUNK',
      path: 'synth',
      chars: 'Third and last.'.length,
      ttfaMs: 40,
      totalMs: 80,
      queuedMs: 1,
      startedAtMs: 1000,
      finishedAtMs: 1080,
      voiceChanged: false,
    });
    expect(metrics.playEndTs).toBeGreaterThanOrEqual(metrics.playStartTs);
    expect(
      logSpy.mock.calls.filter(c => String(c[0]).includes('[BENCH]')),
    ).toHaveLength(3);
  });

  it('reports every played chunk to onChunkMetrics listeners', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready({maxChunkSize: 25});
    const seen: string[] = [];
    engine.onChunkMetrics(() => {
      throw new Error('listener bug');
    });
    const unsubscribe = engine.onChunkMetrics(m =>
      seen.push(`${m.path}:${m.chars}`),
    );
    await engine.synthesize(TEXT);
    expect(seen).toEqual([
      `synth:${'First sentence here.'.length}`,
      `synth:${'Second one now.'.length}`,
      `synth:${'Third and last.'.length}`,
    ]);

    unsubscribe();
    await engine.synthesize(TEXT);
    expect(seen).toHaveLength(3);
  });

  it('skips chunks that produced no audio', async () => {
    fake.state.autoPlay = true;
    const engine = await ready({maxChunkSize: 25});
    const done = engine.synthesize(TEXT);
    await flush();
    fake.synths[0]!.resolve({samples: 0});
    await flush();
    fake.synths[1]!.resolve();
    await flush();
    fake.synths[2]!.resolve();
    await done;
    expect(fake.plays).toHaveLength(2);
  });

  it('fires onAudioChunk with volume applied, only for played chunks', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready({maxChunkSize: 25});
    const seen: AudioBuffer[] = [];
    await engine.synthesize(TEXT, {
      volume: 0.5,
      onAudioChunk: b => seen.push(b),
    });
    expect(seen).toHaveLength(3);
    expect(seen[0]!.samples[0]).toBeCloseTo(0.25);
    expect(seen[0]!.sampleRate).toBe(24000);
    expect(seen[0]!.duration).toBeCloseTo(seen[0]!.samples.length / 24000);
    expect(fake.api.copyBuffer).toHaveBeenCalledTimes(3);
    expect(fake.liveBuffers()).toBe(0);
  });

  it('keeps going when onAudioChunk throws', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    await engine.synthesize('Hi there.', {
      onAudioChunk: () => {
        throw new Error('observer bug');
      },
    });
    expect(fake.plays).toHaveLength(1);
  });

  it('a throwing chunk progress callback neither aborts nor leaks', async () => {
    const engine = await ready({maxChunkSize: 25});
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    engine.setChunkProgressCallback(() => {
      throw new Error('listener bug');
    });
    await engine.synthesize('First sentence here. Second one now.');
    expect(fake.plays).toHaveLength(2);
    expect(fake.liveBuffers()).toBe(0);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('progress');
  });

  it('does not copy PCM without onAudioChunk', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    await engine.synthesize('Hi there.');
    expect(fake.api.copyBuffer).not.toHaveBeenCalled();
  });

  it('maps a native synth failure', async () => {
    const engine = await ready();
    const done = engine.synthesize('Hello.');
    await flush();
    lastSynth().reject(
      Object.assign(new Error('speak failed'), {code: 'PHONON_SPEAK_FAILED'}),
    );
    const err = await done.catch(e => e);
    expect(err.code).toBe('ERR_PHONON_SYNTH');
  });

  it('surfaces a prefetch failure after the current chunk plays', async () => {
    const engine = await ready({maxChunkSize: 25});
    const done = engine.synthesize(TEXT);
    await flush();
    fake.synths[0]!.resolve();
    await flush();
    fake.synths[1]!.reject(
      Object.assign(new Error('full'), {code: 'PHONON_BUFFER_LIMIT'}),
    );
    await flush();
    fake.plays[0]!.resolve();
    await expect(codeOf(done)).resolves.toBe('ERR_PHONON_BUFFER_LIMIT');
  });

  it('releases the prefetched buffer when playback fails', async () => {
    const engine = await ready({maxChunkSize: 25});
    const done = engine.synthesize(TEXT);
    await flush();
    fake.synths[0]!.resolve();
    await flush();
    fake.plays[0]!.reject(new Error('AudioTrack died'));
    await expect(done).rejects.toThrow('AudioTrack died');
    fake.synths[1]!.resolve();
    await flush();
    expect(fake.liveBuffers()).toBe(0);
    expect(fake.plays).toHaveLength(1);
  });

  it('releases the buffer when copying PCM fails', async () => {
    const engine = await ready();
    fake.api.copyBuffer.mockRejectedValueOnce(
      Object.assign(new Error('gone'), {code: 'PHONON_INVALID_BUFFER'}),
    );
    const done = engine.synthesize('Hello.', {onAudioChunk: () => {}});
    await flush();
    lastSynth().resolve();
    await expect(codeOf(done)).resolves.toBe('ERR_PHONON_INTERNAL');
    expect(fake.liveBuffers()).toBe(0);
  });
});

describe('synthesize: stop and re-entry races', () => {
  const TEXT = 'First sentence here. Second one now. Third and last.';

  it('stop between native resolve and JS continuation releases, never plays', async () => {
    const engine = await ready();
    const done = engine.synthesize('Hello there.');
    await flush();
    lastSynth().resolve({cancelled: false});
    // Native has resolved with a buffer; JS has not run its continuation.
    expect(fake.liveBuffers()).toBe(1);
    engine.stop();
    await done;
    await flush();
    expect(fake.api.playBuffer).not.toHaveBeenCalled();
    expect(fake.liveBuffers()).toBe(0);
  });

  it('stop during in-flight synth cancels up to the max in-flight id', async () => {
    const engine = await ready({maxChunkSize: 25});
    const done = engine.synthesize(TEXT);
    await flush();
    fake.synths[0]!.resolve();
    await flush();
    // Chunk 0 playing, chunk 1 in flight.
    const prefetchId = fake.synths[1]!.requestId;
    await engine.stop();
    expect(fake.api.cancelUpTo).toHaveBeenLastCalledWith(prefetchId);
    // The pending playBuffer made the shared player call native stop.
    expect(nativePlayer.stop).toHaveBeenCalled();
    await done;

    fake.synths[1]!.resolve();
    fake.plays[0]!.resolve();
    await flush();
    expect(fake.plays).toHaveLength(1);
    expect(fake.liveBuffers()).toBe(0);
    expect(fake.synths).toHaveLength(2);
  });

  it('stop with nothing in flight does not cancel natively', async () => {
    const engine = await ready();
    await engine.stop();
    expect(fake.api.cancelUpTo).not.toHaveBeenCalled();
  });

  it('a stale result arriving uncancelled is released', async () => {
    const engine = await ready();
    const done = engine.synthesize('Hello there.');
    await flush();
    const s = lastSynth();
    engine.stop();
    await done;
    // Native missed the cancel and still produced a buffer.
    s.resolve({cancelled: false});
    await flush();
    expect(fake.liveBuffers()).toBe(0);
    expect(fake.api.playBuffer).not.toHaveBeenCalled();
  });

  it('a stale request that fails is swallowed', async () => {
    const engine = await ready();
    const done = engine.synthesize('Hello there.');
    await flush();
    const s = lastSynth();
    engine.stop();
    await done;
    s.reject(Object.assign(new Error('x'), {code: 'PHONON_SPEAK_FAILED'}));
    await flush();
  });

  it('re-entrant synthesize() cancels the previous call first', async () => {
    const engine = await ready();
    const first = engine.synthesize('First call.');
    await flush();
    const firstSynth = lastSynth();

    const second = engine.synthesize('Second call.');
    expect(fake.api.cancelUpTo).toHaveBeenCalledWith(firstSynth.requestId);
    await first;
    await flush();
    // The second call's native request is issued after the first unwound.
    expect(fake.synths).toHaveLength(2);
    firstSynth.resolve();
    const s2 = lastSynth();
    expect(s2.text).toBe('Second call.');
    s2.resolve();
    await flush();
    fake.plays[0]!.resolve();
    await second;
    expect(fake.plays).toHaveLength(1);
    expect(fake.liveBuffers()).toBe(0);
  });

  it('two concurrent speak() calls: only the newest plays', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    const a = engine.synthesize('Call A.');
    const b = engine.synthesize('Call B.');
    const c = engine.synthesize('Call C.');
    await Promise.all([a, b, c]);
    await flush();
    // A and B were superseded before reaching native.
    expect(fake.synths.map(s => s.text)).toEqual(['Call C.']);
    expect(fake.plays).toHaveLength(1);
    expect(fake.liveBuffers()).toBe(0);
  });

  it('a stop() during re-entry wait supersedes the waiting call', async () => {
    const engine = await ready();
    const first = engine.synthesize('First call.');
    await flush();
    const second = engine.synthesize('Second call.');
    engine.stop();
    await Promise.all([first, second]);
    lastSynth().resolve();
    await flush();
    expect(fake.synths).toHaveLength(1);
    expect(fake.plays).toHaveLength(0);
  });

  it('release during an in-flight synth swallows INVALID_HANDLE', async () => {
    const engine = await ready();
    const done = engine.synthesize('Hello there.');
    await flush();
    const s = lastSynth();
    const released = engine.release();
    await done;
    await expect(released).resolves.toEqual({
      success: true,
      partialRelease: false,
      errors: [],
    });
    expect(fake.api.destroy).toHaveBeenCalledWith(s.handleId);
    s.reject(
      Object.assign(new Error('stale handle'), {code: 'PHONON_INVALID_HANDLE'}),
    );
    await flush();
    expect(await engine.isReady()).toBe(false);
    await expect(codeOf(engine.synthesize('Again.'))).resolves.toBe(
      'ERR_PHONON_NOT_INITIALIZED',
    );
  });

  it('neuralAudioPlayer.stop()/pause() reach native during playBuffer', async () => {
    const engine = await ready();
    const done = engine.synthesize('Hello there.');
    await flush();
    lastSynth().resolve();
    await flush();
    expect(fake.plays).toHaveLength(1);
    await expect(neuralAudioPlayer.pause()).resolves.toBe(true);
    expect(nativePlayer.pause).toHaveBeenCalledTimes(1);
    await neuralAudioPlayer.stop();
    expect(nativePlayer.stop).toHaveBeenCalledTimes(1);
    fake.plays[0]!.resolve();
    await done;
  });
});

describe('synthesize: PCM copy races', () => {
  it('stop while copying PCM releases the buffer', async () => {
    const engine = await ready();
    let resolveCopy!: (b64: string) => void;
    fake.api.copyBuffer.mockImplementationOnce(
      () => new Promise<string>(r => (resolveCopy = r)),
    );
    const onAudioChunk = jest.fn();
    const done = engine.synthesize('Hello there.', {onAudioChunk});
    await flush();
    lastSynth().resolve();
    await flush();
    expect(fake.api.copyBuffer).toHaveBeenCalledTimes(1);
    engine.stop();
    await done;
    resolveCopy('AAAAAA==');
    await flush();
    expect(fake.liveBuffers()).toBe(0);
    expect(onAudioChunk).not.toHaveBeenCalled();
    expect(fake.api.playBuffer).not.toHaveBeenCalled();
  });

  it('a failed copy of a stale chunk is swallowed and released', async () => {
    const engine = await ready();
    let rejectCopy!: (e: Error) => void;
    fake.api.copyBuffer.mockImplementationOnce(
      () => new Promise<string>((_r, j) => (rejectCopy = j)),
    );
    const done = engine.synthesize('Hello there.', {onAudioChunk: () => {}});
    await flush();
    lastSynth().resolve();
    await flush();
    engine.stop();
    await done;
    rejectCopy(new Error('gone'));
    await flush();
    expect(fake.liveBuffers()).toBe(0);
  });

  it('an empty PCM copy yields an empty observer buffer', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    fake.api.copyBuffer.mockResolvedValueOnce('');
    const seen: AudioBuffer[] = [];
    await engine.synthesize('Hello there.', {onAudioChunk: b => seen.push(b)});
    expect(seen[0]!.samples).toHaveLength(0);
    expect(fake.plays).toHaveLength(1);
  });
});

describe('watchdog', () => {
  it('computes max(10 s, 4 x estimate)', () => {
    expect(phononWatchdogMs('short')).toBe(10_000);
    expect(phononWatchdogMs('x'.repeat(250))).toBe(4 * 250 * 90);
  });

  it('times out, cancels, marks the engine broken for the process', async () => {
    const engine = await ready();
    jest.useFakeTimers();
    const done = engine.synthesize('Hello there.');
    await flush();
    const s = lastSynth();
    jest.advanceTimersByTime(10_000);
    const err = await done.catch(e => e);
    expect(err.code).toBe('ERR_PHONON_TIMEOUT');
    expect(fake.api.cancelUpTo).toHaveBeenCalledWith(s.requestId);
    expect(await engine.isReady()).toBe(false);
    expect(engine.getStatus().error).toContain('timed out');

    // Late result is released, never played.
    s.resolve({cancelled: false});
    await flush();
    expect(fake.liveBuffers()).toBe(0);
    expect(fake.api.playBuffer).not.toHaveBeenCalled();

    await expect(codeOf(engine.synthesize('Again.'))).resolves.toBe(
      'ERR_PHONON_TIMEOUT',
    );
    expect(() => engine.synthesizeStream()).toThrow('timed out');
    await expect(codeOf(new PhononEngine().initialize(CONFIG))).resolves.toBe(
      'ERR_PHONON_TIMEOUT',
    );
    // The device itself is still reported as supported.
    await expect(PhononEngine.getSupport()).resolves.toMatchObject({
      supported: true,
    });
  });

  it('after a timeout, release/destroy/reinit do not wait for the stuck worker', async () => {
    const engine = await ready();
    jest.useFakeTimers();
    const done = engine.synthesize('Hello there.');
    await flush();
    jest.advanceTimersByTime(10_000);
    await expect(codeOf(done)).resolves.toBe('ERR_PHONON_TIMEOUT');

    // Native destroy is queued behind the hung synth: it never settles.
    fake.state.hangDestroy = true;
    await expect(engine.release()).resolves.toMatchObject({success: true});
    expect(fake.api.destroy).toHaveBeenCalledTimes(1);

    // EngineManager.reinitializeEngine: destroy() then initialize().
    await engine.initialize(CONFIG).catch(() => {});
    await engine.destroy();
    await expect(codeOf(engine.initialize(CONFIG))).resolves.toBe(
      'ERR_PHONON_TIMEOUT',
    );
  });

  it('a destroy already waiting when the watchdog fires is abandoned', async () => {
    const engine = await ready();
    jest.useFakeTimers();
    const done = engine.synthesize('Hello there.');
    await flush();
    fake.state.hangDestroy = true;
    let released = false;
    const rel = engine.release().then(r => {
      released = true;
      return r;
    });
    await flush();
    await done;
    expect(released).toBe(false); // waiting on native destroy
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(released).toBe(true);
    await expect(rel).resolves.toMatchObject({success: true});
  });

  it('a create stuck behind a hung worker times out instead of loading forever', async () => {
    // e.g. after an RN reload: the JS broken flag is gone, the native worker is not.
    expect(phononCreateWatchdogMs(false)).toBe(120_000);
    expect(phononCreateWatchdogMs(true)).toBe(600_000);
    let lateCreate!: () => void;
    fake.api.create.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          lateCreate = () => resolve({...fake.state.load, handleId: 77});
        }),
    );
    jest.useFakeTimers();
    const engine = new PhononEngine();
    const init = engine.initialize(CONFIG);
    await flush();
    expect(engine.getStatus().isLoading).toBe(true);
    jest.advanceTimersByTime(120_000);
    await expect(codeOf(init)).resolves.toBe('ERR_PHONON_TIMEOUT');
    expect(engine.getStatus()).toMatchObject({isLoading: false});
    // A handle that shows up after the timeout is freed, never used.
    lateCreate();
    await flush();
    expect(fake.api.destroy).toHaveBeenCalledWith(77);
    await expect(codeOf(new PhononEngine().initialize(CONFIG))).resolves.toBe(
      'ERR_PHONON_TIMEOUT',
    );
  });

  it('a create that compiles Core ML gets the long budget', async () => {
    fake.api.needsCompile.mockResolvedValueOnce(true);
    let finish!: () => void;
    fake.api.create.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => resolve({...fake.state.load, handleId: 78});
        }),
    );
    jest.useFakeTimers();
    const engine = new PhononEngine();
    const init = engine.initialize(CONFIG);
    await flush();
    jest.advanceTimersByTime(300_000);
    await flush();
    finish();
    await init;
    expect(await engine.isReady()).toBe(true);
  });

  it('a late rejection after a timeout is ignored', async () => {
    const engine = await ready();
    jest.useFakeTimers();
    const done = engine.synthesize('Hello there.');
    await flush();
    const s = lastSynth();
    jest.advanceTimersByTime(10_000);
    await expect(codeOf(done)).resolves.toBe('ERR_PHONON_TIMEOUT');
    s.reject(new Error('late'));
    await flush();
  });

  it('a result within budget clears the timer', async () => {
    const engine = await ready();
    jest.useFakeTimers();
    fake.state.autoPlay = true;
    const done = engine.synthesize('Hello there.');
    await flush();
    lastSynth().resolve();
    await done;
    jest.advanceTimersByTime(60_000);
    expect(await engine.isReady()).toBe(true);
  });
});

describe('synthesizeStream', () => {
  it('requires initialize', () => {
    expect(() => new PhononEngine().synthesizeStream()).toThrow(
      'not initialized',
    );
  });

  it('plays appended text in order and finalizes', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    const progress: ChunkProgressEvent[] = [];
    engine.setChunkProgressCallback(e => progress.push(e));
    const stream = engine.synthesizeStream({voiceId: 'Marius'});
    stream.append('Hello there. ');
    stream.append('How are you today? ');
    stream.append('Fine.');
    await stream.finalize();
    expect(fake.synths.map(s => s.text.trim())).toEqual([
      'Hello there.',
      'How are you today?',
      'Fine.',
    ]);
    expect(fake.synths.every(s => s.voice === 'Marius')).toBe(true);
    expect(fake.plays).toHaveLength(3);
    expect(progress).toHaveLength(3);
    expect(engine.getLastMetrics()!.path).toBe('stream');
    expect(fake.liveBuffers()).toBe(0);
  });

  it('passes text through verbatim with stripMarkdown:false', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    const stream = engine.synthesizeStream({stripMarkdown: false});
    stream.append('**Bold** move.');
    await stream.finalize();
    expect(fake.synths[0]!.text).toContain('**');
  });

  it("honors firstChunk:'clause'", async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    const stream = engine.synthesizeStream({firstChunk: 'clause'});
    stream.append('Well, as I said before, this is it. The end.');
    await stream.finalize();
    expect(fake.synths[0]!.text.trim()).toBe('Well, as I said before,');
  });

  it('fires onAudioChunk with volume before each played chunk', async () => {
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    const engine = await ready();
    const seen: number[] = [];
    const stream = engine.synthesizeStream({
      volume: 0.5,
      onAudioChunk: b => seen.push(b.samples[0]!),
    });
    stream.append('One here. Two here.');
    await stream.finalize();
    expect(seen).toEqual([0.25, 0.25]);
    expect(fake.plays[0]!.config.volume).toBe(0.5);
  });

  it('stream.cancel() while synth #2 is pending cancels natively; nothing plays after', async () => {
    const engine = await ready({maxChunkSize: 25});
    const stream = engine.synthesizeStream();
    stream.append('First sentence here. Second sentence here. ');
    await flush();
    fake.synths[0]!.resolve();
    await flush();
    expect(fake.plays).toHaveLength(1);
    const second = fake.synths[1]!;

    await stream.cancel();
    expect(fake.api.cancelUpTo).toHaveBeenCalledWith(second.requestId);
    second.resolve();
    fake.plays[0]!.resolve();
    await flush();
    expect(fake.plays).toHaveLength(1);
    expect(fake.liveBuffers()).toBe(0);
  });

  it('cancel while the prefetch is in flight discards its buffer', async () => {
    const engine = await ready({maxChunkSize: 25});
    const stream = engine.synthesizeStream();
    stream.append('First sentence here. Second sentence here. ');
    await flush();
    fake.synths[0]!.resolve();
    await flush();
    const prefetch = fake.synths[1]!;
    await stream.cancel();
    // Native ignored the cancel and produced audio anyway.
    prefetch.resolve({cancelled: false});
    await flush();
    expect(fake.api.releaseBuffer).toHaveBeenCalled();
    expect(fake.liveBuffers()).toBe(0);
    expect(fake.plays).toHaveLength(1);
  });

  it('engine.stop() cancels the active stream', async () => {
    const engine = await ready();
    const stream = engine.synthesizeStream();
    stream.append('First sentence here. ');
    await flush();
    const s = lastSynth();
    await engine.stop();
    expect(fake.api.cancelUpTo).toHaveBeenCalledWith(s.requestId);
    s.resolve();
    await expect(stream.finalize()).resolves.toBeUndefined();
    expect(fake.plays).toHaveLength(0);
    expect(fake.liveBuffers()).toBe(0);
  });

  it('a second stream waits for the first to unwind', async () => {
    const engine = await ready();
    const first = engine.synthesizeStream();
    first.append('First stream text. ');
    await flush();
    const s1 = lastSynth();

    fake.state.autoPlay = true;
    const second = engine.synthesizeStream();
    expect(fake.api.cancelUpTo).toHaveBeenCalledWith(s1.requestId);
    second.append('Second stream text.');
    const fin = second.finalize();
    await flush();
    s1.resolve();
    await flush();
    const s2 = lastSynth();
    expect(s2.text.trim()).toBe('Second stream text.');
    s2.resolve();
    await fin;
    expect(fake.plays).toHaveLength(1);
    await first.cancel();
    expect(fake.liveBuffers()).toBe(0);
  });

  it('a stream superseded while waiting never reaches native', async () => {
    const engine = await ready();
    const first = engine.synthesizeStream();
    first.append('First stream text. ');
    await flush();
    const s1 = lastSynth();
    const second = engine.synthesizeStream();
    second.append('Second stream text. ');
    // Stop before the first stream has unwound: the waiting second
    // stream's chunk is stale by the time it could run.
    engine.stop();
    await flush();
    s1.resolve();
    await flush();
    await expect(second.finalize()).resolves.toBeUndefined();
    await first.cancel();
    expect(fake.synths).toHaveLength(1);
    expect(fake.plays).toHaveLength(0);
  });

  it('synthesize() during a stream cancels the stream', async () => {
    const engine = await ready();
    const stream = engine.synthesizeStream();
    stream.append('Streaming text. ');
    await flush();
    const s1 = lastSynth();
    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    await engine.synthesize('Spoken now.');
    expect(fake.api.cancelUpTo).toHaveBeenCalledWith(s1.requestId);
    s1.resolve();
    await stream.finalize();
    expect(fake.plays).toHaveLength(1);
    expect(fake.liveBuffers()).toBe(0);
  });

  it('reinitialize (destroy + initialize) during a stream', async () => {
    const engine = await ready();
    const stream = engine.synthesizeStream();
    stream.append('Streaming text here. ');
    await flush();
    const s1 = lastSynth();

    await engine.destroy();
    expect(fake.api.destroy).toHaveBeenCalledWith(s1.handleId);
    await engine.initialize(CONFIG);
    expect(fake.api.create).toHaveBeenCalledTimes(2);
    s1.reject(
      Object.assign(new Error('stale'), {code: 'PHONON_INVALID_HANDLE'}),
    );
    await expect(stream.finalize()).resolves.toBeUndefined();

    fake.state.autoSynth = true;
    fake.state.autoPlay = true;
    await engine.synthesize('After reinit.');
    expect(lastSynth().handleId).toBe(engine.getLoadInfo()!.handleId);
    expect(lastSynth().handleId).not.toBe(s1.handleId);
    expect(fake.plays).toHaveLength(1);
  });

  it('surfaces a synth failure through finalize()', async () => {
    const engine = await ready();
    const stream = engine.synthesizeStream();
    stream.append('Hello there.');
    const fin = stream.finalize();
    await flush();
    lastSynth().reject(
      Object.assign(new Error('bad'), {code: 'PHONON_CALLBACK_FAILED'}),
    );
    await expect(codeOf(fin)).resolves.toBe('ERR_PHONON_SYNTH');
  });
});

describe('release and destroy', () => {
  it('release of an uninitialized engine is a no-op success', async () => {
    await expect(new PhononEngine().release()).resolves.toEqual({
      success: true,
      partialRelease: false,
      errors: [],
    });
    expect(fake.api.destroy).not.toHaveBeenCalled();
  });

  it('refuses to release while loading', async () => {
    const engine = new PhononEngine();
    const init = engine.initialize(CONFIG);
    const result = await engine.release();
    expect(result.success).toBe(false);
    expect(result.errors[0]!.component).toBe('engine');
    await init;
  });

  it('reports a native destroy failure', async () => {
    const engine = await ready();
    fake.api.destroy.mockRejectedValueOnce(
      Object.assign(new Error('jni'), {code: 'PHONON_INTERNAL'}),
    );
    const result = await engine.release();
    expect(result.success).toBe(false);
    expect(result.partialRelease).toBe(true);
    expect(result.errors[0]!.component).toBe('handle');
    // Re-initializable afterwards.
    await engine.initialize(CONFIG);
    expect(await engine.isReady()).toBe(true);
  });

  it('swallows INVALID_HANDLE from destroy', async () => {
    const engine = await ready();
    fake.api.destroy.mockRejectedValueOnce(
      Object.assign(new Error('gone'), {code: 'PHONON_INVALID_HANDLE'}),
    );
    await expect(engine.release()).resolves.toMatchObject({success: true});
  });

  it('destroy tolerates native failure and an uninitialized engine', async () => {
    await new PhononEngine().destroy();
    expect(fake.api.destroy).not.toHaveBeenCalled();
    const engine = await ready();
    fake.api.destroy.mockRejectedValueOnce(new Error('x'));
    await engine.destroy();
    expect(await engine.isReady()).toBe(false);
  });
});

describe('helpers', () => {
  it('normalizePhononLanguage', () => {
    expect(normalizePhononLanguage('en-US')).toBe('en');
    expect(normalizePhononLanguage('pt_BR')).toBe('pt');
    expect(normalizePhononLanguage('DE')).toBe('de');
    expect(normalizePhononLanguage('')).toBe('');
  });

  it('allocRequestId returning 0 (not compiled) rejects unsupported', async () => {
    const engine = await ready();
    fake.api.allocRequestId.mockReturnValueOnce(0);
    await expect(codeOf(engine.synthesize('Hello.'))).resolves.toBe(
      'ERR_PHONON_UNSUPPORTED',
    );
  });
});
