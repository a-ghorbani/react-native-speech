/**
 * A unit of a stopped speak() must not run inference after the app has
 * gone stop() -> release() -> initialize() -> speak() (#64). The old
 * unit is still awaiting its current step when the new speak() resets
 * the stop flag; it must not then go on to infer on the new session.
 *
 * Phonemizing is the identity and the tokenizer tags each text, so the
 * session log shows which text ran on which session.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock(
  'onnxruntime-react-native',
  () => ({
    InferenceSession: {},
    Tensor: function (this: {data: unknown}, _t: string, data: unknown) {
      this.data = data;
    },
  }),
  {virtual: true},
);
jest.mock('../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    play: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
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

const TAGS = ['A', 'B', 'NEW'];
/** "A one, B two" is over the token cap and splits into "A one," and "B two". */
const OVERSIZED = 'A one, B two';

function encode(text: string): number[] {
  const tag = TAGS.findIndex(t => text.includes(t)) + 1;
  const length = text.includes('A ') && text.includes('B ') ? 600 : 10;
  return new Array(length).fill(tag);
}

type Held = {release: () => void};

function setup(name: 'Kitten' | 'Kokoro') {
  const log: string[] = [];
  const held: Held[] = [];
  /** Which old step waits for releaseHeld(): phonemizing texts with this tag, or the first embedding. */
  const hold = {phonemize: '', embedding: false};
  const session = (label: string) => ({
    release: jest.fn(async () => {}),
    run: jest.fn((feeds: {input_ids: {data: BigInt64Array}}) => {
      const tag = TAGS[Number(feeds.input_ids.data[0]) - 1];
      log.push(`${label}:${tag}`);
      const out = {waveform: {data: new Float32Array(24000).fill(0.1)}};
      return new Promise(resolve => held.push({release: () => resolve(out)}));
    }),
  });
  const later = <T>(value: T) =>
    new Promise<T>(resolve => held.push({release: () => resolve(value)}));
  const phonemize = jest.fn((t: string) =>
    hold.phonemize && t.includes(hold.phonemize)
      ? later(t)
      : Promise.resolve(t),
  );
  // The old unit fetches the first embedding.
  const embedding = jest.fn(() => {
    const value = new Float32Array(256);
    if (!hold.embedding) return Promise.resolve(value);
    hold.embedding = false;
    return later(value);
  });

  const e = (
    name === 'Kitten' ? new KittenEngine() : new KokoroEngine()
  ) as any;
  const init = (label: string) => {
    e.isInitialized = true;
    e.config = {maxChunkSize: 400};
    e.session = session(label);
    e.tokenizer = {encode, clear: jest.fn()};
    e.voiceLoader = {
      getStyleEmbedding: embedding,
      getVoiceEmbedding: embedding,
      clear: jest.fn(),
    };
    e.phonemizer = {phonemize};
  };
  init('old');

  return {
    engine: e,
    log,
    hold,
    phonemized: () => phonemize.mock.calls.map(([t]) => t),
    /** What the app does while the old unit is still busy. */
    async reinitAndSpeak(): Promise<{done: Promise<unknown>}> {
      await e.stop();
      await e.release();
      init('new');
      return {done: e.synthesize('NEW one')};
    },
    releaseHeld: () => held.splice(0).forEach(h => h.release()),
  };
}

const tick = () => new Promise(r => setTimeout(r, 10));

