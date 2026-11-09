/**
 * #48: a streamed reply with commas and no sentence end reaches the engine
 * in short chunks while the stream is still open, through the markdown
 * stream buffer and the stream session. Inference is stubbed.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    play: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../phonemization', () => ({
  loadNativeDict: jest.fn(),
  TextPreprocessor: class {
    process(t: string) {
      return t;
    }
  },
}));

import {KittenEngine} from '../kitten/KittenEngine';

const COUNT = Array.from({length: 40}, (_, i) => `number ${i + 1}`).join(', ');
const AUDIO = {
  samples: new Float32Array(240).fill(0.1),
  sampleRate: 24000,
  channels: 1,
  duration: 0.01,
};

test.each([true, false])(
  'Kitten speaks comma-only text in maxChunkSize pieces before finalize (stripMarkdown %p)',
  async stripMarkdown => {
    const engine = new KittenEngine() as any;
    engine.isInitialized = true;
    engine.session = {};
    engine.synthesizeTextChunk = jest.fn(async () => AUDIO);
    const chunks: string[] = [];
    engine.setChunkProgressCallback((e: {chunkText: string}) =>
      chunks.push(e.chunkText),
    );
    const stream = engine.synthesizeStream({
      firstChunk: 'clause',
      stripMarkdown,
    });
    // Yield after each append, as tokens arriving from an LLM would.
    for (let i = 0; i < COUNT.length; i += 6) {
      stream.append(COUNT.slice(i, i + 6));
      await new Promise(r => setTimeout(r, 0));
    }
    const spokenWhileOpen = chunks.join('').length;
    await stream.finalize();

    // Kitten's default maxChunkSize is 200: past the first clause, a
    // ~200-char chunk is spoken before the stream ends.
    expect(spokenWhileOpen - chunks[0]!.length).toBeGreaterThan(150);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join('').replace(/\s+/g, ' ').trim()).toBe(COUNT);
  },
);
