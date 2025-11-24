/**
 * Kokoro Engine Tests
 */

import {BPETokenizer} from '../engines/kokoro/BPETokenizer';
import {VoiceLoader} from '../engines/kokoro/VoiceLoader';

describe('BPETokenizer', () => {
  let tokenizer: BPETokenizer;

  beforeEach(() => {
    tokenizer = new BPETokenizer();
  });

  it('should initialize with vocab and merges', async () => {
    const vocab = {
      '<unk>': 0,
      '<s>': 1,
      '</s>': 2,
      '<pad>': 3,
      '▁': 4,
      h: 5,
      e: 6,
      l: 7,
      o: 8,
    };

    const merges = ['h e', 'l l', 'he l', 'o ▁'];

    await tokenizer.loadFromData(vocab, merges);

    expect(tokenizer.isReady()).toBe(true);
  });

  it('should encode simple text', async () => {
    const vocab = {
      '<unk>': 0,
      '<s>': 1,
      '</s>': 2,
      '<pad>': 3,
      '▁': 4,
      h: 5,
      e: 6,
      l: 7,
      o: 8,
      hello: 9,
    };

    const merges: string[] = [];

    await tokenizer.loadFromData(vocab, merges);

    const tokens = tokenizer.encode('hello');
    expect(tokens).toBeDefined();
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('should decode tokens back to text', async () => {
    const vocab = {
      '<unk>': 0,
      '<s>': 1,
      '</s>': 2,
      '<pad>': 3,
      '▁hello': 4,
    };

    await tokenizer.loadFromData(vocab, []);

    const tokens = [4];
    const text = tokenizer.decode(tokens);
    expect(text).toContain('hello');
  });

  it('should handle unknown tokens', async () => {
    const vocab = {
      '<unk>': 0,
      '<s>': 1,
      '</s>': 2,
      '<pad>': 3,
    };

    await tokenizer.loadFromData(vocab, []);

    const tokens = tokenizer.encode('xyz');
    expect(tokens).toContain(0); // Should contain <unk> token
  });
});

describe('VoiceLoader', () => {
  let voiceLoader: VoiceLoader;

  beforeEach(() => {
    voiceLoader = new VoiceLoader();
  });

  it('should load voices from JSON', async () => {
    const voicesData = {
      af_bella: new Array(256).fill(0.5),
      am_michael: new Array(256).fill(0.3),
    };

    await voiceLoader.loadFromJSON(voicesData);

    expect(voiceLoader.isReady()).toBe(true);

    const voices = voiceLoader.getAvailableVoices();
    expect(voices.length).toBe(2);
    expect(voices[0]!.id).toBe('af_bella');
    expect(voices[0]!.gender).toBe('female');
    expect(voices[1]!.id).toBe('am_michael');
    expect(voices[1]!.gender).toBe('male');
  });

  //it('should get voice embedding', async () => {
  //  const embeddingData = new Array(256).fill(0.5);
  //  const voicesData = {
  //    af_bella: embeddingData,
  //  };

  //  await voiceLoader.loadFromJSON(voicesData);

  //  const embedding = voiceLoader.getVoiceEmbedding('af_bella');
  //  expect(embedding).toBeInstanceOf(Float32Array);
  //  expect(embedding.length).toBe(256);
  //  expect(embedding[0]).toBe(0.5);
  //});

  // it('should blend multiple voices', async () => {
  //   const voicesData = {
  //     af_bella: new Array(256).fill(1.0),
  //     af_sarah: new Array(256).fill(0.0),
  //   };

  //   await voiceLoader.loadFromJSON(voicesData);

  //   const blended = voiceLoader.blendVoices(
  //     ['af_bella', 'af_sarah'],
  //     [0.5, 0.5],
  //   );

  //   expect(blended).toBeInstanceOf(Float32Array);
  //   expect(blended.length).toBe(256);
  //   expect(blended[0]).toBeCloseTo(0.5, 1); // Average of 1.0 and 0.0
  // });

  it('should filter voices by language', async () => {
    const voicesData = {
      af_bella: new Array(256).fill(0.5), // English
      zh_f1: new Array(256).fill(0.3), // Chinese
    };

    await voiceLoader.loadFromJSON(voicesData);

    const englishVoices = voiceLoader.getAvailableVoices('en');
    expect(englishVoices.length).toBe(1);
    expect(englishVoices[0]!.language).toBe('en');

    const chineseVoices = voiceLoader.getAvailableVoices('zh');
    expect(chineseVoices.length).toBe(1);
    expect(chineseVoices[0]!.language).toBe('zh');
  });

  it('should throw error for non-existent voice', async () => {
    const voicesData = {
      af_bella: new Array(256).fill(0.5),
    };

    await voiceLoader.loadFromJSON(voicesData);

    expect(() => {
      voiceLoader.getVoiceEmbedding('non_existent');
    }).toThrow();
  });
});

describe('Engine Integration', () => {
  it('should create tokenizer and voice loader', () => {
    const tokenizer = new BPETokenizer();
    const voiceLoader = new VoiceLoader();

    expect(tokenizer).toBeDefined();
    expect(voiceLoader).toBeDefined();
  });
});
