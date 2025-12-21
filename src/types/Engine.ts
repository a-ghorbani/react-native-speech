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
