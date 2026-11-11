/**
 * Every built-in engine plays all chunks of one utterance (speak() or a
 * stream) with one token and ends that utterance once, so Android holds
 * audio focus across the chunks and releases it at the end (#133).
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    endUtterance: jest.fn(async () => {
      mockOrder.push('end');
    }),
    play: jest.fn(async () => {
      mockOrder.push('play');
    }),
    stop: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../phonemization', () => ({
  loadNativeDict: jest.fn(),
}));

import {KokoroEngine} from '../kokoro/KokoroEngine';
import {KittenEngine} from '../kitten/KittenEngine';
import {SupertonicEngine} from '../supertonic/SupertonicEngine';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';

const mockOrder: string[] = [];
const player = neuralAudioPlayer as unknown as Record<string, jest.Mock>;

const TEXT =
  'The river ran past the old mill where the children used to play. ' +
  'Along the bank there were tall trees that gave shade to walkers. ' +
  'In spring the river rose and covered the low fields with water.';
const AUDIO = {
  samples: new Float32Array(240).fill(0.1),
  sampleRate: 24000,
  channels: 1,
  duration: 0.01,
};

type Engine = {
  synthesize(text: string): Promise<unknown>;
  synthesizeStream(): {append(t: string): void; finalize(): Promise<void>};
};

const ENGINES: Array<[string, (synth: jest.Mock) => Engine]> = [
  [
    'Kokoro',
    synth => {
      const e = new KokoroEngine() as any;
      e.isInitialized = true;
      e.session = {};
      e.config = {maxChunkSize: 70};
      e.synthesizeTextChunk = synth;
      return e;
    },
  ],
  [
    'Kitten',
    synth => {
      const e = new KittenEngine() as any;
      e.isInitialized = true;
      e.session = {};
      e.config = {maxChunkSize: 70};
      e.synthesizeTextChunk = synth;
      return e;
    },
  ],
  [
    'Supertonic',
    synth => {
      const e = new SupertonicEngine() as any;
      e.isInitialized = true;
      e.config = {maxChunkSize: 70};
      e.styleLoader = {getVoiceStyle: jest.fn(async () => ({}))};
      e.synthesizeChunk = synth;
      return e;
    },
  ],
];

beforeEach(() => {
  mockOrder.length = 0;
  Object.values(player).forEach(fn => fn.mockClear());
});

function tokens(): unknown[] {
  return player.play!.mock.calls.map(c => c[2]);
}

describe.each(ENGINES)('%s: one utterance, one focus hold', (_n, make) => {
  test('speak(): every chunk carries the same token; ended once after the last chunk', async () => {
    const engine = make(jest.fn(async () => AUDIO));
    await engine.synthesize(TEXT);

    expect(player.play!.mock.calls.length).toBeGreaterThanOrEqual(3);
    const [first, ...rest] = tokens();
    expect(first).toEqual(expect.any(Object));
    rest.forEach(t => expect(t).toBe(first));
    expect(player.endUtterance).toHaveBeenCalledTimes(1);
    expect(player.endUtterance).toHaveBeenCalledWith(first);
    expect(mockOrder[mockOrder.length - 1]).toBe('end');
  });

  test('speak(): a synthesis error mid-utterance still ends it', async () => {
    let n = 0;
    const engine = make(
      jest.fn(async () => {
        if (++n === 2) {
          throw new Error('boom');
        }
        return AUDIO;
      }),
    );
    await expect(engine.synthesize(TEXT)).rejects.toThrow('boom');
    expect(player.endUtterance).toHaveBeenCalledTimes(1);
    expect(player.endUtterance).toHaveBeenCalledWith(tokens()[0]);
  });

  test('two speak() calls use different tokens', async () => {
    const engine = make(jest.fn(async () => AUDIO));
    await engine.synthesize(TEXT);
    const a = tokens()[0];
    player.play!.mockClear();
    await engine.synthesize(TEXT);
    expect(tokens()[0]).not.toBe(a);
  });

  test('stream: every chunk carries the same token; ended once when the loop ends', async () => {
    const engine = make(jest.fn(async () => AUDIO));
    const stream = engine.synthesizeStream();
    stream.append(TEXT);
    await stream.finalize();

    expect(player.play!.mock.calls.length).toBeGreaterThanOrEqual(3);
    const [first, ...rest] = tokens();
    expect(first).toEqual(expect.any(Object));
    rest.forEach(t => expect(t).toBe(first));
    expect(player.endUtterance).toHaveBeenCalledTimes(1);
    expect(player.endUtterance).toHaveBeenCalledWith(first);
    expect(mockOrder[mockOrder.length - 1]).toBe('end');
  });
});
