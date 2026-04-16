/**
 * SpeechStream state-machine tests.
 *
 * The stream is engine-agnostic by design: it takes an injected
 * `synthesize(text)` function and an injected `stop()`. We mock those
 * as controllable promises so every test can assert exactly when a
 * batch is dispatched and how batches are composed.
 *
 * Covers all load-bearing cases from the streaming-API spec:
 *   1. Single append with one sentence flushes immediately.
 *   2. Appends totalling < TARGET_CHARS don't flush until finalize.
 *   3. Appends crossing TARGET_CHARS during playback pre-queue a batch.
 *   4. Underrun with half a sentence — don't flush.
 *   5. Underrun with complete sentence + incomplete tail — flush the
 *      complete part, keep the tail.
 *   6. finalize() flushes the tail and resolves only after playback.
 */

import {SpeechStreamImpl} from '../SpeechStream';

/**
 * A mock synthesize function that exposes per-call promise handles so
 * tests can resolve them at the right moment.
 */
function makeControllableSynth() {
  type Call = {
    text: string;
    resolve: () => void;
    reject: (err: Error) => void;
    promise: Promise<void>;
  };
  const calls: Call[] = [];
  const synthesize = jest.fn((text: string) => {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const call: Call = {text, resolve, reject, promise};
    calls.push(call);
    return promise;
  });
  return {synthesize, calls};
}

