/**
 * A new utterance replaces the previous one on the same engine, in every
 * order of speak() and stream (#72): once the new utterance's first chunk
 * plays, no chunk of the old one plays, the old one settles as with
 * stop(), and playback is stopped (native reports onStopped) first.
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
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    // A chunk plays for 30 ms, or until stopped or replaced.
    play: jest.fn((buf: Tagged) => {
      timeline.push(`play:${buf.tag}`);
      pendingPlays.splice(0).forEach(r => r());
      return new Promise<void>(resolve => {
        pendingPlays.push(resolve);
        setTimeout(resolve, 30);
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
  TextPreprocessor: class {
    process(t: string) {
      return t;
    }
  },
}));

import {KokoroEngine} from '../kokoro/KokoroEngine';
import {KittenEngine} from '../kitten/KittenEngine';
import {SupertonicEngine} from '../supertonic/SupertonicEngine';

const audioFor = async (text: string): Promise<Tagged> => {
  await new Promise(r => setTimeout(r, 5));
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
  release(): Promise<unknown>;
};

const ENGINES: Array<[string, () => Engine]> = [
  [
    'Kokoro',
    () => {
      const e = new KokoroEngine() as any;
      e.isInitialized = true;
      e.session = {};
      e.config = {maxChunkSize: 20};
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
      e.config = {maxChunkSize: 20};
      e.synthesizeTextChunk = jest.fn(audioFor);
      return e;
    },
  ],
  [
    'Supertonic',
    () => {
      const e = new SupertonicEngine() as any;
      e.isInitialized = true;
      e.config = {maxChunkSize: 20};
      e.styleLoader = {getVoiceStyle: jest.fn(async () => ({}))};
      e.synthesizeChunk = jest.fn(audioFor);
      return e;
    },
  ],
];

const A =
  'Alpha one is here. Alpha two is here. Alpha three here. Alpha four is here.';
const B = 'Bravo one is here. Bravo two is here.';

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(2);
  }
}

async function outcome(p: Promise<unknown>): Promise<string> {
  return Promise.race([
    p.then(
      () => 'resolved',
      () => 'rejected',
    ),
    tick(1500).then(() => 'pending'),
  ]);
}

type Kind = 'speak' | 'stream';

function start(engine: Engine, kind: Kind, text: string): Promise<unknown> {
  if (kind === 'speak') {
    return engine.synthesize(text);
  }
  const h = engine.synthesizeStream();
  h.append(text);
  return h.finalize();
}

const plays = () => timeline.filter(t => t.startsWith('play:'));

beforeEach(() => {
  timeline.length = 0;
  pendingPlays.length = 0;
});

const ORDERS: Array<[Kind, Kind]> = [
  ['speak', 'speak'],
  ['speak', 'stream'],
  ['stream', 'speak'],
  ['stream', 'stream'],
];

describe.each(ENGINES)(
  '%s: a new utterance replaces the old one',
  (_n, make) => {
    test.each(ORDERS)('%s -> %s', async (first, second) => {
      const engine = make();
      const aDone = start(engine, first, A);
      await waitFor(() => plays().length >= 1);

      const bDone = start(engine, second, B);
      expect(await outcome(aDone)).toBe('resolved');
      expect(await outcome(bDone)).toBe('resolved');

      const firstB = timeline.indexOf('play:Bravo one is here.');
      expect(firstB).toBeGreaterThan(0);
      const lateA = timeline
        .slice(firstB)
        .filter(t => t.startsWith('play:Alpha'));
      expect(lateA).toEqual([]);
      // Playback was stopped (native onStopped) before B played.
      expect(timeline.slice(0, firstB)).toContain('stop');
      expect(plays().filter(t => t.startsWith('play:Bravo'))).toEqual([
        'play:Bravo one is here.',
        'play:Bravo two is here.',
      ]);
    });

    test.each(ORDERS)(
      '%s -> %s while the old one is still synthesizing its first chunk',
      async (first, second) => {
        const engine = make();
        const aDone = start(engine, first, A);
        const bDone = start(engine, second, B);
        expect(await outcome(aDone)).toBe('resolved');
        expect(await outcome(bDone)).toBe('resolved');
        expect(plays().filter(t => t.startsWith('play:Alpha'))).toEqual([]);
      },
    );

    test('three speaks in a row: only the last one plays', async () => {
      const engine = make();
      const done = [
        engine.synthesize(A),
        engine.synthesize('Charlie one here. Charlie two here.'),
        engine.synthesize(B),
      ];
      for (const d of done) {
        expect(await outcome(d)).toBe('resolved');
      }
      expect(plays()).toEqual([
        'play:Bravo one is here.',
        'play:Bravo two is here.',
      ]);
    });

    test.each(ORDERS)(
      'stop() after %s -> %s stops the new one',
      async (first, second) => {
        const engine = make();
        start(engine, first, A).catch(() => {});
        await waitFor(() => plays().length >= 1);
        const bDone = start(engine, second, B);
        await waitFor(() => timeline.includes('play:Bravo one is here.'));
        await engine.stop();
        expect(await outcome(bDone)).toBe('resolved');
        expect(timeline).not.toContain('play:Bravo two is here.');
      },
    );

    test.each(ORDERS)(
      'release() after %s -> %s settles both',
      async (first, second) => {
        const engine = make();
        const aDone = start(engine, first, A);
        await waitFor(() => plays().length >= 1);
        const bDone = start(engine, second, B);
        await waitFor(() => timeline.includes('play:Bravo one is here.'));
        await engine.release();
        expect(await outcome(aDone)).toBe('resolved');
        expect(await outcome(bDone)).not.toBe('pending');
        expect(timeline).not.toContain('play:Bravo two is here.');
      },
    );
  },
);
