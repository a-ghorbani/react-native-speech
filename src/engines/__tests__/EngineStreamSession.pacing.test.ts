/**
 * EngineStreamSession pacing (#83): synthesis runs ahead of playback, and
 * chunk sizes follow the measured synthesis rate, so a long chunk after a
 * short one does not leave the stream silent while it is synthesized.
 */
import {EngineStreamSession} from '../EngineStreamSession';
import type {AudioBuffer} from '../../types';

const SAMPLE_RATE = 24000;

function audio(ms: number, tag = ''): AudioBuffer & {tag: string} {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  return {
    samples: new Float32Array(n),
    sampleRate: SAMPLE_RATE,
    channels: 1,
    duration: n / SAMPLE_RATE,
    tag,
  };
}

async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function deferredSynth() {
  const calls: {
    text: string;
    resolve: (a: AudioBuffer) => void;
    reject: (e: Error) => void;
  }[] = [];
  const synthesizeChunk = jest.fn(
    (text: string) =>
      new Promise<AudioBuffer>((resolve, reject) => {
        calls.push({text, resolve, reject});
      }),
  );
  return {synthesizeChunk, calls};
}

function deferredPlayer() {
  const plays: {buffer: AudioBuffer; resolve: () => void}[] = [];
  const playAudio = jest.fn(
    (buffer: AudioBuffer) =>
      new Promise<void>(resolve => {
        plays.push({buffer, resolve});
      }),
  );
  return {playAudio, plays};
}

/**
 * Stream `text` word by word every 50 ms (20 tok/s) into a session whose
 * synthesis takes `synthMsPerChar` per char and whose audio lasts
 * `audioMsPerChar` per char, on fake timers. Returns each chunk's text,
 * play start and end.
 */
async function timedStream(
  text: string,
  synthMsPerChar: number,
  audioMsPerChar = 66,
  firstChunk: 'clause' | 'sentence' = 'clause',
  firstChunkMaxWords?: number,
) {
  const t0 = Date.now();
  const plays: {text: string; start: number; end: number}[] = [];
  const session = new EngineStreamSession<AudioBuffer & {tag: string}>({
    synthesizeChunk: chunk =>
      new Promise(resolve =>
        setTimeout(
          () => resolve(audio(chunk.length * audioMsPerChar, chunk)),
          chunk.length * synthMsPerChar,
        ),
      ),
    playAudio: buffer =>
      new Promise<void>(resolve => {
        const start = Date.now() - t0;
        const ms = buffer.duration * 1000;
        plays.push({text: buffer.tag, start, end: start + ms});
        setTimeout(resolve, ms);
      }),
    stopPlayback: async () => {},
    maxChunkSize: 200,
    firstChunk,
    firstChunkMaxWords,
  });
  let done = false;
  (async () => {
    for (const tok of text.match(/\S+\s*/g) ?? []) {
      session.append(tok);
      await new Promise(r => setTimeout(r, 50));
    }
    await session.finalize();
    done = true;
  })();
  while (!done) {
    await jest.advanceTimersByTimeAsync(20);
  }
  const gaps = plays.slice(1).map((p, i) => p.start - plays[i]!.end);
  return {plays, gaps, chunks: plays.map(p => p.text)};
}

// An LLM reply where short sentences sit between long ones.
const REPLY =
  'Good question. Bread goes stale mainly because the starch inside it slowly recrystallizes after baking, pushing water out of the soft crumb and into the crust, which is why an old loaf feels both dry and leathery at the same time. It is not really about drying out. In fact, a loaf sealed in plastic still goes stale, just a little more slowly, and keeping it in the fridge makes things worse, because the cold speeds up that same recrystallization. Freeze it instead. Slice the loaf first, wrap the slices tightly, and toast them straight from the freezer whenever you need one; the heat melts the starch crystals again and the bread tastes almost fresh. A stale loaf can be rescued too. Run it briefly under the tap, put it in a hot oven for five to ten minutes, and the crust crisps up while the inside softens, although the effect only lasts an hour or so. Finally, old bread is great for croutons, bread pudding or breadcrumbs, so nothing has to go to waste. ';
// The #70 reply: a 17-char first clause, then a 197-char sentence.
const COUNTED =
  'one, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty were the numbers we counted out loud this morning in the park. Then we walked home. After that we made tea and sat down to rest for a while. ';

