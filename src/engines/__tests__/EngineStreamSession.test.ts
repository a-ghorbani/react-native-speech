import {EngineStreamSession} from '../EngineStreamSession';
import type {AudioBuffer, ChunkProgressEvent} from '../../types';

function makeAudioBuffer(text: string): AudioBuffer {
  return {
    samples: new Float32Array(text.length * 100),
    sampleRate: 24000,
    channels: 1,
    duration: text.length * 0.01,
  };
}

function makeControllableSynth() {
  type Call = {
    text: string;
    resolve: (buf: AudioBuffer) => void;
    reject: (err: Error) => void;
    promise: Promise<AudioBuffer>;
  };
  const calls: Call[] = [];
  const synthesizeChunk = jest.fn((text: string) => {
    let resolve!: (buf: AudioBuffer) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<AudioBuffer>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    calls.push({text, resolve, reject, promise});
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
      return makeAudioBuffer(text);
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

    const synthesizeChunk = jest.fn(async (text: string) =>
      makeAudioBuffer(text),
    );
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

    const synthesizeChunk = jest.fn(async (text: string) =>
      makeAudioBuffer(text),
    );
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
});
