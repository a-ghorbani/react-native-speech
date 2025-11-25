/**
 * Audio conversion utilities for neural TTS engines
 * Converts Float32Array PCM to Int16 PCM and encodes to base64 for native bridge transfer
 */

import {Buffer} from 'buffer';

/**
 * Convert Float32Array PCM samples to Int16 PCM
 * @param float32Samples - Audio samples in Float32 format (range -1.0 to 1.0)
 * @returns Int16Array PCM samples (range -32768 to 32767)
 */
export function float32ToInt16(float32Samples: Float32Array): Int16Array {
  const int16Samples = new Int16Array(float32Samples.length);

  for (let i = 0; i < float32Samples.length; i++) {
    // Clamp to -1.0 to 1.0 range
    const sample = Math.max(-1.0, Math.min(1.0, float32Samples[i] ?? 0));

    // Convert to Int16 range (-32768 to 32767)
    // Use 32767 instead of 32768 to avoid overflow
    int16Samples[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }

  return int16Samples;
}

/**
 * Convert Int16Array to base64-encoded string for native bridge transfer
 * @param int16Samples - Audio samples in Int16 format
 * @returns Base64-encoded string
 */
export function int16ToBase64(int16Samples: Int16Array): string {
  // Create a buffer from Int16Array
  const buffer = Buffer.from(int16Samples.buffer);

  // Encode to base64
  return buffer.toString('base64');
}

/**
 * Convert Float32Array PCM to base64-encoded Int16 PCM
 * This is the main conversion function used by neural engines
 * @param float32Samples - Audio samples in Float32 format (range -1.0 to 1.0)
 * @returns Base64-encoded Int16 PCM string
 */
export function float32ToBase64Int16(float32Samples: Float32Array): string {
  const int16Samples = float32ToInt16(float32Samples);
  return int16ToBase64(int16Samples);
}

/**
 * Estimate the size of base64-encoded audio data
 * Useful for logging and debugging
 * @param sampleCount - Number of audio samples
 * @returns Estimated size in bytes
 */
export function estimateBase64Size(sampleCount: number): number {
  // Int16 = 2 bytes per sample
  // Base64 encoding increases size by ~33%
  return Math.ceil((sampleCount * 2 * 4) / 3);
}

/**
 * Calculate audio duration from sample count and sample rate
 * @param sampleCount - Number of audio samples
 * @param sampleRate - Sample rate in Hz
 * @returns Duration in seconds
 */
export function calculateDuration(
  sampleCount: number,
  sampleRate: number,
): number {
  return sampleCount / sampleRate;
}
