/**
 * A stream that replaces another stays stoppable: when the replaced
 * stream's finalize() or cancel() settles, it must not clear the engine's
 * slot for the new one. Playback never settles on its own here, so the new
 * stream's finalize() resolves only if stop() cancels it.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    play: jest.fn(() => new Promise<void>(() => {})),
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

const AUDIO = {
  samples: new Float32Array(240).fill(0.1),
  sampleRate: 24000,
  channels: 1,
  duration: 0.01,
};

type Handle = {
  append(t: string): void;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
};
type Stub = {synthesizeStream(): Handle; stop(): Promise<void>};

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

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

async function outcome(p: Promise<void>): Promise<string> {
  return Promise.race([
    p.then(() => 'resolved'),
    tick(500).then(() => 'pending'),
  ]);
}

describe.each(ENGINES)(
  '%s: stop() after a stream replaces another',
  (_n, make) => {
    test.each(['finalize', 'cancel'] as const)(
      "the replaced stream's %s() settling leaves the new one stoppable",
      async settle => {
        const engine = make();
        const a = engine.synthesizeStream();
        a.append('First sentence here. Second sentence here. ');
        const aDone = settle === 'finalize' ? a.finalize() : Promise.resolve();
        await tick();

        const b = engine.synthesizeStream();
        b.append('Third sentence here. Fourth sentence here. ');
        const bDone = b.finalize();
        await (settle === 'finalize' ? aDone : a.cancel());
        await tick();

        await engine.stop();
        expect(await outcome(bDone)).toBe('resolved');
      },
    );
  },
);
