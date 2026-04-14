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
