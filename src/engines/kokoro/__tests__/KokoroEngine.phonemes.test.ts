/**
 * KokoroEngine phoneme-input tests (g2p short-circuit).
 *
 * `synthesize({ phonemes })` must feed the IPA straight to the
 * tokenizer: the phonemizer is never invoked, the string is a single
 * chunk (no sentence splitting on '.'), and ONNX still runs. Oversized
 * phoneme input warns about the model token cap but is NOT split —
 * still one ONNX run. Text input keeps running the full g2p pipeline.
 *
 * Mirrors the KittenEngine phoneme suite; mocks `onnxruntime-react-native`,
 * the native dict loader, the HansPhonemizer, and the asset loader so the
 * engine runs without real model files or native modules.
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
jest.mock('../../../phonemization', () => ({
  loadNativeDict: jest.fn(async () => stubDictSource),
  loadDict: jest.fn(async () => stubDictSource),
}));

// Kokoro's createPhonemizer('js') lazily requires HansPhonemizer; give it
// a mock whose phonemize fn we can assert against.
const mockPhonemize = jest.fn(async (text: string, _language: string) => text);
jest.mock('../../../phonemization/HansPhonemizer', () => ({
  HansPhonemizer: class {
    phonemize(text: string, language: string) {
      return mockPhonemize(text, language);
    }
  },
}));

// Stub asset loading for tokenizer/voices.
const mockLoadAssetAsJSON = jest.fn();
const mockLoadAssetAsText = jest.fn();
jest.mock('../../../utils/AssetLoader', () => ({
  loadAssetAsJSON: (...args: unknown[]) => mockLoadAssetAsJSON(...args),
  loadAssetAsText: (...args: unknown[]) => mockLoadAssetAsText(...args),
  loadAssetAsArrayBuffer: jest.fn(),
}));

import {KokoroEngine} from '../KokoroEngine';
import type {KokoroConfig} from '../../../types/Kokoro';

const validConfig: KokoroConfig = {
  modelPath: '/fake/model.onnx',
  voicesPath: '/fake/voices.json',
  vocabPath: '/fake/vocab.json',
  mergesPath: '/fake/merges.txt',
  dictPath: '/fake/dict.bin',
  phonemizerType: 'js',
};

// A voice file is 510 style embeddings × 256 floats.
const sampleVoiceData = {
  af_bella: new Array(130560).fill(0.1),
};

// Minimal vocab: unknown chars map to <unk>, one token per char — enough
// for the tokenizer to produce a non-empty (and countable) sequence.
const sampleVocab = {
  '<unk>': 0,
  '<s>': 1,
  '</s>': 2,
  '<pad>': 3,
};

function mockAssets() {
  mockLoadAssetAsJSON.mockImplementation(async (path: string) =>
    path.includes('voices') ? sampleVoiceData : sampleVocab,
  );
  mockLoadAssetAsText.mockResolvedValue('');
}

async function initEngine(): Promise<KokoroEngine> {
  const e = new KokoroEngine();
  await e.initialize(validConfig);
  mockSessionRun.mockClear();
  mockPhonemize.mockClear();
  return e;
}

describe('KokoroEngine - phoneme input bypasses g2p', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssets();
    mockSessionRun.mockResolvedValue({
      waveform: {data: new Float32Array(2400), dims: [1, 2400]},
    });
  });

  it('does not call the phonemizer and still runs ONNX', async () => {
    const e = await initEngine();

    await e.synthesize({phonemes: 'həˈloʊ wˈɜːld'}, {voiceId: 'af_bella'});

    expect(mockPhonemize).not.toHaveBeenCalled();
    expect(mockSessionRun).toHaveBeenCalledTimes(1);
  });

  it('treats the IPA as a single chunk (no sentence splitting on ".")', async () => {
    const e = await initEngine();

    // Periods in IPA must NOT trigger sentence chunking — one ONNX run.
    await e.synthesize(
      {phonemes: 'fˈɜːst. sˈɛkənd. θˈɜːd.'},
      {voiceId: 'af_bella'},
    );

    expect(mockSessionRun).toHaveBeenCalledTimes(1);
  });

  it('oversized phoneme input warns about the token cap but is not split', async () => {
    const e = await initEngine();

    // ~600 tokens (one per char) — over MAX_TOKEN_LIMIT (500) and over
    // DEFAULT_MAX_CHUNK_SIZE (400 chars). Text input would be chunked;
    // phoneme input must stay one chunk: warn-and-proceed, 1 ONNX run.
    const oversized = 'ə'.repeat(600);
    await e.synthesize({phonemes: oversized}, {voiceId: 'af_bella'});

    expect(mockSessionRun).toHaveBeenCalledTimes(1);
  });

  it('rejects empty phoneme input', async () => {
    const e = await initEngine();
    await expect(
      e.synthesize({phonemes: '   '}, {voiceId: 'af_bella'}),
    ).rejects.toThrow(/Phonemes cannot be empty/);
  });

  it('rejects empty text input with the original message', async () => {
    const e = await initEngine();
    await expect(e.synthesize('   ', {voiceId: 'af_bella'})).rejects.toThrow(
      /Text cannot be empty/,
    );
  });

  it('still runs g2p for plain text input (unchanged behaviour)', async () => {
    const e = await initEngine();

    await e.synthesize('hello world', {voiceId: 'af_bella'});

    expect(mockPhonemize).toHaveBeenCalled();
    expect(mockSessionRun).toHaveBeenCalledTimes(1);
  });
});
