import {RunAborter} from '../RunAborter';

const OUT = {waveform: {data: new Float32Array(1), dims: [1], type: 'float32'}};
const tick = () => new Promise(r => setTimeout(r, 0));

/** A session whose run settles by hand; `patched` rejects it on abort, like the patched binding. */
function session(patched: boolean) {
  const calls: unknown[][] = [];
  const settle: Array<(v?: unknown) => void> = [];
  const s = {
    run: jest.fn((...args: unknown[]) => {
      calls.push(args);
      return new Promise((resolve, reject) => {
        settle.push(resolve);
        const signal = (args[1] as {signal?: AbortSignal} | undefined)?.signal;
        if (patched) {
          signal?.addEventListener('abort', () =>
            reject(
              new Error('Exiting due to terminate flag being set to true.'),
            ),
          );
        }
      });
    }),
  };
  return {
    s: s as any,
    calls,
    finish: () => settle.splice(0).forEach(f => f(OUT)),
  };
}

afterEach(() => {
  delete (globalThis as any).OrtApi;
});

test('bridge binding (no OrtApi): run(feeds) exactly as before, abort is a no-op', async () => {
  const r = new RunAborter();
  const {s, calls, finish} = session(true);
  const p = r.run(s, {});
  expect(calls[0]).toHaveLength(1);
  r.abortAll();
  finish();
  await expect(p).resolves.toBe(OUT);
});

test('unpatched JSI binding: run completes after abort and its outputs are returned', async () => {
  (globalThis as any).OrtApi = {};
  const r = new RunAborter();
  const {s, calls, finish} = session(false);
  const p = r.run(s, {});
  expect((calls[0]![1] as any).signal).toBeDefined();
  r.abortAll();
  await tick();
  finish();
  await expect(p).resolves.toBe(OUT);
});

test('patched binding: abortAll() ends every run in flight with null', async () => {
  (globalThis as any).OrtApi = {};
  const r = new RunAborter();
  const {s} = session(true);
  const a = r.run(s, {});
  const b = r.run(s, {});
  r.abortAll();
  await expect(a).resolves.toBeNull();
  await expect(b).resolves.toBeNull();
});

test('a run started after abortAll() is not aborted by it', async () => {
  (globalThis as any).OrtApi = {};
  const r = new RunAborter();
  const {s, finish} = session(true);
  const old = r.run(s, {});
  r.abortAll();
  const next = r.run(s, {});
  await expect(old).resolves.toBeNull();
  finish();
  await expect(next).resolves.toBe(OUT);
});

test('an error from a run that was not aborted is thrown', async () => {
  (globalThis as any).OrtApi = {};
  const r = new RunAborter();
  const s = {
    run: jest.fn(() => Promise.reject(new Error('invalid expand shape'))),
  };
  await expect(r.run(s as any, {})).rejects.toThrow('invalid expand shape');
});

test('settled runs are forgotten, so abortAll() only reaches runs in flight', async () => {
  (globalThis as any).OrtApi = {};
  const r = new RunAborter();
  const {s, finish} = session(false);
  const done = r.run(s, {});
  finish();
  await done;
  await r
    .run({run: () => Promise.reject(new Error('x'))} as any, {})
    .catch(() => {});
  expect((r as any).controllers.size).toBe(0);
});
