/**
 * Kitten Engine smoke + error-path tests.
 *
 * These tests mock `onnxruntime-react-native`, the native dict loader,
 * and the asset loader so the engine can be exercised without any real
 * model files or native modules.
 */

const mockSessionRelease = jest.fn().mockResolvedValue(undefined);
const mockSessionRun = jest.fn();
const mockSessionCreate = jest.fn(async () => ({
  inputNames: ['input_ids', 'style', 'speed'],
  outputNames: ['waveform'],
  run: mockSessionRun,
  release: mockSessionRelease,
}));

jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});

jest.mock('../../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    play: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock(
  'onnxruntime-react-native',
  () => ({
    InferenceSession: {create: mockSessionCreate},
    Tensor: jest.fn().mockImplementation((_t, data, dims) => ({data, dims})),
  }),
  {virtual: true},
);

// Stub the native dict pipeline so initialize() doesn't try to mmap.
// Keep this flat (no requireActual) — pulling in the real module would
// drag NativeSpeech / TurboModuleRegistry into the test runtime.
const stubDictSource = {
  lookup: () => null,
  hasWord: () => false,
  size: () => 0,
};
const stubPreprocessor = class {
  process(t: string) {
    return t;
  }
};
jest.mock('../../../phonemization', () => ({
  loadNativeDict: jest.fn(async () => stubDictSource),
  loadDict: jest.fn(async () => stubDictSource),
  TextPreprocessor: stubPreprocessor,
  chunkText: (t: string) => [t],
  HansPhonemizer: class {},
}));

// Stub asset loading for tokenizer/voices.
const mockLoadAssetAsJSON = jest.fn();
jest.mock('../../../utils/AssetLoader', () => ({
  loadAssetAsJSON: (...args: unknown[]) => mockLoadAssetAsJSON(...args),
  loadAssetAsText: jest.fn(),
  loadAssetAsArrayBuffer: jest.fn(),
}));

import {KittenEngine} from '../KittenEngine';
import type {KittenConfig} from '../../../types/Kitten';
import type {TTSEngine} from '../../../types';

const validConfig: KittenConfig = {
  modelPath: '/fake/model.onnx',
  voicesPath: '/fake/voices.json',
  dictPath: '/fake/dict.bin',
};

const sampleVoiceData = {
  'expr-voice-2-f': {
    embeddings: [Array.from({length: 256}, () => 0.1)],
    shape: [1, 256],
  },
  'expr-voice-2-m': {
    embeddings: [Array.from({length: 256}, () => 0.2)],
    shape: [1, 256],
  },
};

describe('KittenEngine - construction & identity', () => {
  it('constructor does not throw', () => {
    expect(() => new KittenEngine()).not.toThrow();
  });

  it('identifies itself as kitten engine', () => {
    const e = new KittenEngine();
    expect(e.name).toBe('kitten' as TTSEngine);
  });
});

describe('KittenEngine - initialize() error paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAssetAsJSON.mockResolvedValue(sampleVoiceData);
  });

  it('rejects when called with no config', async () => {
    const e = new KittenEngine();
    await expect(e.initialize(undefined)).rejects.toThrow(
      /Kitten config required/,
    );
  });

  it('rejects when dictPath is missing', async () => {
    const e = new KittenEngine();
    await expect(
      e.initialize({
        modelPath: '/fake/model.onnx',
        voicesPath: '/fake/voices.json',
      } as KittenConfig),
    ).rejects.toThrow(/dictPath/);
  });

  it('rejects when ONNX session create fails (missing/corrupt model)', async () => {
    mockSessionCreate.mockRejectedValueOnce(new Error('file not found'));
    // CPU fallback also fails to surface a final rejection.
    mockSessionCreate.mockRejectedValueOnce(new Error('still missing'));
    const e = new KittenEngine();
    await expect(e.initialize(validConfig)).rejects.toThrow(
      /Failed to load ONNX model/,
    );
  });

  it('wraps malformed voices JSON in a clear error', async () => {
    mockLoadAssetAsJSON.mockRejectedValueOnce(new Error('bad json'));
    const e = new KittenEngine();
    await expect(e.initialize(validConfig)).rejects.toThrow(
      /Failed to load voices/,
    );
  });
});

