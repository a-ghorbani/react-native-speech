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
  test('with nothing running, frees before it resolves and throws its error', async () => {
    const t = new InferenceTracker();
    const free = jest.fn(async () => {});
    await t.freeWhenIdle(free);
    expect(free).toHaveBeenCalledTimes(1);

    await expect(
      t.freeWhenIdle(async () => {
        throw new Error('free failed');
      }),
    ).rejects.toThrow('free failed');
  });

  test('with inference running, resolves at once and frees after every tracked one settled, failed ones included', async () => {
    const t = new InferenceTracker();
    const a = deferred();
    const b = deferred();
    t.track(a.promise);
    t.track(b.promise).catch(() => {});
    const free = jest.fn(async () => {});

    await t.freeWhenIdle(free);
    expect(free).not.toHaveBeenCalled();
    a.resolve();
    await tick();
    expect(free).not.toHaveBeenCalled();
    b.reject(new Error('run failed'));
    await tick();
    expect(free).toHaveBeenCalledTimes(1);
  });

  test('does not wait for inference tracked after it was called', async () => {
    const t = new InferenceTracker();
    const a = deferred();
    t.track(a.promise);
    const free = jest.fn(async () => {});
    await t.freeWhenIdle(free);
    t.track(new Promise(() => {}));
    a.resolve();
    await tick();
    expect(free).toHaveBeenCalledTimes(1);
  });

  test('a deferred free that fails is logged, not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const t = new InferenceTracker();
      const a = deferred();
      t.track(a.promise);
      const late = jest.fn(async () => {
        throw new Error('late free failed');
      });
      await t.freeWhenIdle(late);
      a.resolve();
      await tick(30);
      expect(late).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
