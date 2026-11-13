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

/**
 * Like `timedStream`, with a fixed cost per chunk on top of the per-char
 * synthesis time and a fixed audio length per chunk (Kokoro's edge
 * silence), as measured on a slow phone while an LLM runs (#153).
 */
type Cost = {
  fixed: number;
  perChar: number;
  audio0: number;
  audioPerChar: number;
};

async function costStream(
  text: string,
  p: Cost & {first?: Pick<Cost, 'fixed' | 'perChar'>},
  maxFirstChunkHoldMs?: number,
  textDelayMs = 0,
  firstChunk: 'clause' | 'sentence' = 'clause',
) {
  const t0 = Date.now();
  const plays: {text: string; start: number; end: number}[] = [];
  let synthesized = 0;
  const session = new EngineStreamSession<AudioBuffer & {tag: string}>({
    synthesizeChunk: chunk => {
      const s = synthesized++ === 0 ? (p.first ?? p) : p;
      return new Promise(resolve =>
        setTimeout(
          () => resolve(audio(p.audio0 + chunk.length * p.audioPerChar, chunk)),
          s.fixed + chunk.length * s.perChar,
        ),
      );
    },
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
    firstChunkMaxWords: 16,
    maxFirstChunkHoldMs,
  });
  let done = false;
  (async () => {
    const tokens = text.match(/\S+\s*/g) ?? [];
    const first = text.match(/^.*?[.!?]\s+/)![0];
    session.append(first);
    if (textDelayMs) {
      await new Promise(r => setTimeout(r, textDelayMs));
    }
    for (const tok of tokens.slice(first.split(/\s+/).length - 1)) {
      session.append(tok);
      await new Promise(r => setTimeout(r, 20));
    }
    await session.finalize();
    done = true;
  })();
  while (!done) {
    await jest.advanceTimersByTimeAsync(10);
  }
  const gaps = plays.slice(1).map((p2, i) => p2.start - plays[i]!.end);
  return {
    plays,
    gaps,
    chunks: plays.map(p2 => p2.text),
    first: plays[0]!.start,
  };
}

