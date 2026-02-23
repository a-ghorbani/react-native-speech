/**
 * Pocket TTS specific types
 *
 * Pocket TTS is a 100M-parameter CALM-based neural TTS engine by Kyutai Labs.
 * Uses a 4-ONNX-session pipeline with autoregressive generation:
 * 1. Text Conditioner - converts token IDs to embeddings
 * 2. Flow LM Main - multi-pass: voice conditioning → text conditioning → autoregressive
 * 3. Flow LM Flow - LSD flow matching (Euler ODE integration)
 * 4. Mimi Decoder - stateful neural audio codec decoder
 *
 * Plus a pure-JS SentencePiece tokenizer (not ONNX).
 *
 * State management: flow_lm_main and mimi_decoder are stateful models with
 * individual state tensors (state_0...state_N) discovered at runtime from
 * session.inputNames. States are initialized to zeros and updated from outputs.
 */

import type {SynthesisOptions} from './Engine';
import type {ExecutionProvider, ExecutionProviderPreset} from './Kokoro';

export type PocketLanguage = 'en';

/**
 * Number of LSD decode steps (quality vs speed tradeoff)
 * 1 = fastest, 10 = highest quality
 */
export type LsdSteps = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * Built-in Pocket TTS voice identifiers
 * Named after Les Miserables characters
 */
export type PocketBuiltinVoice =
  | 'alba'
  | 'marius'
  | 'javert'
  | 'jean'
  | 'fantine'
  | 'cosette'
  | 'eponine'
  | 'azelma';

export interface PocketVoice {
  /** Voice identifier (e.g., 'alba', 'marius') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Voice description */
  description?: string;
  /** Language code */
  language: PocketLanguage;
  /** Gender (f = female, m = male) */
  gender?: 'f' | 'm';
  /** Whether this is a built-in voice or cloned */
  isBuiltin: boolean;
}

export interface PocketSynthesisOptions extends SynthesisOptions {
  /** Voice identifier for Pocket TTS */
  voiceId: string;
  /** Number of LSD flow decode steps (default: 4) */
  lsdSteps?: LsdSteps;
  /** Temperature for autoregressive sampling (default: 0.7) */
  temperature?: number;
  /** EOS raw logit threshold to stop generation (default: -4.0) */
  eosThreshold?: number;
  /** Maximum number of autoregressive tokens per chunk (safety limit) */
  maxTokens?: number;
}

/**
 * Model paths for the 4-ONNX-session Pocket TTS pipeline
 */
export interface PocketModelPaths {
  /** Path to text_conditioner.onnx */
  textConditionerPath: string;
  /** Path to flow_lm_main.onnx (stateful) */
  flowLmMainPath: string;
  /** Path to flow_lm_flow.onnx */
  flowLmFlowPath: string;
  /** Path to mimi_decoder.onnx (stateful, decoder state) */
  mimiDecoderPath: string;
  /** Path to SentencePiece tokenizer .model file */
  tokenizerModelPath: string;
}

/**
 * Optional model paths for voice cloning (future extension)
 */
export interface PocketVoiceCloningPaths {
  /** Path to mimi_encoder.onnx (for voice cloning) */
  mimiEncoderPath: string;
}

export interface PocketConfig extends PocketModelPaths {
  /** Path to voice embeddings directory or manifest JSON */
  voiceEmbeddingsPath: string;
  /** Default number of LSD steps (default: 4) */
  defaultLsdSteps?: LsdSteps;
  /** Default temperature (default: 0.7) */
  defaultTemperature?: number;
  /** Default EOS threshold (default: -4.0) */
  defaultEosThreshold?: number;
  /** Default maximum tokens per autoregressive generation (default: 500) */
  defaultMaxTokens?: number;
  /** Maximum chunk size in characters for streaming synthesis */
  maxChunkSize?: number;
  /** Execution provider preference for ONNX Runtime */
  executionProviders?: ExecutionProviderPreset | ExecutionProvider[];
  /** Optional voice cloning model paths (future extension) */
  voiceCloning?: PocketVoiceCloningPaths;
}

export interface PocketModelInfo {
  /** Model version */
  version: string;
  /** Total model file size in bytes */
  size: number;
  /** Whether models are currently installed */
  isInstalled: boolean;
  /** Local directory path if installed */
  path?: string;
  /** Supported languages */
  languages: PocketLanguage[];
}

/**
 * Individual state tensor for stateful ONNX models.
 * State tensors (state_0, state_1, ...) are discovered at runtime
 * from session.inputNames. Initial shapes come from session metadata
 * or are discovered via a warm-up pass.
 */
export interface StateTensor {
  /** Tensor data (Float32Array for float32, BigInt64Array for int64, Uint8Array for bool) */
  data: Float32Array | BigInt64Array | Uint8Array;
  /** Tensor dimensions */
  dims: number[];
  /** Data type */
  dtype: 'float32' | 'int64' | 'bool';
}

/**
 * Collection of state tensors for a stateful ONNX model.
 * Maps state_N → tensor data.
 */
export type StateTensorMap = Record<string, StateTensor>;

/**
 * Pre-computed voice embedding for a Pocket TTS voice.
 * Multi-frame tensor from mimi_encoder output.
 */
export interface PocketVoiceEmbedding {
  /** Voice ID */
  voiceId: string;
  /** Voice conditioning data (flattened multi-frame tensor) */
  data: Float32Array;
  /** Tensor dimensions [1, num_frames, embedding_dim] */
  dims: number[];
}
