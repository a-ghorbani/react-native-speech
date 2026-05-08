import {EngineStreamSession} from '../EngineStreamSession';
import type {
  AudioBuffer,
  ChunkProgressEvent,
  SynthesizeChunkResult,
} from '../../types';

function makeAudioBuffer(text: string): AudioBuffer {
  return {
    samples: new Float32Array(text.length * 100),
    sampleRate: 24000,
    channels: 1,
    duration: text.length * 0.01,
  };
}

function makeControllableSynth() {
  // Tests resolve with a bare AudioBuffer for ergonomics; we wrap into
  // SynthesizeChunkResult here so the session sees the new shape.
  type Call = {
    text: string;
    resolve: (buf: AudioBuffer) => void;
    reject: (err: Error) => void;
    promise: Promise<SynthesizeChunkResult>;
  };
  const calls: Call[] = [];
  const synthesizeChunk = jest.fn((text: string) => {
    let resolveBuffer!: (buf: AudioBuffer) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<SynthesizeChunkResult>((res, rej) => {
      resolveBuffer = (buf: AudioBuffer) => res({audio: buf});
      reject = rej;
    });
    calls.push({text, resolve: resolveBuffer, reject, promise});
    return promise;
  });
  return {synthesizeChunk, calls};
}

function makeControllablePlayer() {
  type PlayCall = {
    resolve: () => void;
    reject: (err: Error) => void;
    promise: Promise<void>;
    buffer: AudioBuffer;
  };
  const plays: PlayCall[] = [];
  const playAudio = jest.fn((buffer: AudioBuffer) => {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    plays.push({resolve, reject, promise, buffer});
    return promise;
  });
  return {playAudio, plays};
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('EngineStreamSession', () => {
  test('single sentence: synth + play + finalize', async () => {
    const {synthesizeChunk, calls} = makeControllableSynth();
    const {playAudio, plays} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
    });

    session.append('Hello world. ');
    session.append('Done.');
    const finalizePromise = session.finalize();
    await flushMicrotasks();

    // First chunk: "Hello world. "
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.text).toBe('Hello world. ');
    calls[0]!.resolve(makeAudioBuffer(calls[0]!.text));
    await flushMicrotasks();

    // Should start playing first chunk
    expect(plays.length).toBeGreaterThanOrEqual(1);

    // Resolve play → loop fetches "Done." and synths it
    plays[0]!.resolve();
    await flushMicrotasks();

    // Second chunk from finalize remainder
    if (calls.length >= 2) {
      calls[1]!.resolve(makeAudioBuffer(calls[1]!.text));
      await flushMicrotasks();
    }
    // Resolve remaining plays
    for (let i = 1; i < plays.length; i++) {
      plays[i]!.resolve();
      await flushMicrotasks();
    }

    await expect(finalizePromise).resolves.toBeUndefined();
  });

  test('pipelining: synth of next chunk overlaps with play of current', async () => {
    const synthOrder: string[] = [];

    const synthesizeChunk = jest.fn(async (text: string) => {
      synthOrder.push(text);
      return {audio: makeAudioBuffer(text)};
    });

    const {playAudio, plays} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
    });

    session.append('First sentence. Second sentence. Third part');
    session.finalize();
    await flushMicrotasks();

    // First chunk synth happens synchronously (no play yet)
    expect(synthOrder).toContain('First sentence. Second sentence. ');

    // Play starts
    expect(plays).toHaveLength(1);

    // While playing first chunk, prefetch should start next synth
    // (the remainder "Third part" from finalize).
    await flushMicrotasks();

    // The prefetch synth runs concurrently with the play promise
    // (which is still pending). Resolve play.
    plays[0]!.resolve();
    await flushMicrotasks();

    // Now the second chunk ("Third part") should play
    expect(plays.length).toBeGreaterThanOrEqual(2);
    plays[1]!.resolve();
    await flushMicrotasks();
  });

  test('cancel stops the loop and rejects no error', async () => {
    const {synthesizeChunk, calls} = makeControllableSynth();
    const {playAudio} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
    });

    session.append('Hello world. ');
    await flushMicrotasks();

    calls[0]!.resolve(makeAudioBuffer('Hello world. '));
    await flushMicrotasks();

    await session.cancel();
    expect(stop).toHaveBeenCalledTimes(1);

    // Further appends are ignored
    session.append('More text. ');
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
  });

  test('synth error surfaces through finalize', async () => {
    const {synthesizeChunk, calls} = makeControllableSynth();
    const {playAudio} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
    });

    session.append('Hello. ');
    await flushMicrotasks();

    calls[0]!.reject(new Error('synth-failed'));
    await flushMicrotasks();

    await expect(session.finalize()).rejects.toThrow('synth-failed');
  });

  test('onChunkProgress emits with absolute offsets', async () => {
    const events: ChunkProgressEvent[] = [];

    const synthesizeChunk = jest.fn(async (text: string) => ({
      audio: makeAudioBuffer(text),
    }));
    const {playAudio, plays} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
      onChunkProgress: e => events.push(e),
    });

    session.append('First. ');
    await flushMicrotasks();

    // Progress emitted before play
    expect(events).toHaveLength(1);
    expect(events[0]!.textRange).toEqual({start: 0, end: 7});
    expect(events[0]!.chunkText).toBe('First. ');

    plays[0]!.resolve();
    await flushMicrotasks();

    session.append('Second. ');
    session.finalize();
    await flushMicrotasks();

    // Next chunk at absolute offset 7
    if (events.length >= 2) {
      expect(events[1]!.textRange.start).toBe(7);
    }

    // Resolve remaining
    for (let i = 1; i < plays.length; i++) {
      plays[i]!.resolve();
      await flushMicrotasks();
    }
  });

  test('postProcess is called on each audio buffer before play', async () => {
    const processed: AudioBuffer[] = [];

    const synthesizeChunk = jest.fn(async (text: string) => ({
      audio: makeAudioBuffer(text),
    }));
    const {playAudio, plays} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
      postProcess: buf => processed.push(buf),
    });

    session.append('Hello. ');
    session.finalize();
    await flushMicrotasks();

    expect(processed).toHaveLength(1);
    plays[0]!.resolve();
    await flushMicrotasks();
  });

  test('empty stream finalize resolves immediately', async () => {
    const synthesizeChunk = jest.fn();
    const playAudio = jest.fn();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
    });

    session.finalize();
    await expect(session.finalize()).resolves.toBeUndefined();
    expect(synthesizeChunk).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────
  // Empty-buffer resilience
  //
  // Engines may legitimately return an empty AudioBuffer for chunks with
  // no synthesizable content (e.g. Kitten skips a chunk that tokenizes
  // to only framing tokens, which crashes its BERT expand op). The
  // session must skip those and continue, NOT terminate. The pre-fix
  // version of `prefetchNext` returned null on `samples.length === 0`,
  // which made the main loop end the whole stream after the first such
  // chunk. These tests pin the new skip-and-continue contract.
  // ─────────────────────────────────────────────────────────────────

  function emptyBuffer(): AudioBuffer {
    return {
      samples: new Float32Array(0),
      sampleRate: 24000,
      channels: 1,
      duration: 0,
    };
  }

  test('mid-stream empty audio is skipped, subsequent chunks still synthesize and play', async () => {
    const {synthesizeChunk, calls} = makeControllableSynth();
    const {playAudio, plays} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
    });

    // Three sentence chunks — middle one will produce empty audio (the
    // bug pattern: an isolated `.` from a stripped horizontal rule).
    session.append('First sentence. ');
    session.append('. '); // → empty audio from engine
    session.append('Third sentence.');
    const finalizePromise = session.finalize();
    await flushMicrotasks();

    // First chunk: synthesizes and plays normally.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.text).toBe('First sentence. ');
    calls[0]!.resolve(makeAudioBuffer(calls[0]!.text));
    await flushMicrotasks();

    // Begins playing first chunk; in parallel, prefetches the second.
    expect(plays.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]!.text).toBe('. ');

    // Engine returns empty buffer for the no-content chunk. Session must
    // NOT terminate — it must pull the third chunk and synthesize that.
    calls[1]!.resolve(emptyBuffer());
    await flushMicrotasks();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls[2]!.text).toBe('Third sentence.');
    calls[2]!.resolve(makeAudioBuffer(calls[2]!.text));
    await flushMicrotasks();

    // First chunk play finishes → loop should advance to third chunk.
    plays[0]!.resolve();
    await flushMicrotasks();
    expect(plays.length).toBe(2);
    plays[1]!.resolve();
    await flushMicrotasks();

    await expect(finalizePromise).resolves.toBeUndefined();
    // Skipped chunk did NOT trigger playback.
    expect(plays).toHaveLength(2);
  });

  test('first chunk empty: session skips bootstrap empties and synthesizes the next', async () => {
    const {synthesizeChunk, calls} = makeControllableSynth();
    const {playAudio, plays} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
    });

    // Bug pattern: stripped hrule arrives FIRST, so the bootstrap chunk
    // is a `.\n`. Pre-fix code terminated the session at line 132 on
    // `currentAudio.samples.length === 0`. New behavior: pull next.
    session.append('. ');
    session.append('Real content here.');
    const finalizePromise = session.finalize();
    await flushMicrotasks();

    expect(calls[0]!.text).toBe('. ');
    calls[0]!.resolve(emptyBuffer());
    await flushMicrotasks();

    // Should not have played anything yet (bootstrap was empty), but
    // MUST have moved on to the next chunk.
    expect(plays).toHaveLength(0);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]!.text).toBe('Real content here.');
    calls[1]!.resolve(makeAudioBuffer(calls[1]!.text));
    await flushMicrotasks();

    expect(plays).toHaveLength(1);
    plays[0]!.resolve();
    await flushMicrotasks();

    await expect(finalizePromise).resolves.toBeUndefined();
  });

  test('all chunks empty: session ends cleanly without firing playback', async () => {
    const {synthesizeChunk, calls} = makeControllableSynth();
    const {playAudio, plays} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
    });

    session.append('. ');
    session.append('? ');
    const finalizePromise = session.finalize();
    await flushMicrotasks();

    // Resolve every synth call as empty.
    for (const c of calls) c.resolve(emptyBuffer());
    await flushMicrotasks();
    // The remainder (`? ` after finalize) may take an additional pass —
    // resolve any new calls until drained.
    for (let i = 0; i < 4; i++) {
      for (const c of calls) {
        // Promise might already be settled; resolve idempotently.
        c.resolve(emptyBuffer());
      }
      await flushMicrotasks();
    }

    await expect(finalizePromise).resolves.toBeUndefined();
    expect(plays).toHaveLength(0);
  });

  test('error during synth surfaces through finalize even with prior empty chunks', async () => {
    // Empty-buffer skipping must not swallow real errors. If a later
    // chunk genuinely throws, the session should still surface it.
    const {synthesizeChunk, calls} = makeControllableSynth();
    const {playAudio} = makeControllablePlayer();
    const stop = jest.fn(async () => {});

    const session = new EngineStreamSession({
      synthesizeChunk,
      playAudio,
      stopPlayback: stop,
      maxChunkSize: 400,
    });

    session.append('. '); // empty
    session.append('boom. ');
    const finalizePromise = session.finalize();
    await flushMicrotasks();

    calls[0]!.resolve(emptyBuffer());
    await flushMicrotasks();
    calls[1]!.reject(new Error('synthesis exploded'));
    await flushMicrotasks();

    await expect(finalizePromise).rejects.toThrow('synthesis exploded');
  });
});
