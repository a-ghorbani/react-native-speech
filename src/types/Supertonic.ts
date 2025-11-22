/**
 * Supertonic TTS specific types
 */

import type {SynthesisOptions} from './Engine';

export type SupertonicLanguage = 'en'; // Currently only English

export type InferenceSteps = 2 | 5; // 2-step for speed, 5-step for quality

export interface SupertonicVoice {
  /** Voice identifier (e.g., 'preset_1', 'preset_2') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Voice description */
  description?: string;
  /** Language code */
  language: SupertonicLanguage;
}

export interface SupertonicSynthesisOptions extends SynthesisOptions {
  /** Voice identifier for Supertonic */
  voiceId: string;
  /** Speed control (0.5 - 2.0) */
  speed?: number;
  /** Number of inference steps (2 for speed, 5 for quality) */
  inferenceSteps?: InferenceSteps;
}

export interface SupertonicConfig {
  /** Path to ONNX model file */
  modelPath: string;
  /** Path to voices/presets file */
  voicesPath: string;
  /** Default number of inference steps (default: 2) */
  defaultInferenceSteps?: InferenceSteps;
}

export interface SupertonicModelInfo {
  /** Model version (e.g., '1.0') */
  version: string;
  /** Model file size in bytes */
  size: number;
  /** Whether model is currently installed */
  isInstalled: boolean;
  /** Local file path if installed */
  path?: string;
  /** Supported languages */
  languages: SupertonicLanguage[];
}

export interface VoicePreset {
  /** Voice ID */
  voiceId: string;
  /** Embedding vector for the voice */
  embedding: Float32Array;
}
