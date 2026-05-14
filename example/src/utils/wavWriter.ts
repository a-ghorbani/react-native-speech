/**
 * Write a 16-bit PCM mono WAV file from accumulated synthesis chunks.
 *
 * Used by the example app's "Save WAV" toggle. Mirrors the WAV format
 * written by `scripts/lib/wav.ts` so an on-device capture and a Node
 * harness capture are byte-comparable.
 */
import * as RNFS from '@dr.pogodin/react-native-fs';

import type {AudioBuffer} from '@pocketpalai/react-native-speech';

/**
 * Concatenate captured float32 chunks into a single buffer.
 *
 * Returns an empty Float32Array if `chunks` is empty so callers can
 * detect "nothing was synthesized" without a null check.
 */
function concatChunks(chunks: AudioBuffer[]): {
  samples: Float32Array;
  sampleRate: number;
} {
  if (chunks.length === 0) return {samples: new Float32Array(0), sampleRate: 0};
  const sampleRate = chunks[0]!.sampleRate;
  let total = 0;
  for (const c of chunks) total += c.samples.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c.samples, offset);
    offset += c.samples.length;
  }
  return {samples: out, sampleRate};
}

function buildWavBytes(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const byteRate = sampleRate * 2; // mono, 16-bit
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  // RIFF / WAVE header (canonical 16-bit PCM mono)
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }

  return new Uint8Array(buf);
}

function bytesToBase64(bytes: Uint8Array): string {
  // React Native's `global.btoa` only accepts strings, so we chunk the
  // byte array through fromCharCode to avoid the args-length cap.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize)),
    );
  }
  return global.btoa(binary);
}

export interface SaveWavResult {
  path: string;
  bytes: number;
  durationSec: number;
  sampleRate: number;
}

/**
 * Write concatenated chunks to `DocumentDirectoryPath/<filename>` and
 * return the saved path. Filename should include `.wav`.
 */
export async function saveChunksAsWav(
  chunks: AudioBuffer[],
  filename: string,
): Promise<SaveWavResult> {
  const {samples, sampleRate} = concatChunks(chunks);
  if (samples.length === 0 || sampleRate === 0) {
    throw new Error('No audio captured');
  }
  const wav = buildWavBytes(samples, sampleRate);
  const path = `${RNFS.DocumentDirectoryPath}/${filename}`;
  await RNFS.writeFile(path, bytesToBase64(wav), 'base64');
  return {
    path,
    bytes: wav.byteLength,
    durationSec: samples.length / sampleRate,
    sampleRate,
  };
}
