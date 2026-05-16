/**
 * Supertonic Engine smoke + error-path tests.
 *
 * Mocks ONNX Runtime and the asset loader so the 4-model pipeline
 * can be exercised without real model files.
 */

const mockSessionRelease = jest.fn().mockResolvedValue(undefined);
const mockSessionRun = jest.fn();
const mockSessionCreate = jest.fn(async () => ({
  inputNames: [],
  outputNames: [],
  run: mockSessionRun,
  release: mockSessionRelease,
}));

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

const mockLoadAssetAsJSON = jest.fn();
jest.mock('../../../utils/AssetLoader', () => ({
  loadAssetAsJSON: (...args: unknown[]) => mockLoadAssetAsJSON(...args),
  loadAssetAsText: jest.fn(),
  loadAssetAsArrayBuffer: jest.fn(),
}));

import {SupertonicEngine} from '../SupertonicEngine';
import type {SupertonicConfig} from '../../../types/Supertonic';
import type {TTSEngine} from '../../../types';

// Minimal valid voice manifest + style data.
const voiceManifest = {voices: ['F1'], baseUrl: 'file:///fake/voices/'};
const voiceStyle = {
  style_dp: Array.from({length: 128}, () => 0.1),
  style_ttl: Array.from({length: 12800}, () => 0.05),
};
// Unicode indexer is an array where index = code point, value = vocab index.
const unicodeIndexer = new Array(256).fill(-1);
for (let i = 32; i < 127; i++) unicodeIndexer[i] = i - 32;

function resetSessionCreate() {
  mockSessionCreate.mockReset();
  mockSessionCreate.mockImplementation(async () => ({
    inputNames: [],
    outputNames: [],
    run: mockSessionRun,
    release: mockSessionRelease,
  }));
}

function configureAssetLoader() {
  mockLoadAssetAsJSON.mockImplementation(async (path: string) => {
    if (path.includes('unicode')) return unicodeIndexer;
    if (path.includes('manifest')) return voiceManifest;
    if (path.includes('voices')) return voiceManifest;
    return voiceStyle;
  });
}

const validConfig: SupertonicConfig = {
  durationPredictorPath: '/fake/dp.onnx',
  textEncoderPath: '/fake/te.onnx',
  vectorEstimatorPath: '/fake/ve.onnx',
  vocoderPath: '/fake/voc.onnx',
  unicodeIndexerPath: '/fake/unicode_indexer.json',
  voicesPath: '/fake/voices-manifest.json',
};

describe('SupertonicEngine - construction & identity', () => {
  it('constructor does not throw', () => {
    expect(() => new SupertonicEngine()).not.toThrow();
  });

  it('identifies itself as supertonic engine', () => {
    const e = new SupertonicEngine();
    expect(e.name).toBe('supertonic' as TTSEngine);
  });
});

describe('SupertonicEngine - initialize() error paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSessionCreate();
    configureAssetLoader();
  });

  it('rejects when called with no config', async () => {
    const e = new SupertonicEngine();
    await expect(e.initialize(undefined)).rejects.toThrow(
      /Supertonic config required/,
    );
  });

  it('rejects when ONNX model files cannot be loaded', async () => {
    mockSessionCreate.mockRejectedValue(new Error('missing model'));
    const e = new SupertonicEngine();
    await expect(e.initialize(validConfig)).rejects.toThrow(
      /Failed to load Supertonic models/,
    );
  });

  it('rejects when voices manifest is malformed', async () => {
    mockLoadAssetAsJSON.mockImplementation(async (path: string) => {
      if (path.includes('unicode')) return unicodeIndexer;
      throw new Error('bad json');
    });
    const e = new SupertonicEngine();
    await expect(e.initialize(validConfig)).rejects.toThrow(
      /Failed to load voices/,
    );
  });

  it('rejects when synthesize is called before initialize', async () => {
    const e = new SupertonicEngine();
    await expect(e.synthesize('hello')).rejects.toThrow(/not initialized/);
  });
});

describe('SupertonicEngine - successful initialize() & lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSessionCreate();
    configureAssetLoader();
  });

  it('calls InferenceSession.create once for each of the 4 models', async () => {
    const e = new SupertonicEngine();
    await e.initialize(validConfig);
    expect(mockSessionCreate).toHaveBeenCalledTimes(4);
    const paths = mockSessionCreate.mock.calls.map(
      c => (c as unknown as unknown[])[0],
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        validConfig.durationPredictorPath,
        validConfig.textEncoderPath,
        validConfig.vectorEstimatorPath,
        validConfig.vocoderPath,
      ]),
    );
  });

  it('release() resolves with {success, partialRelease, errors} shape', async () => {
    const e = new SupertonicEngine();
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
    const e = new SupertonicEngine();
    const result = await e.release();
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects phoneme input — no IPA-in path on Supertonic', async () => {
    const e = new SupertonicEngine();
    await e.initialize(validConfig);
    await expect(
      e.synthesize({phonemes: 'həˈloʊ'}, {voiceId: 'default'}),
    ).rejects.toThrow(/phoneme input requires the Kokoro or Kitten engine/);
  });
});