describe('EngineStreamSession pacing after a first chunk that ends at a break (#153)', () => {
  // Kokoro int8 on a mid-range phone while an LLM generates (from a field report).
  const SLOW = {fixed: 900, perChar: 45, audio0: 300, audioPerChar: 54};
  // Supertonic on the same phone.
  const FAST = {fixed: 300, perChar: 22, audio0: 640, audioPerChar: 70};
  const COMMA_FIRST =
    'When you finally reach the old harbor town after the long drive through the hills, the vineyards, and the little villages with their white houses and red roofs, you should walk down to the water and find the small cafe near the lighthouse. It has the best coffee on the coast. ';
  const COMMA_FIRST_NO_CLAUSE =
    'Since the forecast says it will rain on Saturday in the northern valleys, it might be better to hike the ridge trail on Sunday morning instead and keep Saturday for the museum and the old market. The views are better then anyway. ';
  const SHORT_FIRST =
    'Sure thing. Sintra is a lovely day trip from Lisbon, with fairytale palaces and green forest trails. The train takes about forty minutes. ';
  const SHORT_THEN_LONG =
    'Yes. You can grow basil indoors all year as long as it gets at least six hours of bright light a day and you keep the soil moist but never soggy. Pinch off the flower buds. ';

  beforeEach(() => {
    jest.useFakeTimers();
  });

  test('a comma-ended first chunk: chunk 2 ends at a clause that fits, no wait', async () => {
    const {chunks, gaps} = await costStream(COMMA_FIRST, SLOW);
    expect(chunks.join('')).toBe(COMMA_FIRST);
    expect(chunks[0]).toBe(
      'When you finally reach the old harbor town after the long drive through the hills, ',
    );
    // Base: chunk 2 may be 2x chunk 1, so it is the rest of the sentence (157 chars), ~3 s gap.
    expect(chunks[1]).toBe(
      'the vineyards, and the little villages with their white houses and red roofs, ',
    );
    expect(Math.max(...gaps)).toBeLessThanOrEqual(0);
  });

  test('a comma-ended first chunk and no clause mark within the cap: chunk 2 is cut at a word that fits', async () => {
    const {chunks, gaps} = await costStream(COMMA_FIRST_NO_CLAUSE, SLOW);
    expect(chunks.join('')).toBe(COMMA_FIRST_NO_CLAUSE);
    expect(chunks[0]).toMatch(/valleys, $/);
    expect(chunks[1]).toMatch(/[a-z] $/);
    expect(gaps[0]).toBeLessThan(150);
  });

  test('a short first sentence: chunk 2 ends at the next clause mark, not the end of its sentence', async () => {
    const {chunks, gaps, first} = await costStream(SHORT_FIRST, SLOW);
    expect(chunks.join('')).toBe(SHORT_FIRST);
    expect(chunks[0]).toBe('Sure thing. ');
    // Base: chunk 2 is the whole 89-char sentence, ~4.1 s gap.
    expect(chunks[1]).toBe('Sintra is a lovely day trip from Lisbon, ');
    expect(gaps[0]).toBeLessThan(2000);
    expect(first).toBeLessThan(1500);
  });

  test('a short clause-ended first chunk: no short word-cut chunk that the next one cannot follow', async () => {
    // A 42-char first chunk could fit a 42-char word cut; under this load
    // the chunks after it shrank and stalled 6.6 s mid-phrase (#48 corpus).
    const text =
      "The core package must be >=2.9.0 <2.10.0: the add-on builds on the core's newer API and the native PCM sinks of the engine SDK, which may change in a core minor release, so each add-on release pins the core minors it was tested against. Register the engine once. ";
    const {chunks, gaps} = await costStream(text, SLOW);
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]).toBe('The core package must be >=2.9.0 <2.10.0: ');
    chunks.slice(0, -1).forEach((c, i) => {
      if (!/[.!?,;:—–]\s*$/.test(c)) {
        expect(c.length).toBeGreaterThanOrEqual(60);
        expect(gaps[i]).toBeLessThan(300);
      }
    });
  });

  test('a first chunk too short for a word cut: the next sentence is not cut at a word', async () => {
    const {chunks} = await costStream(SHORT_THEN_LONG, SLOW);
    expect(chunks[0]).toBe('Yes. ');
    expect(chunks[1]).toMatch(/soggy\. $/);
  });

  test('maxFirstChunkHoldMs: a slow short first chunk waits for chunk 2, at most that long', async () => {
    const off = await costStream(SHORT_FIRST, SLOW);
    const on = await costStream(SHORT_FIRST, SLOW, 2000);
    expect(on.chunks).toEqual(off.chunks);
    expect(on.gaps[0]).toBeLessThanOrEqual(0);
    expect(on.first - off.first).toBeGreaterThan(1500);
    expect(on.first - off.first).toBeLessThanOrEqual(2000);
    const capped = await costStream(SHORT_FIRST, SLOW, 1000);
    expect(capped.first - off.first).toBeLessThanOrEqual(1000);
    expect(capped.gaps[0]).toBeGreaterThan(0);
  });

  test('maxFirstChunkHoldMs: the first chunk starts once chunk 2 is predicted to finish within it, not when chunk 2 is done', async () => {
    // No fixed cost, 1.2x slower than real time: the rate from chunk 1 predicts chunk 2 well.
    const EVEN = {fixed: 0, perChar: 79, audio0: 0, audioPerChar: 66};
    const off = await costStream(SHORT_FIRST, EVEN);
    const on = await costStream(SHORT_FIRST, EVEN, 10000);
    const second = on.chunks[1]!.length * EVEN.perChar;
    expect(on.first - off.first).toBeLessThan(second - 500);
    expect(on.gaps[0]).toBeLessThanOrEqual(50);
  });

  test('maxFirstChunkHoldMs: a first chunk that synthesizes faster than it plays never waits', async () => {
    const off = await costStream(SHORT_FIRST, FAST);
    const on = await costStream(SHORT_FIRST, FAST, 2000);
    expect(on.first).toBe(off.first);
    expect(on.chunks).toEqual(off.chunks);
  });

  test('maxFirstChunkHoldMs: waits for the next text while it arrives, within the limit', async () => {
    const late = await costStream(SHORT_FIRST, SLOW, 3000, 1500);
    const off = await costStream(SHORT_FIRST, SLOW, undefined, 1500);
    expect(late.first).toBeGreaterThan(off.first + 1500);
    expect(late.first - off.first).toBeLessThanOrEqual(3000);
  });

  test("maxFirstChunkHoldMs: ignored with firstChunk 'sentence'", async () => {
    const off = await costStream(SHORT_FIRST, SLOW, undefined, 0, 'sentence');
    const on = await costStream(SHORT_FIRST, SLOW, 2000, 0, 'sentence');
    expect(on.first).toBe(off.first);
    expect(on.chunks).toEqual(off.chunks);
  });

  test.each([undefined, 2000])(
    'maxFirstChunkHoldMs %p with a fast first chunk: nothing is synthesized before the first chunk starts',
    async hold => {
      const {synthesizeChunk, calls} = deferredSynth();
      const {playAudio} = deferredPlayer();
      const seen: number[] = [];
      const session = new EngineStreamSession({
        synthesizeChunk,
        playAudio,
        stopPlayback: async () => {},
        maxChunkSize: 200,
        firstChunk: 'clause',
        maxFirstChunkHoldMs: hold,
        postProcess: () => seen.push(calls.length),
        onChunkProgress: () => seen.push(calls.length),
      });
      session.append(SHORT_FIRST);
      await flush();
      calls[0]!.resolve(audio(900));
      await flush();
      expect(seen).toEqual([1, 1]);
      expect(calls.length).toBe(2);
      await session.cancel();
    },
  );

  test('maxFirstChunkHoldMs: a stream with only the first chunk does not wait', async () => {
    const {first, chunks} = await costStream('Sure thing. ', SLOW, 2000);
    expect(chunks).toEqual(['Sure thing. ']);
    expect(first).toBeLessThan(1500);
  });

  test('maxFirstChunkHoldMs: cancel during the wait plays nothing', async () => {
    const {synthesizeChunk, calls} = deferredSynth();
    const {playAudio} = deferredPlayer();
    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: async () => {},
      maxChunkSize: 200,
      firstChunk: 'clause',
      maxFirstChunkHoldMs: 5000,
    });
    session.append('Sure thing. ');
    await flush();
    jest.advanceTimersByTime(2000);
    calls[0]!.resolve(audio(900));
    session.append('Sintra is a lovely day trip from Lisbon, with palaces. ');
    await flush();
    expect(calls).toHaveLength(2);
    await session.cancel();
    expect(playAudio).not.toHaveBeenCalled();
  });

  test.each([-1, NaN, Infinity, '2000'])(
    'maxFirstChunkHoldMs %p is rejected by the session',
    value => {
      expect(
        () =>
          new EngineStreamSession({
            synthesizeChunk: async () => audio(100),
            playAudio: async () => {},
            stopPlayback: async () => {},
            maxChunkSize: 200,
            firstChunk: 'clause',
            maxFirstChunkHoldMs: value as any,
          }),
      ).toThrow(/^maxFirstChunkHoldMs must be a finite number >= 0/);
    },
  );

  test('maxFirstChunkHoldMs: audio without durations never waits', async () => {
    type Handle = {id: number};
    const plays: number[] = [];
    let id = 0;
    const session = new EngineStreamSession<Handle>({
      synthesizeChunk: text =>
        new Promise(resolve =>
          setTimeout(() => resolve({id: ++id}), 100 * text.length),
        ),
      playAudio: async () => {
        plays.push(Date.now());
      },
      stopPlayback: async () => {},
      hasAudio: () => true,
      maxChunkSize: 200,
      firstChunk: 'clause',
      maxFirstChunkHoldMs: 5000,
    });
    const t0 = Date.now();
    session.append(SHORT_FIRST);
    const done = session.finalize();
    while (plays.length === 0) {
      await jest.advanceTimersByTimeAsync(10);
    }
    expect(plays[0]! - t0).toBeLessThanOrEqual(1210);
    await jest.runAllTimersAsync();
    await done;
  });
});

