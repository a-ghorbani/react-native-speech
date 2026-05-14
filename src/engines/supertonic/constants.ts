/**
 * Supertonic TTS Engine Constants
 *
 * Centralized constants from the official Supertonic tts.json config
 * and other shared values used across the engine.
 */

/**
 * Core Supertonic constants
 */
export const SUPERTONIC_CONSTANTS = {
  // Synthesis defaults
  /** Default maximum characters per chunk for sentence-level chunking */
  DEFAULT_MAX_CHUNK_SIZE: 400,
  /** Default number of diffusion steps (quality vs speed tradeoff) */
  DEFAULT_INFERENCE_STEPS: 5,

  // Speed calculation
  /** Offset used in speed-to-duration formula: factor = 1 / (speed + offset) */
  SPEED_OFFSET: 0.05,

  // Token IDs
  /** Pad token ID used for sequence padding */
  PAD_TOKEN_ID: 0,
  /** Unknown/OOV token ID for characters not in vocabulary */
  UNK_TOKEN_ID: 0,

  // Audio
  /** Vocoder output sample rate in Hz */
  SAMPLE_RATE: 44100,

  // Model dimensions (from tts.json)
  /** Base chunk size from ae.base_chunk_size in tts.json */
  AE_BASE_CHUNK_SIZE: 512,
  /** Chunk compression factor from ttl.chunk_compress_factor in tts.json */
  TTL_CHUNK_COMPRESS_FACTOR: 6,
  /** Base latent dimension from ttl.latent_dim in tts.json */
  LATENT_DIM: 24,
  /** Effective latent dimension (LATENT_DIM * TTL_CHUNK_COMPRESS_FACTOR) */
  EFFECTIVE_LATENT_DIM: 144, // 24 * 6
  /** Audio samples per latent frame (AE_BASE_CHUNK_SIZE * TTL_CHUNK_COMPRESS_FACTOR) */
  CHUNK_SIZE: 3072, // 512 * 6

  // Voice style dimensions
  /** Expected size of style_dp tensor [8, 16] = 128 elements */
  STYLE_DP_SIZE: 128,
  /** Expected size of style_ttl tensor [50, 256] = 12800 elements */
  STYLE_TTL_SIZE: 12800,

  // Supported languages — superset across all model versions.
  // v1 supports only 'en'; v2 supports 5 (en, ko, es, pt, fr); v3 supports all 31.
  // The engine doesn't enforce per-version subsets — it just wraps text in
  // `<lang>...</lang>` and lets the model handle it.
  AVAILABLE_LANGS: [
    'en',
    'ko',
    'ja',
    'ar',
    'bg',
    'cs',
    'da',
    'de',
    'el',
    'es',
    'et',
    'fi',
    'fr',
    'hi',
    'hr',
    'hu',
    'id',
    'it',
    'lt',
    'lv',
    'nl',
    'pl',
    'pt',
    'ro',
    'ru',
    'sk',
    'sl',
    'sv',
    'tr',
    'uk',
    'vi',
  ] as const,
} as const;

/**
 * Type for supported language codes (superset across all Supertonic versions)
 */
export type SupportedLanguage =
  (typeof SUPERTONIC_CONSTANTS.AVAILABLE_LANGS)[number];
