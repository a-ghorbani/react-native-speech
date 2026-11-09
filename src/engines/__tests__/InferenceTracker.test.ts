import {InferenceTracker} from '../InferenceTracker';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('forgets an inference once it settles', async () => {
  const t = new InferenceTracker();
  const a = deferred();
  const b = deferred();
  t.track(a.promise);
  t.track(b.promise).catch(() => {});
  const running = (t as any).running as Set<unknown>;
  expect(running.size).toBe(2);
  a.resolve();
  b.reject(new Error('run failed'));
  await tick();
  // Settled inferences (and the audio they hold) are not kept for the
  // life of the engine.
  expect(running.size).toBe(0);
});

describe('InferenceTracker.freeWhenIdle', () => {
  test('frees only after every tracked inference settled, failed ones included', async () => {
    const t = new InferenceTracker();
    const a = deferred();
    const b = deferred();
    t.track(a.promise);
    t.track(b.promise).catch(() => {});
    const free = jest.fn(async () => {});
    const done = t.freeWhenIdle(free, 1000);

    a.resolve();
    await tick();
    expect(free).not.toHaveBeenCalled();
    b.reject(new Error('run failed'));
    await done;
    expect(free).toHaveBeenCalledTimes(1);
  });

  test('does not wait for inference tracked after it was called', async () => {
    const t = new InferenceTracker();
    const free = jest.fn(async () => {});
    const done = t.freeWhenIdle(free, 1000);
    t.track(new Promise(() => {}));
    await done;
    expect(free).toHaveBeenCalledTimes(1);
  });

  test('past the timeout it resolves, and frees once the inference ends', async () => {
    const t = new InferenceTracker();
    const a = deferred();
    t.track(a.promise);
    const free = jest.fn(async () => {});

    await t.freeWhenIdle(free, 30);
    expect(free).not.toHaveBeenCalled();

    a.resolve();
    await tick();
    expect(free).toHaveBeenCalledTimes(1);
  });

  test('throws a free error within the wait; only logs one after it', async () => {
    const t = new InferenceTracker();
    await expect(
      t.freeWhenIdle(async () => {
        throw new Error('free failed');
      }, 1000),
    ).rejects.toThrow('free failed');

    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const a = deferred();
      t.track(a.promise);
      const late = jest.fn(async () => {
        throw new Error('late free failed');
      });
      await expect(t.freeWhenIdle(late, 30)).resolves.toBeUndefined();
      a.resolve();
      await tick(30);
      expect(late).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
