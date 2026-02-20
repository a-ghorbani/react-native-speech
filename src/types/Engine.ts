/**
 * TTS Engine types and interfaces
 */

export enum TTSEngine {
  /**
   * Use the native OS TTS engine
   * - iOS: AVSpeechSynthesizer
   * - Android: Android TextToSpeech API
   */
  OS_NATIVE = 'os-native',

  /**
   * Use Kokoro neural TTS engine (offline, ONNX-based)
   * - High-quality neural voice synthesis
   * - Runs entirely on-device
   * - Requires model files
   */
  KOKORO = 'kokoro',

  /**
   * Use Supertonic neural TTS engine (offline, ONNX-based)
   * - Ultra-fast neural voice synthesis (167× faster than real-time)
   * - Lightweight (66M parameters)
   * - Runs entirely on-device
   * - Requires model files
   */
  SUPERTONIC = 'supertonic',

  /**
   * Use Pocket neural TTS engine (offline, ONNX-based)
   * - 100M parameter CALM-based TTS by Kyutai Labs
   * - CPU-optimized, 24kHz mono output
   * - 8 built-in voices, English only
   * - Autoregressive generation with KV cache
   * - Requires 4 ONNX model files + SentencePiece tokenizer
   */
  POCKET = 'pocket',
}

export interface EngineStatus {
  /** Whether the engine is initialized and ready to use */
  isReady: boolean;
  /** Whether the engine is currently loading/initializing */
  isLoading: boolean;
  /** Error message if engine failed to initialize */
  error?: string;
}

export interface AudioBuffer {
  /** Audio samples (PCM float32, range -1.0 to 1.0) */
  samples: Float32Array;
  /** Sample rate in Hz (e.g., 24000 for Kokoro) */
  sampleRate: number;
  /** Number of audio channels (1 = mono, 2 = stereo) */
  channels: number;
  /** Duration in seconds */
  duration: number;
}

export interface SynthesisOptions {
  /** Voice identifier (engine-specific) */
  voiceId?: string;
  /** Speech rate multiplier (0.5 - 2.0) */
  speed?: number;
  /** Pitch multiplier (0.5 - 2.0) */
  pitch?: number;
  /** Volume (0.0 - 1.0) */
  volume?: number;
  /** Language code (e.g., 'en-US') */
  language?: string;
  /**
   * Number of inference/diffusion steps for neural TTS engines.
   * Higher values = better quality but slower synthesis.
   * - Supertonic: 2-16 steps (default: 5)
   * @platform neural-engines
   */
  inferenceSteps?: number;
  /**
   * Number of LSD flow decode steps for Pocket TTS.
   * Higher values = better quality but slower synthesis.
   * - Pocket: 1-10 steps (default: 4)
   * @platform neural-engines
   */
  lsdSteps?: number;
  /**
   * Temperature for autoregressive sampling in Pocket TTS.
   * Higher values = more variation, lower = more deterministic.
   * - Pocket: 0.1-1.5 (default: 0.7)
   * @platform neural-engines
   */
  temperature?: number;
  /**
   * If `true`, audio from other apps will be temporarily lowered (ducked) while speech is active.
   * This is for critical announcements (e.g., navigation) and takes priority over `silentMode` on iOS.
   * @default false
   */
  ducking?: boolean;
  /**
   * Determines how speech audio interacts with the device's silent (ringer) switch.
   * This option is ignored if `ducking` is `true`.
   * @platform iOS
   *
   * - `obey`: (Default) Does not change the app's audio session. Speech follows the system default.
   * - `respect`: Speech will be silenced by the ringer switch. Use for non-critical audio.
   * - `ignore`: Speech will play even if the ringer is off. Use for critical audio when ducking is not desired.
   */
  silentMode?: 'obey' | 'respect' | 'ignore';
}

/**
 * Error details for a failed release operation on a specific component
 */
export interface ReleaseError {
  /** Component that failed to release (e.g., 'session', 'voiceLoader', 'tokenizer') */
  component: string;
  /** The error that occurred */
  error: Error;
}

/**
 * Result of a release operation
 */
export interface ReleaseResult {
  /** Whether all resources were released successfully */
  success: boolean;
  /** Whether some resources were released but others failed */
  partialRelease: boolean;
  /** List of errors that occurred during release */
  errors: ReleaseError[];
}

export interface TTSEngineInterface {
  /** Unique engine identifier */
  readonly name: TTSEngine;

  /** Initialize the engine */
  initialize(config?: any): Promise<void>;

  /** Check if engine is ready to use */
  isReady(): Promise<boolean>;

  /** Synthesize text to audio */
  synthesize(
    text: string,
    options?: SynthesisOptions,
  ): Promise<AudioBuffer | void>;

  /** Get available voices for this engine */
  getAvailableVoices(language?: string): Promise<string[]>;

  /** Stop any ongoing synthesis */
  stop(): Promise<void>;

  /** Clean up engine resources */
  destroy(): Promise<void>;

  /**
   * Release model resources from memory while keeping engine instance reusable.
   * After calling release(), initialize() must be called before synthesize().
   * Unlike destroy(), the engine instance remains valid for re-initialization.
   *
   * @returns ReleaseResult with success status and any errors encountered
   *
   * @example
   * // Free memory when app goes to background
   * await engine.release();
   *
   * // Later, when needed again
   * await engine.initialize(config);
   */
  release(): Promise<ReleaseResult>;
}

export interface ProgressEvent {
  /** Utterance ID */
  id: number;
  /** Current position in text */
  location: number;
  /** Total text length */
  length: number;
  /** Progress percentage (0-100) */
  progress: number;
}

/**
 * Event emitted when a new chunk (sentence) starts being spoken
 * Used by neural TTS engines that process text in chunks
 */
export interface ChunkProgressEvent {
  /** Utterance ID */
  id: number;
  /** Current chunk index (0-based) */
  chunkIndex: number;
  /** Total number of chunks */
  totalChunks: number;
  /** The text content of the current chunk */
  chunkText: string;
  /** Position range in the original text */
  textRange: {
    /** Start position in original text */
    start: number;
    /** End position in original text */
    end: number;
  };
  /** Overall progress percentage (0-100) */
  progress: number;
}

/**
 * Callback type for chunk progress events
 */
export type ChunkProgressCallback = (event: ChunkProgressEvent) => void;