describe('EngineStreamSession pacing after a slow first chunk that ends at a comma (#158)', () => {
  // Kokoro int8 on a mid-range phone while an LLM generates (2.11.3 field
  // report): chunk 1 synthesizes at ~1.2x its audio; the LLM is done before
  // chunk 2, which runs faster. PERSIST: the load lasts.
  const FIRST = {fixed: 839, perChar: 52.2};
  const AUDIO = {audio0: 190, audioPerChar: 50.4};
  const AFTER_LLM = {first: FIRST, fixed: 650, perChar: 43.6, ...AUDIO};
  const PERSIST = {first: FIRST, ...FIRST, ...AUDIO};
  const TEXT =
    'When you finally reach the old harbor town after the long drive through the hills, vineyards, and little villages with their white houses and red roofs, you should walk down to the water and find the small cafe near the lighthouse. The fish there is always fresh. ';
  const CLAUSE =
    'vineyards, and little villages with their white houses and red roofs, ';

  beforeEach(() => {
    jest.useFakeTimers();
  });

  test('chunk 2 is the clause that fits, not the rest of the sentence: no wait', async () => {
    const {chunks, gaps} = await costStream(TEXT, AFTER_LLM);
    expect(chunks.join('')).toBe(TEXT);
    expect(chunks[0]).toMatch(/hills, $/);
    // Base: chunk 2 is the 149-char rest of the sentence, ~2.6 s gap.
    expect(chunks[1]).toBe(CLAUSE);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(0);
  });

  test('under lasting load the pause moves to the next clause mark, shorter', async () => {
    const {chunks, gaps} = await costStream(TEXT, PERSIST);
    expect(chunks[1]).toBe(CLAUSE);
    // Base: one ~4.2 s pause after "hills,"; here ~0.1 s, then ~2.9 s after "roofs,".
    expect(gaps[0]).toBeLessThan(300);
    expect(gaps.reduce((a, b) => a + b, 0)).toBeLessThan(3500);
    gaps.forEach((g, i) => {
      if (g > 0) {
        expect(chunks[i]).toMatch(/[.!?,;:]\s*$/);
      }
    });
  });

  test('a fitting clause shorter than 40 chars is not cut at 1x: chunk 3 would grow 2x and wait longer', async () => {
    const text =
      'Before you start the engine, check the oil, then drive slowly down to the harbor and park near the gate where the guard can see the car. Then walk. ';
    const {chunks} = await costStream(text, AFTER_LLM);
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]).toBe('Before you start the engine, ');
    expect(chunks[1]).not.toBe('check the oil, ');
    expect(chunks[1]!.length).toBeGreaterThanOrEqual(40);
  });
});