describe('EngineStreamSession pacing (#83)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('the chunk after next is synthesized while the current one plays', async () => {
    const {synthesizeChunk, calls} = deferredSynth();
    const {playAudio, plays} = deferredPlayer();
    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: async () => {},
      maxChunkSize: 20,
    });
    session.append('One one one. Two two two. Three three. Four four. ');
    session.finalize();
    await flush();
    calls[0]!.resolve(audio(1000));
    await flush();
    expect(plays).toHaveLength(1);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(audio(1000));
    await flush();
    // Chunk 1 is still playing: chunk 3 is already being synthesized.
    expect(calls.map(c => c.text)).toEqual([
      'One one one. ',
      'Two two two. ',
      'Three three. ',
    ]);
    calls[2]!.resolve(audio(1000));
    await flush();
    // Two chunks ready ahead of the playing one: nothing more until it ends.
    expect(calls).toHaveLength(3);
    plays[0]!.resolve();
    await flush();
    expect(plays).toHaveLength(2);
    expect(calls).toHaveLength(4);
  });

  test('short sentences between long ones: no wait after the opening chunk (synthesis at 0.64x real time)', async () => {
    jest.useFakeTimers();
    const {gaps, chunks} = await timedStream(REPLY, 42);
    expect(chunks.join('')).toBe(REPLY);
    // One chunk ahead, the 187- and 172-char sentences after the short ones waited 6.6 s and 5 s.
    expect(Math.max(...gaps.slice(1))).toBeLessThanOrEqual(0);
  });

  test('the #70 reply ramps at the measured rate: no boundary waits more than 1 s', async () => {
    jest.useFakeTimers();
    const {gaps, chunks} = await timedStream(COUNTED, 42);
    expect(chunks.join('')).toBe(COUNTED);
    expect(chunks[0]).toBe('one, two, three, ');
    // The 4x ramp alone gives [17, 68, 150] and waits ~2 s at boundary 2.
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1000);
  });

  test('fast synthesis keeps the #75 ramp: chunk 2 is not cut smaller than the 4x cap allows', async () => {
    jest.useFakeTimers();
    const {chunks, gaps} = await timedStream(COUNTED, 10);
    expect(chunks[1]!.length).toBeGreaterThan(2 * 17);
    expect(chunks[1]!.length).toBeLessThanOrEqual(4 * 17);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(0);
  });

  test('synthesis slower than playback: chunks still grow instead of staying at the first clause size', async () => {
    jest.useFakeTimers();
    const {chunks} = await timedStream(COUNTED, 100);
    expect(chunks.join('')).toBe(COUNTED);
    const sizes = chunks.map(c => c.length);
    expect(sizes[0]).toBe(17);
    for (let i = 1; i < 4; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]!);
    }
  });

  test("firstChunk 'sentence' (the default) still gets whole sentences only", async () => {
    jest.useFakeTimers();
    const text =
      'Bread goes stale quickly. The starch inside it recrystallizes, pushing water out of the crumb and into the crust, which is why an old loaf feels dry and leathery at once. Done. ';
    const {chunks} = await timedStream(text, 42, 66, 'sentence');
    expect(chunks).toEqual([
      'Bread goes stale quickly. ',
      'The starch inside it recrystallizes, pushing water out of the crumb and into the crust, which is why an old loaf feels dry and leathery at once. ',
      'Done. ',
    ]);
  });

  test('every synthesized chunk that is not played is discarded once, including the second one ahead', async () => {
    const {synthesizeChunk, calls} = deferredSynth();
    const {playAudio} = deferredPlayer();
    const discard = jest.fn();
    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: async () => {},
      maxChunkSize: 20,
      discard,
    });
    session.append('One one one. Two two two. Three three. Four four. ');
    await flush();
    const a1 = audio(1000, '1');
    const a2 = audio(1000, '2');
    const a3 = audio(1000, '3');
    calls[0]!.resolve(a1);
    await flush();
    calls[1]!.resolve(a2);
    await flush();
    calls[2]!.resolve(a3);
    await flush();
    // Chunk 1 plays with chunks 2 and 3 synthesized behind it.
    await session.cancel();
    await flush();
    expect(discard.mock.calls.map(c => c[0])).toEqual(
      expect.arrayContaining([a2, a3]),
    );
    expect(discard).toHaveBeenCalledTimes(2);
    expect(discard).not.toHaveBeenCalledWith(a1);
    expect(calls).toHaveLength(3);
  });

  test('a synthesis error two chunks ahead surfaces after the chunk before it plays', async () => {
    const {synthesizeChunk, calls} = deferredSynth();
    const {playAudio, plays} = deferredPlayer();
    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: async () => {},
      maxChunkSize: 20,
    });
    session.append('One one one. Two two two. Three three. ');
    const finalized = session.finalize();
    finalized.catch(() => {});
    await flush();
    calls[0]!.resolve(audio(1000));
    await flush();
    calls[1]!.resolve(audio(1000));
    await flush();
    calls[2]!.reject(new Error('synth-3-failed'));
    await flush();
    plays[0]!.resolve();
    await flush();
    expect(plays).toHaveLength(2);
    plays[1]!.resolve();
    await expect(finalized).rejects.toThrow('synth-3-failed');
  });

  test('a playback error stops the chunk chained two ahead from being synthesized', async () => {
    const {synthesizeChunk, calls} = deferredSynth();
    const playAudio = jest.fn(() => Promise.reject(new Error('play-failed')));
    const discard = jest.fn();
    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: async () => {},
      maxChunkSize: 20,
      discard,
    });
    session.append('One one one. Two two two. Three three. ');
    const finalized = session.finalize();
    finalized.catch(() => {});
    await flush();
    calls[0]!.resolve(audio(1000));
    await flush();
    await expect(finalized).rejects.toThrow('play-failed');
    const a2 = audio(1000, '2');
    calls[1]!.resolve(a2);
    await flush();
    expect(calls).toHaveLength(2);
    expect(discard).toHaveBeenCalledWith(a2);
  });

  test('without audio durations the session keeps the chunker ramp', async () => {
    type Handle = {id: number};
    const texts: string[] = [];
    let id = 0;
    const session = new EngineStreamSession<Handle>({
      synthesizeChunk: async text => {
        texts.push(text);
        return {id: ++id};
      },
      playAudio: async () => {},
      stopPlayback: async () => {},
      hasAudio: () => true,
      maxChunkSize: 200,
      firstChunk: 'clause',
    });
    session.append(COUNTED);
    await session.finalize();
    expect(texts[0]).toBe('one, two, three, ');
    expect(texts[1]!.length).toBeLessThanOrEqual(68);
    expect(texts[1]!.length).toBeGreaterThan(34);
  });

  // A first sentence with no clause mark: chunk 1 is cut at firstChunkMaxWords (#137).
  const LONG_FIRST =
    'The best time to plant tomatoes outdoors in most temperate climates is a week or two after the last spring frost when the soil has warmed up to at least sixteen degrees and the nights stay mild. Start the seeds indoors about six weeks earlier. Water them deeply but not too often, and give them plenty of sun. ';

  test('after a word-capped first chunk, synthesis at 0.83x real time: no wait after chunk 1 (#137)', async () => {
    jest.useFakeTimers();
    const {chunks, gaps} = await timedStream(LONG_FIRST, 55, 66, 'clause', 16);
    expect(chunks.join('')).toBe(LONG_FIRST);
    expect(chunks[0]!.trim().split(/\s+/)).toHaveLength(16);
    // Base: chunk 2 may be 2x chunk 1, so it takes the rest of the sentence and the next one (159 chars), ~3 s gap.
    expect(gaps[0]).toBeLessThanOrEqual(0);
    // Cut at a word within the sentence, sized to chunk 1's audio.
    expect(chunks[1]).toMatch(/[a-z] $/);
    expect(chunks[0]!.length + chunks[1]!.length).toBeLessThan(
      LONG_FIRST.indexOf('Start'),
    );
  });

  test('after a word-capped first chunk, fast synthesis still gets the rest of the sentence whole', async () => {
    jest.useFakeTimers();
    const {chunks, gaps} = await timedStream(LONG_FIRST, 15, 66, 'clause', 16);
    expect(chunks[0]!.length + chunks[1]!.length).toBe(
      LONG_FIRST.indexOf('Start'),
    );
    expect(Math.max(...gaps)).toBeLessThanOrEqual(0);
  });

  test('after a word-capped first chunk, synthesis slower than playback: chunk 2 is not smaller than chunk 1', async () => {
    jest.useFakeTimers();
    const {chunks} = await timedStream(LONG_FIRST, 100, 66, 'clause', 16);
    expect(chunks.join('')).toBe(LONG_FIRST);
    expect(chunks[1]!.length).toBeGreaterThanOrEqual(chunks[0]!.length - 10);
  });

  test('after a word-capped first chunk, the last word of a sentence is never cut off on its own', async () => {
    jest.useFakeTimers();
    for (const synth of [36, 38, 40, 42, 44]) {
      const {chunks} = await timedStream(LONG_FIRST, synth);
      expect(chunks.join('')).toBe(LONG_FIRST);
      expect(chunks).not.toContain('mild. ');
      expect(chunks.some(c => c.startsWith('mild.'))).toBe(false);
    }
  });
});
