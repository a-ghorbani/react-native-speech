/**
 * Supertonic TTS specific types
 *
 * Supertonic is a fast neural TTS engine using a 4-model ONNX pipeline:
 * 1. Duration Predictor - predicts phoneme durations
 * 2. Text Encoder - encodes text into embeddings
 * 3. Vector Estimator - iterative diffusion for mel-spectrogram generation
 * 4. Vocoder - converts mel-spectrogram to audio waveform
 */

import type {SynthesisOptions} from './Engine';
import type {ExecutionProvider} from './Kokoro';

/**
 * Languages Supertonic can synthesize.
 *
 * Coverage depends on the loaded model version:
 * - v1: `'en'` only.
 * - v2: `'en' | 'ko' | 'es' | 'pt' | 'fr'`.
 * - v3: all 31 codes below.
 *
 * The engine doesn't verify the requested language against the loaded
 * model — pass a code the model wasn't trained on and you'll get
 * intelligible audio for the wrong locale (or noise). The example app's
 * `SupertonicModelManager` knows the per-version subset.
 */
export type SupertonicLanguage =
  | 'en'
  | 'ko'
  | 'ja'
  | 'ar'
  | 'bg'
  | 'cs'
  | 'da'
  | 'de'
  | 'el'
  | 'es'
  | 'et'
  | 'fi'
  | 'fr'
  | 'hi'
  | 'hr'
  | 'hu'
  | 'id'
  | 'it'
  | 'lt'
  | 'lv'
  | 'nl'
  | 'pl'
  | 'pt'
  | 'ro'
  | 'ru'
  | 'sk'
  | 'sl'
  | 'sv'
  | 'tr'
  | 'uk'
  | 'vi';

/**
 * Number of diffusion steps for vector estimation
 * Lower = faster but lower quality, higher = slower but better quality
 */
export type InferenceSteps = 1 | 2 | 3 | 4 | 5 | 10 | 20 | 50;

export interface SupertonicVoice {
  /** Voice identifier (e.g., 'F1', 'M2') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Voice description */
  description?: string;
  /** Gender (f = female, m = male) */
  gender?: 'f' | 'm';
}

export interface SupertonicSynthesisOptions extends SynthesisOptions {
  /** Voice identifier for Supertonic */
  voiceId: string;
  /** Speed control (0.5 - 2.0) */
  speed?: number;
  /** Number of diffusion inference steps (default: 5) */
  inferenceSteps?: InferenceSteps;
  /**
   * Language code for the input text. Determines the `<lang>...</lang>`
   * tag wrapped around text before tokenization.
   *
   * - v1 model: only `'en'` is meaningful; other values are ignored.
   * - v2 model: `'en' | 'ko' | 'es' | 'pt' | 'fr'`.
   * - v3 model: any of the 31 supported codes (see `SupertonicLanguage`).
   *
   * Defaults to `'en'`.
   */
  language?: SupertonicLanguage;
}

/**
 * Model paths for the 4-model Supertonic pipeline
 */
export interface SupertonicModelPaths {
  /** Path to duration predictor ONNX model */
  durationPredictorPath: string;
  /** Path to text encoder ONNX model */
  textEncoderPath: string;
  /** Path to vector estimator ONNX model (diffusion) */
  vectorEstimatorPath: string;
  /** Path to vocoder ONNX model */
  vocoderPath: string;
  /** Path to unicode indexer JSON file */
  unicodeIndexerPath: string;
}

export interface SupertonicConfig extends SupertonicModelPaths {
  /** Path to voices directory or manifest JSON */
  voicesPath: string;
  /** Default number of diffusion inference steps (default: 5) */
  defaultInferenceSteps?: InferenceSteps;
  /** Maximum chunk size in characters for streaming synthesis */
  maxChunkSize?: number;
  /**
   * Execution providers for ONNX Runtime inference, in fallback order.
   * Defaults to CoreML+xnnpack+cpu on iOS, xnnpack+cpu on Android when
   * omitted. See `KokoroConfig.executionProviders` for full semantics.
   */
  executionProviders?: ExecutionProvider[];
}

export interface SupertonicModelInfo {
  /** Model version (e.g., '1.0') */
  version: string;
  /** Model file size in bytes (total of all 4 models) */
  size: number;
  /** Whether model is currently installed */
  isInstalled: boolean;
  /** Local directory path if installed */
  path?: string;
  /** Supported languages */
  languages: SupertonicLanguage[];
}

/**
 * Voice style data loaded from JSON files
 * Contains embeddings for duration predictor and text encoder
 */
export interface SupertonicVoiceStyle {
  /** Voice ID */
  voiceId: string;
  /** Style embedding for duration predictor (style_dp) */
  styleDp: Float32Array;
  /** Style embedding for text-to-latent (style_ttl) */
  styleTtl: Float32Array;
}