/** Advance enough microtasks for inflight-finalize callbacks to run. */
async function flushMicrotasks() {
  // A handful of awaits — more than enough to unblock chained `.then`s.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('SpeechStream', () => {
  test('1. single append with one sentence flushes immediately', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({synthesize, stop});

    stream.append('Hello world. ');
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(calls[0]!.text).toBe('Hello world. ');
  });

  test('2. appends below target with no sentence boundary do not flush until finalize', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({
      synthesize,
      stop,
      options: {targetChars: 300},
    });

    stream.append('Hello');
    stream.append(' there');
    stream.append(' friend');
    await flushMicrotasks();

    expect(synthesize).not.toHaveBeenCalled();

    const finalizePromise = stream.finalize();
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(calls[0]!.text).toBe('Hello there friend');

    calls[0]!.resolve();
    await expect(finalizePromise).resolves.toBeUndefined();
  });

  test('2b. first sentence flushes; additional sub-target text waits for playback to finish', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({
      synthesize,
      stop,
      options: {targetChars: 300},
    });

    stream.append('First sentence. ');
    await flushMicrotasks();
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(calls[0]!.text).toBe('First sentence. ');

    // More short text arrives while batch 1 is playing, under target, no
    // complete sentence yet. No second flush should happen.
    stream.append('still typing');
    await flushMicrotasks();
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  test('3. crossing target during playback pre-queues a batched next call', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({
      synthesize,
      stop,
      options: {targetChars: 40},
    });

    stream.append('One. ');
    await flushMicrotasks();
    expect(synthesize).toHaveBeenCalledTimes(1);

    // Build buffer above target while batch 1 is still playing.
    stream.append('Two is here. Three is longer now. Four!');
    // "Two is here. Three is longer now. Four!" > 40 chars.
    await flushMicrotasks();

    // Second batch should already be queued. The stream pumps it only
    // after the first resolves.
    expect(synthesize).toHaveBeenCalledTimes(1);

    calls[0]!.resolve();
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(2);
    // Batch 2 should contain the complete sentences only — the trailing
    // "Four!" has no post-punctuation whitespace so it stays buffered.
    expect(calls[1]!.text).toBe('Two is here. Three is longer now. ');

    calls[1]!.resolve();
  });

  test('4. underrun with half a sentence does not flush', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({
      synthesize,
      stop,
      options: {targetChars: 300},
    });

    stream.append('First. ');
    await flushMicrotasks();
    expect(synthesize).toHaveBeenCalledTimes(1);

    stream.append('half a sent');
    await flushMicrotasks();

    // Resolve batch 1 → underrun moment. Buffer has no complete sentence.
    calls[0]!.resolve();
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  test('5. underrun with complete sentence + incomplete tail flushes only the complete part', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({
      synthesize,
      stop,
      options: {targetChars: 300},
    });

    stream.append('First. ');
    await flushMicrotasks();
    expect(synthesize).toHaveBeenCalledTimes(1);

    // Below target, no sentence end → no pre-queue during playback.
    stream.append('Second done. tail');
    await flushMicrotasks();
    expect(synthesize).toHaveBeenCalledTimes(1);

    // Resolve batch 1 to trigger the underrun guard.
    calls[0]!.resolve();
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(calls[1]!.text).toBe('Second done. ');

    // The tail should still be buffered; finalize flushes it.
    calls[1]!.resolve();
    const finalizePromise = stream.finalize();
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(calls[2]!.text).toBe('tail');

    calls[2]!.resolve();
    await expect(finalizePromise).resolves.toBeUndefined();
  });

  test('6. finalize flushes the tail and resolves only after playback completes', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({synthesize, stop});

    stream.append('Only sentence, no trailing space');
    await flushMicrotasks();
    expect(synthesize).not.toHaveBeenCalled();

    const finalizePromise = stream.finalize();
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(calls[0]!.text).toBe('Only sentence, no trailing space');

    // Finalize should still be pending since synth hasn't resolved.
    let settled = false;
    finalizePromise.then(() => (settled = true));
    await flushMicrotasks();
    expect(settled).toBe(false);

    calls[0]!.resolve();
    await expect(finalizePromise).resolves.toBeUndefined();
  });

  test('cancel clears the queue, stops in-flight, and ignores subsequent appends', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({synthesize, stop});

    stream.append('First. Second. ');
    await flushMicrotasks();
    expect(synthesize).toHaveBeenCalledTimes(1);

    await stream.cancel();
    expect(stop).toHaveBeenCalledTimes(1);

    // Resolve the in-flight as if the engine stopped — no follow-up.
    calls[0]!.resolve();
    stream.append('More text');
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  test('cancel during finalize resolves finalize without throwing', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({synthesize, stop});

    stream.append('Hello. ');
    await flushMicrotasks();
    const finalizePromise = stream.finalize();

    await stream.cancel();
    calls[0]!.resolve();

    await expect(finalizePromise).resolves.toBeUndefined();
  });

  test('CJK: chinese sentence flushes on 。 without trailing whitespace', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({synthesize, stop});

    // CJK punctuation is unambiguous — no trailing space needed. Without
    // this branch in the regex, nothing would flush until finalize and
    // CJK streaming would regress vs. the per-sentence fallback.
    stream.append('你好。');
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(calls[0]!.text).toBe('你好。');

    calls[0]!.resolve();
  });

  test('CJK: multiple consecutive CJK punct collapses into one boundary', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({synthesize, stop});

    stream.append('你好？！');
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(calls[0]!.text).toBe('你好？！');

    calls[0]!.resolve();
  });

  test('CJK: mixed ASCII + CJK handles both boundary styles', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({
      synthesize,
      stop,
      options: {targetChars: 300},
    });

    stream.append('Hello! ');
    await flushMicrotasks();
    expect(calls[0]!.text).toBe('Hello! ');

    // CJK follow-up arrives while batch 1 is playing — below target, so
    // no pre-queue during playback.
    stream.append('你好。再見。');
    await flushMicrotasks();
    expect(synthesize).toHaveBeenCalledTimes(1);

    // Resolve batch 1 → underrun fires, picks up all complete CJK sentences.
    calls[0]!.resolve();
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(calls[1]!.text).toBe('你好。再見。');

    calls[1]!.resolve();
  });

  test('CJK: ASCII decimal still not mistaken for sentence end', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const stream = new SpeechStreamImpl({synthesize, stop});

    // "3.14" should not match — the ASCII branch still requires
    // trailing whitespace. Only flushes on finalize.
    stream.append('3.14');
    await flushMicrotasks();
    expect(synthesize).not.toHaveBeenCalled();

    const finalizePromise = stream.finalize();
    await flushMicrotasks();

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(calls[0]!.text).toBe('3.14');

    calls[0]!.resolve();
    await expect(finalizePromise).resolves.toBeUndefined();
  });

  test('finalize rejects with synth error; onError callback receives it', async () => {
    const {synthesize, calls} = makeControllableSynth();
    const stop = jest.fn(async () => {});
    const onError = jest.fn();
    const stream = new SpeechStreamImpl({synthesize, stop, options: {onError}});

    stream.append('Boom. ');
    await flushMicrotasks();

    calls[0]!.reject(new Error('synth-failed'));
    await expect(stream.finalize()).rejects.toThrow('synth-failed');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({message: 'synth-failed'}),
    );
  });
});
