/**
 * Kokoro TTS specific types
 */

import type {SynthesisOptions} from './Engine';

export type ModelVariant = 'full' | 'fp16' | 'q8' | 'quantized';

export type SupportedLanguage = 'en' | 'zh' | 'ko' | 'ja';

export interface KokoroVoice {
  /** Voice identifier (e.g., 'af_bella', 'am_michael') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Voice gender */
  gender: 'male' | 'female';
  /** Language code */
  language: SupportedLanguage;
  /** Voice description */
  description?: string;
}

export interface KokoroSynthesisOptions extends SynthesisOptions {
  /** Voice identifier for Kokoro */
  voiceId: string;
  /** Speed control (0.5 - 2.0) */
  speed?: number;
  /** Voice blending options */
  voiceBlend?: {
    /** Array of voice IDs to blend */
    voices: string[];
    /** Weights for each voice (must sum to 1.0) */
    weights: number[];
  };
}

export interface ModelInfo {
  /** Model version (e.g., '1.0', '1.1') */
  version: string;
  /** Model variant */
  variant: ModelVariant;
  /** Model file size in bytes */
  size: number;
  /** Whether model is currently installed */
  isInstalled: boolean;
  /** Local file path if installed */
  path?: string;
  /** Supported languages */
  languages: SupportedLanguage[];
}

export interface ModelDownloadProgress {
  /** Total bytes to download */
  totalBytes: number;
  /** Bytes downloaded so far */
  downloadedBytes: number;
  /** Download progress (0-1) */
  progress: number;
  /** Download speed in bytes/sec */
  speed?: number;
  /** Estimated time remaining in seconds */
  estimatedTimeRemaining?: number;
}

export interface KokoroConfig {
  /** Path to ONNX model file */
  modelPath: string;
  /** Path to voices binary file */
  voicesPath: string;
  /** Path to tokenizer JSON file (HuggingFace format) - alternative to vocabPath+mergesPath */
  tokenizerPath?: string;
  /** Path to vocabulary JSON file (legacy format) */
  vocabPath?: string;
  /** Path to BPE merges file (legacy format) */
  mergesPath?: string;
  /** Phonemizer type: 'remote' uses server API, 'native' uses native module, 'none' disables phonemization */
  phonemizerType?: 'remote' | 'native' | 'none';
  /** URL for remote phonemizer server (default: http://localhost:3000) */
  phonemizerUrl?: string;
}

export interface TokenizerConfig {
  /** BPE vocabulary mapping token -> id */
  vocab: Map<string, number>;
  /** BPE merge operations */
  merges: Array<[string, string]>;
  /** Unknown token ID */
  unkTokenId: number;
  /** Beginning of sequence token ID */
  bosTokenId: number;
  /** End of sequence token ID */
  eosTokenId: number;
  /** Padding token ID */
  padTokenId: number;
}

export interface VoiceEmbedding {
  /** Voice ID */
  voiceId: string;
  /** Embedding vector (typically 256 dimensions for Kokoro) */
  embedding: Float32Array;
}
