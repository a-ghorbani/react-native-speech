/**
 * Phonon TTS Engine Constants
 */

import type {PhononLanguage} from './types';

/** Engine id to pass to `Speech.initialize({engine: PHONON, ...})`. */
export const PHONON = 'phonon';

export const PHONON_CONSTANTS = {
  /** Default maximum characters per chunk for sentence-level chunking */
  DEFAULT_MAX_CHUNK_SIZE: 250,
  /** Model output sample rate in Hz (used when native reports 0) */
  SAMPLE_RATE: 24000,
  /** Default model language */
  DEFAULT_LANGUAGE: 'en' as PhononLanguage,
  /** Default iOS compute unit for the flow LM */
  DEFAULT_COMPUTE_UNIT: 'neuralEngine' as const,

  // Watchdog: every native synthesize races a timer of
  // max(WATCHDOG_MIN_MS, WATCHDOG_FACTOR × estimated synth time).
  /** Floor of the per-request watchdog */
  WATCHDOG_MIN_MS: 10_000,
  /** Multiplier over the estimated synth time */
  WATCHDOG_FACTOR: 4,
  /**
   * Estimated audio per input character (matches the native sink
   * pre-reservation). Supported devices synthesize at least in real time,
   * so this also bounds the expected synth time.
   */
  ESTIMATED_MS_PER_CHAR: 90,

  // A create queued behind a hung synth (an RN reload resets the JS broken
  // flag, not the native worker) would otherwise never settle.
  /** Budget of a native create (Android ~0.6 s, iOS compiled: seconds) */
  CREATE_WATCHDOG_MS: 120_000,
  /** Budget of a native create that has to compile Core ML first (iOS) */
  CREATE_COMPILE_WATCHDOG_MS: 600_000,
} as const;

/** Languages the Phonon FFI accepts (`ptts_set_language`). */
export const PHONON_LANGUAGES: readonly PhononLanguage[] = [
  'en',
  'fr',
  'de',
  'es',
  'pt',
  'none',
];
