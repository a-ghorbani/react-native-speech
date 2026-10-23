import {
  base64Bytes,
  checkEventOrder,
  classifyColdRun,
  formatOps,
  genFuzzOps,
  iterationSeed,
  median,
  pcm16Ms,
  seededRng,
  tailOffsetMs,
  trackPromise,
  unsettled,
  vmRssMb,
  type ColdRunShape,
  type TimedEvent,
} from '../edgesCore';

describe('seededRng', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const xs = Array.from({length: 1000}, () => a());
    expect(Array.from({length: 1000}, () => b())).toEqual(xs);
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(990);
  });

  it('differs across seeds', () => {
    expect(seededRng(1)()).not.toBe(seededRng(2)());
  });
});

describe('iterationSeed', () => {
  it('is stable and distinct per iteration', () => {
    expect(iterationSeed(7, 3)).toBe(iterationSeed(7, 3));
    const seeds = new Set(
      Array.from({length: 500}, (_, i) => iterationSeed(7, i)),
    );
    expect(seeds.size).toBe(500);
    expect(iterationSeed(7, 0)).not.toBe(iterationSeed(8, 0));
  });
});

describe('genFuzzOps', () => {
  it('replays the same sequence from the same seed', () => {
    const ops = genFuzzOps(seededRng(iterationSeed(1, 5)), 4);
    expect(genFuzzOps(seededRng(iterationSeed(1, 5)), 4)).toEqual(ops);
    expect(formatOps(ops)).toMatch(/^\+\d+:\w+/);
  });

  it('respects op count, delay and text bounds', () => {
    const kinds = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const ops = genFuzzOps(seededRng(i), 3, 6, 1500);
      expect(ops.length).toBeGreaterThanOrEqual(2);
      expect(ops.length).toBeLessThanOrEqual(6);
      for (const o of ops) {
        kinds.add(o.op);
        expect(o.delayMs).toBeGreaterThanOrEqual(0);
        expect(o.delayMs).toBeLessThanOrEqual(1500);
        if ('text' in o) {
          expect(o.text).toBeGreaterThanOrEqual(0);
          expect(o.text).toBeLessThan(3);
        }
      }
    }
    expect([...kinds].sort()).toEqual([
      'pause',
      'resume',
      'speak',
      'stop',
      'stream',
    ]);
  });
});

const ev = (t: number, kind: string, id?: number): TimedEvent => ({
  t,
  kind,
  id,
});

describe('checkEventOrder', () => {
  it('accepts start → pause → resume → finish', () => {
    const r = checkEventOrder([
      ev(0, 'start', 1),
      ev(10, 'pause', 1),
      ev(20, 'resume', 1),
      ev(30, 'finish', 1),
      ev(31, 'start', 2),
      ev(40, 'stopped', 2),
    ]);
    expect(r).toEqual({violations: [], lateStopped: 0});
  });

  it('flags finish without start, while paused, and after end', () => {
    const r = checkEventOrder([
      ev(0, 'finish', 1),
      ev(5, 'start', 2),
      ev(6, 'pause', 2),
      ev(7, 'finish', 2),
      ev(8, 'start', 3),
      ev(9, 'stopped', 3),
      ev(10, 'finish', 3),
    ]);
    expect(r.violations.map(v => v.rule)).toEqual([
      'finish without start',
      'finish while paused',
      'finish after end',
    ]);
  });

  it('flags a repeated start and resume without pause', () => {
    const r = checkEventOrder([
      ev(0, 'start', 1),
      ev(1, 'resume', 1),
      ev(2, 'start', 1),
    ]);
    expect(r.violations.map(v => v.rule)).toEqual([
      'resume while playing',
      'start after start',
    ]);
  });

  it('counts stopped after an end separately and ignores harness marks', () => {
    const r = checkEventOrder([
      ev(0, 'speak_call'),
      ev(1, 'start', 4),
      ev(2, 'finish', 4),
      ev(3, 'stopped', 4),
      ev(4, 'stopped', 9),
    ]);
    expect(r).toEqual({violations: [], lateStopped: 1});
  });
});

describe('trackPromise', () => {
  it('records one settle with time and outcome', async () => {
    let now = 5;
    const ok = trackPromise('a', Promise.resolve(1), () => now);
    now = 9;
    const bad = trackPromise('b', Promise.reject(new Error('x')), () => now);
    const hang = trackPromise('c', new Promise(() => {}), () => now);
    await Promise.all([ok.done, bad.done]);
    expect(ok.rec).toMatchObject({
      issuedAt: 5,
      settledAt: 9,
      settles: 1,
      outcome: 'resolved',
    });
    expect(bad.rec).toMatchObject({settles: 1, outcome: 'rejected'});
    expect(bad.rec.error).toContain('x');
    expect(unsettled([ok.rec, bad.rec, hang.rec])).toEqual([hang.rec]);
  });
});

describe('PCM and /proc helpers', () => {
  it('decodes base64 lengths', () => {
    expect(base64Bytes('')).toBe(0);
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(base64Bytes('AA==')).toBe(1);
    expect(base64Bytes(Buffer.alloc(4800).toString('base64'))).toBe(4800);
  });

  it('converts 16-bit PCM bytes to ms', () => {
    expect(pcm16Ms(48000, 24000, 1)).toBe(1000);
    expect(pcm16Ms(96000, 24000, 2)).toBe(1000);
    expect(pcm16Ms(100, 0, 1)).toBe(0);
  });

  it('reads VmRSS', () => {
    expect(vmRssMb('Name:\tx\nVmRSS:\t  204800 kB\nVmSwap: 0 kB')).toBe(200);
    expect(vmRssMb('Name:\tx')).toBeNull();
  });

  it('clamps tail offsets at the chunk start', () => {
    expect(tailOffsetMs(1000, 200)).toBe(800);
    expect(tailOffsetMs(100, 200)).toBe(0);
  });

  it('takes the median of finite values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2, Number.NaN])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('classifyColdRun', () => {
  const warm: ColdRunShape = {
    spanMs: 6700,
    chunks: 2,
    pcmMs: 6500,
    startDelayMs: 300,
    minFinishMarginMs: 20,
  };

  it('is consistent within tolerance', () => {
    expect(classifyColdRun({...warm, spanMs: 6750}, warm, 100)).toBe(
      'consistent',
    );
  });

  it('names the first differing component', () => {
    expect(classifyColdRun({...warm, chunks: 1}, warm, 100)).toBe(
      'different_chunking',
    );
    expect(
      classifyColdRun({...warm, pcmMs: 5000, spanMs: 5220}, warm, 100),
    ).toBe('different_pcm');
    expect(
      classifyColdRun(
        {...warm, spanMs: 5220, minFinishMarginMs: -1400},
        warm,
        100,
      ),
    ).toBe('early_finish');
    expect(
      classifyColdRun({...warm, spanMs: 5220, startDelayMs: 1800}, warm, 100),
    ).toBe('late_start');
  });
});