describe('KittenEngine - successful initialize() & lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAssetAsJSON.mockResolvedValue(sampleVoiceData);
  });

  it('calls InferenceSession.create exactly once with the model path', async () => {
    const e = new KittenEngine();
    await e.initialize(validConfig);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    const firstCall = mockSessionCreate.mock.calls[0] as unknown as unknown[];
    expect(firstCall[0]).toBe(validConfig.modelPath);
  });

  it('getAvailableVoices returns a non-empty array post-init', async () => {
    const e = new KittenEngine();
    await e.initialize(validConfig);
    const voices = await e.getAvailableVoices();
    expect(Array.isArray(voices)).toBe(true);
    expect(voices.length).toBeGreaterThan(0);
  });

  it('synthesize before initialize throws "not initialized"', async () => {
    const e = new KittenEngine();
    await expect(e.synthesize('hi')).rejects.toThrow(/not initialized/);
  });

  it('release() resolves with {success, partialRelease, errors} shape', async () => {
    const e = new KittenEngine();
    await e.initialize(validConfig);
    const result = await e.release();
    expect(result).toEqual(
      expect.objectContaining({
        success: expect.any(Boolean),
        partialRelease: expect.any(Boolean),
        errors: expect.any(Array),
      }),
    );
    expect(result.success).toBe(true);
  });

  it('release() before initialize is a no-op success', async () => {
    const e = new KittenEngine();
    const result = await e.release();
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Streaming guard for no-content chunks
//
// Kitten's BERT expand op crashes on near-empty inputs ("invalid expand
// shape"). When the markdown stream buffer flushes an isolated horizontal
// rule as `.\n`, StreamingChunker can emit a 2-char chunk that hits this
// crash. KittenEngine.synthesizeTextChunk must short-circuit those chunks
// to an empty AudioBuffer BEFORE invoking ONNX so the model is never fed
// garbage. The session layer is responsible for skipping the empty buffer
// and pulling the next chunk (covered in EngineStreamSession.test.ts).
// ─────────────────────────────────────────────────────────────────────────
describe('KittenEngine - streaming guards no-content chunks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAssetAsJSON.mockResolvedValue(sampleVoiceData);
  });

  // We only need to verify that ONNX inference is NEVER triggered for
  // these chunks. Anything else (audio playback, finalize) is bonus
  // because those are session/player concerns covered elsewhere.
  test.each([
    ['lone period', '.'],
    ['period + space', '. '],
    ['period + newline (the actual hrule artifact)', '.\n'],
    ['whitespace only', '   '],
    ['punctuation only', '!?,.'],
  ])('skips ONNX inference for chunk of %s', async (_label, chunk) => {
    const e = new KittenEngine();
    await e.initialize(validConfig);
    mockSessionRun.mockClear();

    const handle = e.synthesizeStream({voiceId: 'expr-voice-2-f'});
    handle.append(chunk);
    await handle.finalize();

    // The guard must short-circuit before ONNX. If a future change
    // accidentally removes it, this test fires loudly with the same
    // "invalid expand shape" symptom we'd see on device.
    expect(mockSessionRun).not.toHaveBeenCalled();
  });

  test('oversized splittable chunk is broken down and each piece synthesized', async () => {
    // Real text with clauses — splitOversizedSource splits on `,`/`;`/`:`.
    // Each piece should fit under MAX_PHONEME_TOKENS individually.
    mockSessionRun.mockResolvedValue({
      waveform: {data: new Float32Array(2400), dims: [1, 2400]},
    });

    const e = new KittenEngine();
    await e.initialize(validConfig);
    mockSessionRun.mockClear();

    // Build 600+ chars of clauseable text (well over the 480 token cap).
    // Each clause is ~50 chars, fits comfortably under the cap.
    const longText = Array.from(
      {length: 14},
      (_, i) => `clause number ${i} with some real content`,
    ).join(', ');
    const handle = e.synthesizeStream({voiceId: 'expr-voice-2-f'});
    handle.append(longText + '. ');
    await handle.finalize();

    // The engine recurses: original chunk hits the cap, gets split, each
    // piece is synthesized. So mockSessionRun fires multiple times for
    // ONE input chunk — the user hears the entire content instead of
    // dropping the chunk on the floor.
    expect(mockSessionRun.mock.calls.length).toBeGreaterThan(1);
  });

  test('truly unsplittable oversized chunk is dropped (no infinite recursion)', async () => {
    // A single 600-char "word" (no whitespace, no clause punctuation)
    // can't be split. The recursion must terminate by returning empty
    // rather than looping forever on the same input.
    const e = new KittenEngine();
    await e.initialize(validConfig);
    mockSessionRun.mockClear();

    const handle = e.synthesizeStream({voiceId: 'expr-voice-2-f'});
    handle.append('a'.repeat(600) + '. ');
    await handle.finalize();

    // ONNX never invoked for an unsplittable oversized chunk — the
    // engine drops it rather than crash on the BERT expand op.
    expect(mockSessionRun).not.toHaveBeenCalled();
  });

  test('oversized chunk in middle of stream: session continues past it', async () => {
    // The on-device crash pattern, post-fix: an oversized chunk used to
    // throw and end the session. Now it gets split-and-synthesized; if
    // even that fails (unsplittable), it returns empty and the session
    // skips to the next chunk. Either way, "Short end" must play.
    mockSessionRun.mockResolvedValue({
      waveform: {data: new Float32Array(2400), dims: [1, 2400]},
    });

    const e = new KittenEngine();
    await e.initialize(validConfig);
    mockSessionRun.mockClear();

    const handle = e.synthesizeStream({voiceId: 'expr-voice-2-f'});
    handle.append('Short start. ');
    handle.append('a'.repeat(600) + '. '); // unsplittable oversized → drop
    handle.append('Short end. ');
    await handle.finalize();

    // Two short chunks synthesize normally (1 ONNX run each); the
    // oversized middle is unsplittable so it's dropped (0 ONNX runs).
    // Pre-fix behavior: the oversized chunk would throw, the session
    // would end, and "Short end" would never play.
    expect(mockSessionRun).toHaveBeenCalledTimes(2);
  });

  test('content chunk after a no-content chunk still synthesizes', async () => {
    // Verifies the engine doesn't get "stuck" after a skipped chunk —
    // EngineStreamSession should pull the next one and the guard should
    // not fire for it. mockSessionRun returns a fake waveform.
    mockSessionRun.mockResolvedValue({
      waveform: {data: new Float32Array(2400), dims: [1, 2400]},
    });

    const e = new KittenEngine();
    await e.initialize(validConfig);
    mockSessionRun.mockClear();

    const handle = e.synthesizeStream({voiceId: 'expr-voice-2-f'});
    // No-content chunk first (would have crashed pre-fix), then real
    // content. Use ` Hello world. ` so the chunker treats them as
    // separate sentences.
    handle.append('. ');
    handle.append('Hello world. ');
    await handle.finalize();

    // ONNX ran for the content chunk — at least once. Pre-fix, the
    // session would have ended at the empty bootstrap and the content
    // chunk would never have been synthesized.
    expect(mockSessionRun).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phoneme input (g2p short-circuit)
//
// `synthesize({ phonemes })` must feed the IPA straight to the tokenizer:
// the phonemizer is never invoked, the string is a single chunk (no
// sentence splitting), and ONNX still runs. Text input keeps running g2p.
// ─────────────────────────────────────────────────────────────────────────
describe('KittenEngine - phoneme input bypasses g2p', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAssetAsJSON.mockResolvedValue(sampleVoiceData);
    mockSessionRun.mockResolvedValue({
      waveform: {data: new Float32Array(2400), dims: [1, 2400]},
    });
  });

  it('does not call the phonemizer and still runs ONNX', async () => {
    const e = new KittenEngine();
    await e.initialize(validConfig);
    const spy = jest.spyOn(
      (e as unknown as {phonemizer: {phonemize: () => Promise<string>}})
        .phonemizer,
      'phonemize',
    );
    mockSessionRun.mockClear();

    await e.synthesize(
      {phonemes: 'həˈloʊ wˈɜːld'},
      {voiceId: 'expr-voice-2-f'},
    );

    expect(spy).not.toHaveBeenCalled();
    expect(mockSessionRun).toHaveBeenCalledTimes(1);
  });

  it('treats the IPA as a single chunk (no sentence splitting on ".")', async () => {
    const e = new KittenEngine();
    await e.initialize(validConfig);
    mockSessionRun.mockClear();

    // Periods in IPA must NOT trigger sentence chunking — one ONNX run.
    await e.synthesize(
      {phonemes: 'fˈɜːst. sˈɛkənd. θˈɜːd.'},
      {voiceId: 'expr-voice-2-f'},
    );

    expect(mockSessionRun).toHaveBeenCalledTimes(1);
  });

  it('rejects empty phoneme input', async () => {
    const e = new KittenEngine();
    await e.initialize(validConfig);
    await expect(
      e.synthesize({phonemes: '   '}, {voiceId: 'expr-voice-2-f'}),
    ).rejects.toThrow(/Input cannot be empty/);
  });

  it('still runs g2p for plain text input (unchanged behaviour)', async () => {
    const e = new KittenEngine();
    await e.initialize(validConfig);
    const spy = jest.spyOn(
      (e as unknown as {phonemizer: {phonemize: () => Promise<string>}})
        .phonemizer,
      'phonemize',
    );
    mockSessionRun.mockClear();

    await e.synthesize('hello world', {voiceId: 'expr-voice-2-f'});

    expect(spy).toHaveBeenCalled();
  });
});
