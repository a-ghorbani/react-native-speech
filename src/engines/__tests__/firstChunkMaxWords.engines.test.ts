/**
 * Every built-in engine that supports `firstChunk: 'clause'` streaming
 * passes `firstChunkMaxWords` to both its markdown stream buffer and its
 * stream session. Model inference is stubbed; the first chunk is read from
 * the engine's chunk-progress events.
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

import {KokoroEngine} from '../kokoro/KokoroEngine';
import {KittenEngine} from '../kitten/KittenEngine';
import {SupertonicEngine} from '../supertonic/SupertonicEngine';
import type {ChunkProgressEvent, SynthesisOptions} from '../../types';

const SENTENCE =
  'Did you read the Anthropic article saying small models like us could spread into toasters and smart TVs? ';
const AUDIO = {
  samples: new Float32Array(240).fill(0.1),
  sampleRate: 24000,
  channels: 1,
  duration: 0.01,
};

type Stub = {
  setChunkProgressCallback(cb: ((e: ChunkProgressEvent) => void) | null): void;
  synthesizeStream(o?: SynthesisOptions): {
    append(t: string): void;
    finalize(): Promise<void>;
  };
};

const ENGINES: Array<[string, () => Stub]> = [
  [
    'Kokoro',
    () => {
      const e = new KokoroEngine() as any;
      e.isInitialized = true;
      e.session = {};
      e.synthesizeTextChunk = jest.fn(async () => AUDIO);
      return e;
    },
  ],
  [
    'Kitten',
    () => {
      const e = new KittenEngine() as any;
      e.isInitialized = true;
      e.session = {};
      e.synthesizeTextChunk = jest.fn(async () => AUDIO);
      return e;
    },
  ],
  [
    'Supertonic',
    () => {
      const e = new SupertonicEngine() as any;
      e.isInitialized = true;
      e.styleLoader = {getVoiceStyle: jest.fn(async () => ({}))};
      e.synthesizeChunk = jest.fn(async () => AUDIO);
      return e;
    },
  ],
];

async function firstChunk(
  make: () => Stub,
  options: SynthesisOptions,
): Promise<string> {
  const engine = make();
  const chunks: string[] = [];
  engine.setChunkProgressCallback(e => chunks.push(e.chunkText));
  const stream = engine.synthesizeStream(options);
  for (const tok of (SENTENCE + 'Next one.').match(/\S+\s*/g) ?? []) {
    stream.append(tok);
  }
  await stream.finalize();
  return chunks[0] ?? '';
}

describe.each(ENGINES)('%s synthesizeStream firstChunkMaxWords', (_n, make) => {
  test.each([true, false])(
    'a limit of 25 keeps the first sentence whole (stripMarkdown %p)',
    async stripMarkdown => {
      const first = await firstChunk(make, {
        firstChunk: 'clause',
        firstChunkMaxWords: 25,
        stripMarkdown,
      });
      expect(first.trim()).toBe(SENTENCE.trim());
    },
  );

  // Catches an engine that forgets to pass the limit to its markdown
  // buffer: the buffer would hold the text until word 12, so nothing is
  // ready after word 5 while the stream is still open.
  test.each([true, false])(
    'a limit of 5 cuts after word 5 before the sentence ends (stripMarkdown %p)',
    async stripMarkdown => {
      const engine = make();
      const chunks: string[] = [];
      engine.setChunkProgressCallback(e => chunks.push(e.chunkText));
      const stream = engine.synthesizeStream({
        firstChunk: 'clause',
        firstChunkMaxWords: 5,
        stripMarkdown,
      });
      for (const tok of SENTENCE.match(/\S+\s*/g)!.slice(0, 8)) {
        stream.append(tok);
      }
      await new Promise(r => setTimeout(r, 20));
      expect(chunks[0]).toBe('Did you read the Anthropic ');
      await stream.finalize();
    },
  );

  test('the default cuts at word 12', async () => {
    const first = await firstChunk(make, {firstChunk: 'clause'});
    expect(first.trim()).toBe(
      'Did you read the Anthropic article saying small models like us could',
    );
  });
});
