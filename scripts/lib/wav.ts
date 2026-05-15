/**
 * Minimal 16-bit PCM WAV writer for the multilingual verification harness.
 *
 * Supertonic vocoder outputs float32 samples in [-1, 1]; we clip and
 * quantize to int16 mono so Whisper can ingest the file directly.
 */
import {writeFileSync} from 'node:fs';

export function writeWavMono16(
  path: string,
  samples: Float32Array,
  sampleRate: number,
): void {
  const numSamples = samples.length;
  const byteRate = sampleRate * 2; // mono, 16-bit
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);

  // fmt chunk (PCM)
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }

  writeFileSync(path, buf);
}
