/**
 * cancel() on a stream handle whose stream has already ended leaves the
 * shared player alone (#112): a newer speak() or stream that is playing
 * keeps playing.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});

type Tagged = {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  duration: number;
  tag: string;
};

/** Every play and stop, in order: "play:<chunk text>" or "stop". */
const timeline: string[] = [];
const pendingPlays: Array<() => void> = [];
/** Plays of chunks tagged with this prefix last until stopped. */
let mockHoldPrefix = '';
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    endUtterance: jest.fn().mockResolvedValue(undefined),
    play: jest.fn((buf: Tagged) => {
      timeline.push(`play:${buf.tag}`);
      return new Promise<void>(resolve => {
        pendingPlays.push(resolve);
        if (!buf.tag.startsWith(mockHoldPrefix)) {
          setTimeout(resolve, 5);
        }
      });
    }),
    stop: jest.fn(async () => {
      timeline.push('stop');
      pendingPlays.splice(0).forEach(r => r());
    }),
  },
}));
jest.mock('../../phonemization', () => ({
  loadNativeDict: jest.fn(),
}));

import {KokoroEngine} from '../kokoro/KokoroEngine';
import {KittenEngine} from '../kitten/KittenEngine';
import {SupertonicEngine} from '../supertonic/SupertonicEngine';

let failText = '';
const audioFor = async (text: string): Promise<Tagged> => {
  await new Promise(r => setTimeout(r, 2));
  if (failText && text.includes(failText)) {
    throw new Error('synthesis failed');
  }
  return {
    samples: new Float32Array(240).fill(0.1),
    sampleRate: 24000,
    channels: 1,
    duration: 0.01,
    tag: text.trim(),
  };
};

type Handle = {
  append(t: string): void;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
};
type Engine = {
  synthesize(text: string): Promise<unknown>;
  synthesizeStream(): Handle;
  stop(): Promise<void>;
};

const ENGINES: Array<[string, () => Engine]> = [
  [
    'Kokoro',
    () => {
      const e = new KokoroEngine() as any;
      e.isInitialized = true;
      e.session = {};
      e.config = {maxChunkSize: 40};
      e.synthesizeTextChunk = jest.fn(audioFor);
      return e;
    },
  ],
  [
    'Kitten',
    () => {
      const e = new KittenEngine() as any;
      e.isInitialized = true;
      e.session = {};
      e.config = {maxChunkSize: 40};
      e.synthesizeTextChunk = jest.fn(audioFor);
      return e;
    },
  ],
  [
    'Supertonic',
    () => {
      const e = new SupertonicEngine() as any;
      e.isInitialized = true;
      e.config = {maxChunkSize: 40};
      e.styleLoader = {getVoiceStyle: jest.fn(async () => ({}))};
      e.synthesizeChunk = jest.fn(audioFor);
      return e;
    },
  ],
];

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(2);
  }
}

function startB(engine: Engine, kind: 'speak' | 'stream'): Promise<unknown> {
  if (kind === 'speak') {
    return engine.synthesize('Bravo is a new reply.');
  }
  const h = engine.synthesizeStream();
  h.append('Bravo is a new reply.');
  return h.finalize();
}

beforeEach(() => {
  timeline.length = 0;
  pendingPlays.length = 0;
  mockHoldPrefix = 'Bravo';
  failText = '';
});

describe.each(ENGINES)('%s: cancel() of an ended stream (#112)', (_n, make) => {
  test.each([
    ['finished', 'speak'],
    ['finished', 'stream'],
    ['failed', 'speak'],
    ['failed', 'stream'],
  ] as const)(
    "a %s stream's late cancel() leaves a newer %s playing",
    async (end, kind) => {
      const engine = make();
      if (end === 'failed') {
        failText = 'Alpha two';
      }
      const a = engine.synthesizeStream();
      a.append('Alpha one is here. Alpha two is here.');
      const aDone = a.finalize();
      await (end === 'finished'
        ? aDone
        : expect(aDone).rejects.toThrow('synthesis failed'));

      const bDone = startB(engine, kind);
      await waitFor(() => timeline.some(e => e.startsWith('play:Bravo')));
      const bPlay = timeline.findIndex(e => e.startsWith('play:Bravo'));

      await a.cancel();
      await tick();

      expect(timeline.slice(bPlay)).toEqual(['play:Bravo is a new reply.']);

      await engine.stop();
      await bDone.catch(() => {});
    },
  );

  test('cancel() of a running stream still stops playback', async () => {
    mockHoldPrefix = 'Alpha';
    const engine = make();
    const a = engine.synthesizeStream();
    a.append('Alpha one is here.');
    const aDone = a.finalize();
    await waitFor(() => timeline.includes('play:Alpha one is here.'));

    await a.cancel();
    await aDone;

    const aPlay = timeline.indexOf('play:Alpha one is here.');
    expect(timeline.slice(aPlay)).toEqual(['play:Alpha one is here.', 'stop']);
  });
});
