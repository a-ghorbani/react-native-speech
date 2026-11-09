import {trimEdgeSilence} from '../trimEdgeSilence';

const SR = 24000;
const tone = (ms: number, amp = 0.5) =>
  Float32Array.from(
    {length: (SR * ms) / 1000},
    (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SR),
  );
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const silence = (ms: number) => new Float32Array((SR * ms) / 1000);

describe('trimEdgeSilence', () => {
  test('cuts edge silence down to a 100 ms lead and 150 ms trail pad', () => {
    const out = trimEdgeSilence(
      concat(silence(600), tone(500), silence(400)),
      SR,
    );
    expect(out.length).toBe((SR * (100 + 500 + 150)) / 1000);
  });

  test('a fully silent buffer is returned as is', () => {
    const s = silence(1000);
    expect(trimEdgeSilence(s, SR)).toBe(s);
  });

  test('a buffer shorter than one frame is returned as is', () => {
    const s = tone(5);
    expect(trimEdgeSilence(s, SR)).toBe(s);
  });

  test('a buffer with less silence than the pads is returned as is', () => {
    const s = concat(silence(50), tone(300), silence(100));
    expect(trimEdgeSilence(s, SR)).toBe(s);
  });

  test('fades in and out over the cut edges only', () => {
    const noisy = (ms: number) =>
      Float32Array.from({length: (SR * ms) / 1000}, () => 0.001);
    const out = trimEdgeSilence(concat(noisy(600), tone(500), noisy(400)), SR);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(0);
    expect(out[SR * 0.005]).toBeCloseTo(0.001, 6);
  });
});
