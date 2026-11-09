/**
 * Kitten and Kokoro pad every utterance with silence: Kitten ~0.6 s before
 * speech and ~0.4 s after (zeros, then a -40..-50 dB noise bed), Kokoro
 * ~0.4 s and ~0.55 s (zeros and a -60..-75 dB bed), so each chunk boundary
 * was a ~1 s pause. Cut both edges down to a short pad around the first
 * and last frame within THRESHOLD_DB of the loudest frame. Soft onsets
 * and tails (fricatives, breaths) rise through the threshold gradually,
 * so the pads keep them.
 */
const FRAME_MS = 10;
const THRESHOLD_DB = -35;
const LEAD_PAD_MS = 100;
const TRAIL_PAD_MS = 150;
const FADE_MS = 5;

export function trimEdgeSilence(
  samples: Float32Array,
  sampleRate: number,
): Float32Array {
  const hop = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frames = Math.floor(samples.length / hop);
  const rms = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const v = samples[i]!;
      acc += v * v;
    }
    rms[f] = Math.sqrt(acc / hop);
    if (rms[f]! > peak) peak = rms[f]!;
  }
  if (peak === 0) return samples;

  const threshold = peak * 10 ** (THRESHOLD_DB / 20);
  let first = 0;
  while (rms[first]! <= threshold) first++;
  let last = frames - 1;
  while (rms[last]! <= threshold) last--;

  const start = Math.max(
    0,
    first * hop - Math.round((sampleRate * LEAD_PAD_MS) / 1000),
  );
  const end = Math.min(
    samples.length,
    (last + 1) * hop + Math.round((sampleRate * TRAIL_PAD_MS) / 1000),
  );
  if (start === 0 && end === samples.length) return samples;

  const out = samples.slice(start, end);
  const fade = Math.min(
    Math.round((sampleRate * FADE_MS) / 1000),
    Math.floor(out.length / 2),
  );
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    if (start > 0) out[i]! *= g;
    if (end < samples.length) out[out.length - 1 - i]! *= g;
  }
  return out;
}
