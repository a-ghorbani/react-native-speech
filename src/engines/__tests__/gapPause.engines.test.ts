/**
 * #134 through the engines: a pause between two chunks of a speak() or a
 * stream holds the next chunk until resume(); stop() drops it.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});
jest.mock('../../NativeAudioPlayer', () => ({
  __esModule: true,
  default: {
    playAudio: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    pause: jest.fn(async () => false),
    resume: jest.fn(async () => false),
  },
}));
jest.mock('../../phonemization', () => ({
  loadNativeDict: jest.fn(),
}));

import NativeNeuralAudioPlayer from '../../NativeAudioPlayer';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';
import {KokoroEngine} from '../kokoro/KokoroEngine';
import {KittenEngine} from '../kitten/KittenEngine';
import {SupertonicEngine} from '../supertonic/SupertonicEngine';

const native = NativeNeuralAudioPlayer as unknown as Record<string, jest.Mock>;
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
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

type Engine = {
  synthesize(text: string): Promise<unknown>;
  synthesizeStream(): {append(t: string): void; finalize(): Promise<void>};
  stop(): Promise<void>;
};

/** Chunk 2's synthesis waits on `gate`, so the test can act in the gap after chunk 1. */
function makeSynth() {
  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  let n = 0;
  const synth = jest.fn(async () => {
    if (++n === 2) {
      await gate;
    }
    return AUDIO;
  });
  return {synth, release};
}

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

beforeEach(async () => {
  await neuralAudioPlayer.stop();
  Object.values(native).forEach(fn => fn.mockClear());
});

async function untilPlays(n: number) {
  for (let i = 0; i < 200 && native.playAudio!.mock.calls.length < n; i++) {
    await tick(1);
  }
  expect(native.playAudio!.mock.calls.length).toBeGreaterThanOrEqual(n);
}

describe.each(ENGINES)('%s: pause between chunks', (_n, make) => {
  test.each(['speak', 'stream'])(
    '%s: the next chunk waits for resume()',
    async mode => {
      const {synth, release} = makeSynth();
      const engine = make(synth);
      let done: Promise<unknown>;
      if (mode === 'speak') {
        done = engine.synthesize(TEXT);
      } else {
        const s = engine.synthesizeStream();
        s.append(TEXT);
        done = s.finalize();
      }
      await untilPlays(1);
      await tick();
      await expect(neuralAudioPlayer.pause()).resolves.toBe(true);
      release();
      await tick(30);
      expect(native.playAudio).toHaveBeenCalledTimes(1);

      await expect(neuralAudioPlayer.resume()).resolves.toBe(true);
      await done!;
      expect(native.playAudio!.mock.calls.length).toBeGreaterThanOrEqual(3);
    },
  );

  test('stop() while paused in the gap: speak() settles, the held chunk never plays', async () => {
    const {synth, release} = makeSynth();
    const engine = make(synth);
    const done = engine.synthesize(TEXT);
    await untilPlays(1);
    await tick();
    await neuralAudioPlayer.pause();
    release();
    await tick(30);
    await engine.stop();
    await done;
    expect(native.playAudio).toHaveBeenCalledTimes(1);
  });
});
