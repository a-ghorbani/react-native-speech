/**
 * Kokoro TTS Engine Constants
 *
 * Centralized constants for the Kokoro neural TTS engine.
 * These values are derived from the Kokoro model architecture.
 */

/**
 * Core Kokoro constants
 */
export const KOKORO_CONSTANTS = {
  // Synthesis limits
  /** Maximum tokens the Kokoro model supports (0-509 voice embeddings) */
  MAX_TOKEN_LIMIT: 500,
  /** Default maximum chunk size in characters for text splitting */
  DEFAULT_MAX_CHUNK_SIZE: 400,

  // Tokenizer
  /** Boundary token ID used for sequence boundaries */
  BOUNDARY_TOKEN_ID: 0,

  // Voice embeddings
  /** Style embedding dimension (floats per embedding) */
  STYLE_DIM: 256,
  /** Maximum token positions for voice style selection */
  MAX_TOKENS: 509,
  /** Total embeddings per voice file (509 positions + 1) */
  TOTAL_EMBEDDINGS: 510,
  /** Expected size of a complete voice file: 510 × 256 = 130,560 floats */
  EXPECTED_VOICE_SIZE: 130560,

  // Audio output
  /** Sample rate in Hz for Kokoro audio output */
  SAMPLE_RATE: 24000,
  /** Audio channels (mono) */
  CHANNELS: 1,

  // Phonemization punctuation
  /** Characters preserved during phonemization */
  PUNCTUATION_CHARS: ';:,.!?¡¿—…"«»""(){}[]',

  // Supported languages
  AVAILABLE_LANGS: ['en-us', 'en-gb', 'ja', 'zh', 'ko'] as const,
} as const;

/**
 * Type for supported Kokoro language codes
 */
export type KokoroLanguage = (typeof KOKORO_CONSTANTS.AVAILABLE_LANGS)[number];

/**
 * Voice embedding validation constants
 */
export const VOICE_EMBEDDING_CONSTANTS = {
  /** Size of each style embedding in floats */
  STYLE_DIM: KOKORO_CONSTANTS.STYLE_DIM,
  /** Maximum token index for style selection (0-509) */
  MAX_TOKEN_INDEX: KOKORO_CONSTANTS.MAX_TOKENS,
  /** Total number of style embeddings per voice */
  TOTAL_EMBEDDINGS: KOKORO_CONSTANTS.TOTAL_EMBEDDINGS,
  /** Expected total floats per voice file */
  EXPECTED_SIZE: KOKORO_CONSTANTS.EXPECTED_VOICE_SIZE,
} as const;