describe.each(['Kitten', 'Kokoro'] as const)(
  '%s: a stopped utterance after release + initialize + speak (#64)',
  name => {
    it.each([
      ['speak()', (e: any) => e.synthesize(OVERSIZED)],
      [
        'stream',
        (e: any) => {
          const stream = e.synthesizeStream();
          stream.append(OVERSIZED);
          return stream.finalize();
        },
      ],
    ])(
      'does not run the rest of an oversized chunk of a %s on the new session',
      async (_k, start) => {
        const h = setup(name);
        const old = start(h.engine);
        await tick();
        expect(h.log).toEqual(['old:A']);

        const next = await h.reinitAndSpeak();
        await tick();
        h.releaseHeld(); // piece A on the old session ends; so does NEW
        await tick();
        h.releaseHeld();
        await Promise.all([old, next.done]);

        expect(h.log).toEqual(['old:A', 'new:NEW']);
        expect(h.phonemized().filter(t => t.startsWith('B'))).toEqual([]);
      },
    );

    it('does not run a unit stopped mid-phonemize on the new session', async () => {
      const h = setup(name);
      h.hold.phonemize = 'A';
      const old = h.engine.synthesize('A one');
      await tick();
      expect(h.log).toEqual([]);

      const next = await h.reinitAndSpeak();
      await tick();
      h.releaseHeld(); // phonemize of the old unit ends; so does NEW
      await tick();
      h.releaseHeld();
      await Promise.all([old, next.done]);

      expect(h.log).toEqual(['new:NEW']);
    });

    it('does not run a unit stopped while fetching its voice on the new session', async () => {
      const h = setup(name);
      h.hold.embedding = true;
      const old = h.engine.synthesize('A one');
      await tick();
      expect(h.log).toEqual([]);

      const next = await h.reinitAndSpeak();
      await tick();
      h.releaseHeld(); // the old unit's voice embedding arrives
      await tick();
      h.releaseHeld();
      await Promise.all([old, next.done]);

      expect(h.log).toEqual(['new:NEW']);
    });

    it('does not run the rest of an oversized chunk after stop() + speak() on the same session', async () => {
      const h = setup(name);
      const old = h.engine.synthesize(OVERSIZED);
      await tick();
      expect(h.log).toEqual(['old:A']);

      await h.engine.stop();
      const next = h.engine.synthesize('NEW one');
      await tick();
      h.releaseHeld(); // piece A ends; so does NEW
      await tick();
      h.releaseHeld();
      await Promise.all([old, next]);

      expect(h.log).toEqual(['old:A', 'old:NEW']);
    });

    it('does not start a unit for an utterance replaced from its progress callback', async () => {
      const h = setup(name);
      let replaced = false;
      let next: Promise<unknown> | undefined;
      h.engine.setChunkProgressCallback(() => {
        if (replaced) return;
        replaced = true;
        next = h.engine.synthesize('NEW one');
      });
      const old = h.engine.synthesize('A one');
      await tick();
      h.releaseHeld();
      await tick();
      h.releaseHeld();
      await Promise.all([old, next]);

      expect(h.log).toEqual(['old:NEW']);
    });

    it("does not run a stream unit held in g2p once the stream handle's cancel() ran (#108)", async () => {
      const h = setup(name);
      h.hold.phonemize = 'A';
      const stream = h.engine.synthesizeStream();
      stream.append('A one.');
      const done = stream.finalize();
      await tick();
      expect(h.phonemized()).toEqual(['A one.']);
      await stream.cancel();
      h.releaseHeld(); // A's g2p ends after the cancel
      await tick();
      await done;
      expect(h.log).toEqual([]);
    });

    it("does not run the rest of an oversized chunk once the stream handle's cancel() ran (#108)", async () => {
      const h = setup(name);
      const stream = h.engine.synthesizeStream();
      stream.append(OVERSIZED);
      const done = stream.finalize();
      await tick();
      expect(h.log).toEqual(['old:A']);
      await stream.cancel();
      h.releaseHeld(); // piece A's run ends after the cancel
      await tick();
      await done;
      expect(h.log).toEqual(['old:A']);
      expect(h.phonemized().filter(t => t.startsWith('B'))).toEqual([]);
    });

    it("does not run a stream unit held in its voice load once the stream handle's cancel() ran (#108)", async () => {
      const h = setup(name);
      h.hold.embedding = true;
      const stream = h.engine.synthesizeStream();
      stream.append('A one.');
      const done = stream.finalize();
      await tick();
      await stream.cancel();
      h.releaseHeld(); // the embedding arrives after the cancel
      await tick();
      await done;
      expect(h.log).toEqual([]);
    });

    it('does not run the prefetched next chunk after stop() + speak() (#104)', async () => {
      const h = setup(name);
      h.engine.config.maxChunkSize = 8;
      h.hold.phonemize = 'B';
      const old = h.engine.synthesize('A one. B two.');
      await tick();
      expect(h.log).toEqual(['old:A']);
      h.releaseHeld(); // chunk A plays; chunk B is prefetched and held in g2p
      await tick();

      await h.engine.stop();
      const next = h.engine.synthesize('NEW one');
      await tick();
      h.releaseHeld(); // B's g2p ends; so does NEW
      await tick();
      h.releaseHeld();
      await Promise.all([old, next]);

      expect(h.log).toEqual(['old:A', 'old:NEW']);
    });
  },
);
