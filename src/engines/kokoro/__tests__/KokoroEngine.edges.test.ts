/**
 * KokoroEngine edge silence (#79). Fixtures are real Kokoro-82M int8
 * (model_quantized.onnx) outputs on af_bella: "Ok." and "Few, fish, and
 * fifty thieves, hush." (fricative onset). Each carries ~0.4 s of zeros
 * and a -70 dB bed before speech and ~0.55 s of decay, bed and zeros
 * after it.
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
  return e;
}

const {readFileSync} = require('fs');
const {join} = require('path');
const {neuralAudioPlayer} = require('../../NeuralAudioPlayer');
const HOP = 240;

const fixture = (name: string): Float32Array => {
  const buf: Buffer = readFileSync(join(__dirname, '__fixtures__', name));
  const n = (buf.length - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(44 + i * 2) / 32767;
  return out;
};
const frameDb = (s: Float32Array): number[] => {
  const rms: number[] = [];
  for (let i = 0; i + HOP <= s.length; i += HOP) {
    let acc = 0;
    for (let j = i; j < i + HOP; j++) acc += s[j]! ** 2;
    rms.push(Math.sqrt(acc / HOP));
  }
  const peak = Math.max(...rms);
  return rms.map(r => 20 * Math.log10(Math.max(r, 1e-9) / peak));
};
// Lead/trail as #79 measured them: ms of 10 ms frames below -30 dB of the peak frame.
const edgesMs = (s: Float32Array) => {
  const db = frameDb(s);
  const first = db.findIndex(v => v > -30);
  let last = db.length - 1;
  while (db[last]! <= -30) last--;
  return {lead: first * 10, trail: (db.length - 1 - last) * 10};
};
const played = (): Float32Array[] =>
  (neuralAudioPlayer.play as jest.Mock).mock.calls.map(c => c[0].samples);
const OK = 'kokoro-int8-bella-ok.wav';
const FEW = 'kokoro-int8-bella-few-fish.wav';

describe('KokoroEngine - edge silence (#79)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssets();
  });

  test.each([OK, FEW])(
    'speak(): %s plays with at most 150 ms lead and 250 ms trail',
    async name => {
      mockSessionRun.mockResolvedValue({waveform: {data: fixture(name)}});
      const e = await initEngine();
      await e.synthesize('Ok.', {voiceId: 'af_bella'});

      const [out] = played();
      const {lead, trail} = edgesMs(out!);
      expect(lead).toBeLessThanOrEqual(150);
      expect(trail).toBeLessThanOrEqual(250);
    },
  );

  test.each([OK, FEW])(
    '%s: everything from 5 dB under the trim threshold inward plays unchanged',
    async name => {
      const model = fixture(name);
      const db = frameDb(model);
      const a = db.findIndex(v => v > -40) * HOP;
      let b = db.length - 1;
      while (db[b]! <= -40) b--;
      const speech = model.slice(a, (b + 1) * HOP);

      mockSessionRun.mockResolvedValue({waveform: {data: model}});
      const e = await initEngine();
      await e.synthesize('Ok.', {voiceId: 'af_bella'});

      const [out] = played();
      let at = -1;
      for (let s = 0; s + speech.length <= out!.length && at < 0; s++) {
        if (speech.every((v, k) => out![s + k] === v)) at = s;
      }
      expect(at).toBeGreaterThanOrEqual(0);
    },
  );

  test('stream: chunks are trimmed too', async () => {
    mockSessionRun.mockImplementation(async () => ({
      waveform: {data: fixture(OK)},
    }));
    const e = new KokoroEngine();
    await e.initialize({...validConfig, maxChunkSize: 12});
    const handle = e.synthesizeStream({voiceId: 'af_bella'});
    handle.append('Ok. Fine then. ');
    await handle.finalize();

    expect(played().length).toBe(2);
    for (const out of played()) {
      expect(edgesMs(out).lead).toBeLessThanOrEqual(150);
      expect(edgesMs(out).trail).toBeLessThanOrEqual(250);
    }
  });

  test('a fully silent chunk still plays and does not end the utterance', async () => {
    mockSessionRun.mockImplementation(async () => ({
      waveform: {data: new Float32Array(24000)},
    }));
    const e = new KokoroEngine();
    await e.initialize({...validConfig, maxChunkSize: 12});
    await e.synthesize('First one. Second one.', {voiceId: 'af_bella'});

    expect(played().map(s => s.length)).toEqual([24000, 24000]);
  });
});
