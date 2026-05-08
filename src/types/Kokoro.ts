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
  /** Phonemizer type: 'js' uses pure-JS GPL-free phonemizer (recommended), 'js-ipa' returns raw IPA without Kokoro post-processing, 'none' disables phonemization */
  phonemizerType?: 'js' | 'js-ipa' | 'none';
  /**
   * Path to the IPA dictionary TSV file (word<TAB>ipa per line).
   * Required when `phonemizerType` is 'js' (or unset, which defaults to 'js').
   * Accepts file:// and https:// URLs.
   */
  dictPath?: string;
  /**
   * Maximum chunk size in characters for text splitting (default: 400)
   * Smaller values = faster first audio & more progress events, but more inference calls
   * Larger values = fewer inference calls, but longer wait before first audio
   * Set to a small value (e.g., 100-200) for streaming-like UX
   */
  maxChunkSize?: number;
  /**
   * Execution providers for ONNX Runtime inference
   * Controls hardware acceleration (GPU, ANE on iOS; NNAPI on Android)
   *
   * Can be:
   * - A preset string: 'auto' | 'cpu' | 'gpu' | 'ane'
   * - An array of execution providers with fallback order
   *
   * Default: 'auto' (CoreML with GPU on iOS, NNAPI on Android, with CPU fallback)
   *
   * @example
   * // Use automatic platform-specific acceleration
   * executionProviders: 'auto'
   *
   * @example
   * // Force CPU-only execution
   * executionProviders: 'cpu'
   *
   * @example
   * // Custom provider configuration with CoreML options
   * executionProviders: [
   *   { name: 'coreml', useCPUAndGPU: true, enableOnSubgraph: true },
   *   'cpu'
   * ]
   */
  executionProviders?: ExecutionProviderPreset | ExecutionProvider[];
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

/**
 * CoreML EP flag bits — bit-OR these into `coreMlFlags`. Mirrors
 * `coreml_provider_factory.h` in onnxruntime.
 *
 * IMPORTANT: The high-level option fields (`useCPUOnly`, `useCPUAndGPU`,
 * `enableOnSubgraph`, `onlyEnableDeviceWithANE`) defined in
 * `onnxruntime-common`'s `CoreMLExecutionProviderOption` are NOT honored
 * by the `onnxruntime-react-native` native bridge. The bridge only reads
 * `coreMlFlags` (numeric). Use these constants instead.
 */
export const CoreMlFlag = {
  USE_CPU_ONLY: 0x001,
  ENABLE_ON_SUBGRAPH: 0x002,
  ONLY_ENABLE_DEVICE_WITH_ANE: 0x004,
  ONLY_ALLOW_STATIC_INPUT_SHAPES: 0x008,
  CREATE_MLPROGRAM: 0x010,
  USE_CPU_AND_GPU: 0x020,
} as const;

/**
 * Sensible defaults for CoreML — enable on subgraphs (broader op
 * coverage) and use CPU+GPU (lets Metal accelerate where possible).
 * Excludes ANE-only and CPU-only since those force narrower behavior
 * that hurts most models.
 */
export const DEFAULT_COREML_FLAGS =
  // eslint-disable-next-line no-bitwise
  CoreMlFlag.ENABLE_ON_SUBGRAPH | CoreMlFlag.USE_CPU_AND_GPU;

/**
 * CoreML execution provider options for iOS.
 *
 * Only `coreMlFlags` is wired through the React Native bridge. The
 * high-level booleans (`useCPUOnly`, etc.) are TypeScript-only and have
 * no runtime effect.
 */
export interface CoreMLExecutionProviderOption {
  readonly name: 'coreml';
  /** Bit-OR of CoreMlFlag values. Defaults to no flags (0) if omitted. */
  coreMlFlags?: number;
}

/**
 * XNNPACK execution provider options.
 * Optimized CPU kernels — works on both iOS and Android.
 */
export interface XNNPackExecutionProviderOption {
  readonly name: 'xnnpack';
}

/**
 * CPU execution provider options.
 */
export interface CPUExecutionProviderOption {
  readonly name: 'cpu';
}

/**
 * Union type for supported execution providers.
 *
 * NOTE: NNAPI was removed from this union — Android's NNAPI OS API was
 * deprecated in Android 15 (no longer developed by Google). XNNPACK
 * provides optimized ARM CPU kernels and is the preferred Android EP
 * for `onnxruntime-react-native`. Consumers needing GPU/NPU on Android
 * should rebuild the package with QNN enabled (Qualcomm-only).
 */
export type ExecutionProvider =
  | CoreMLExecutionProviderOption
  | XNNPackExecutionProviderOption
  | CPUExecutionProviderOption
  | 'coreml'
  | 'xnnpack'
  | 'cpu';

/**
 * Preset execution provider configurations for common use cases.
 *
 * On Android, `'auto'` and `'gpu'` both resolve to `['xnnpack', 'cpu']`
 * since NNAPI is no longer used and there is no other GPU EP exposed.
 */
export type ExecutionProviderPreset =
  | 'auto' // CoreML+xnnpack on iOS, xnnpack on Android. Best default.
  | 'cpu' // bare CPU on iOS, xnnpack+cpu on Android (bare-CPU bug workaround)
  | 'gpu'; // CoreML on iOS; same as 'auto' on Android
