/**
 * KokoroEngine Mandarin voices (#14): Chinese is opt-in through the
 * `@pocketpalai/react-native-speech/zh` entry. Without it a zh voice fails
 * with an error naming the import; with it the chunk goes through the zh
 * G2P, and only the Latin runs reach the English phonemizer.
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
  zf_xiaoxiao: new Array(130560).fill(0.1),
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

describe('KokoroEngine - Mandarin voices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssets();
    mockSessionRun.mockResolvedValue({
      waveform: {data: new Float32Array(2400), dims: [1, 2400]},
    });
  });

  it('rejects a zh voice with an error naming the opt-in import when zh is not registered', async () => {
    const e = await initEngine();
    await expect(
      e.synthesize('你好。', {voiceId: 'zf_xiaoxiao'}),
    ).rejects.toThrow("import '@pocketpalai/react-native-speech/zh'");
    expect(mockSessionRun).not.toHaveBeenCalled();
  });

  it('a zh stream without the zh import fails at once, not at finalize', async () => {
    const e = await initEngine();
    expect(() => e.synthesizeStream({voiceId: 'zf_xiaoxiao'})).toThrow(
      "import '@pocketpalai/react-native-speech/zh'",
    );
  });

  it('phoneme input on a zh voice still works without the zh import', async () => {
    const e = await initEngine();
    await e.synthesize({phonemes: 'ni↓xau↓'}, {voiceId: 'zf_xiaoxiao'});
    expect(mockPhonemize).not.toHaveBeenCalled();
    expect(mockSessionRun).toHaveBeenCalledTimes(1);
  });

  it('after the zh import, Chinese goes through the zh G2P and Latin runs through English', async () => {
    require('../../../zh');
    const e = await initEngine();
    await e.synthesize('我们有 2 个 CEO。', {voiceId: 'zf_xiaoxiao'});
    expect(mockPhonemize).toHaveBeenCalledTimes(1);
    expect(mockPhonemize).toHaveBeenCalledWith('CEO.', 'en-us');
    expect(mockSessionRun).toHaveBeenCalledTimes(1);
  });

  it('English voices are unaffected by the zh import', async () => {
    require('../../../zh');
    const e = await initEngine();
    await e.synthesize('Hello there.', {voiceId: 'af_bella'});
    expect(mockPhonemize).toHaveBeenCalledWith('Hello there.', 'en-us');
  });
});
