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
import type {ExecutionProvider, ExecutionProviderPreset} from './Kokoro';

export type SupertonicLanguage = 'en'; // Currently only English

/**
 * Number of diffusion steps for vector estimation
 * Lower = faster but lower quality, higher = slower but better quality
 */
export type InferenceSteps = 1 | 2 | 3 | 4 | 5 | 10 | 20 | 50;

export interface SupertonicVoice {
  /** Voice identifier (e.g., 'af_heart', 'am_adam') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Voice description */
  description?: string;
  /** Language code */
  language: SupertonicLanguage;
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
   * Execution provider preference for ONNX Runtime
   * Can be a preset string or array of specific providers
   */
  executionProviders?: ExecutionProviderPreset | ExecutionProvider[];
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
