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
   * Use Kitten neural TTS engine (offline, ONNX-based)
   * - 15M parameter StyleTTS 2-based TTS
   * - Single ONNX model, 24kHz mono output
   * - 8 built-in voices, English only
   * - GPL-free dictionary-based phonemization + character-level IPA tokenization
   * - Requires 1 ONNX model file + voice embeddings JSON
   */
  KITTEN = 'kitten',
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
  /**
   * If `true` (default), markdown syntax (`**bold**`, headers, tables, code
   * fences, lists, links, etc.) is stripped before phonemization so the
   * TTS doesn't read asterisks / pipes / hashes aloud. Set `false` to pass
   * text through verbatim — useful when consumer has already cleaned the
   * input or when preserving source-text offsets for highlighting.
   * @platform neural-engines
   * @default true
   */
  stripMarkdown?: boolean;
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

/**
 * Handle returned by `TTSEngineInterface.synthesizeStream()`. The
 * caller pushes text in via `append()` and the engine pulls chunks
 * from an internal streaming chunker, pipelining synth + play so
 * there is no gap between chunks.
 */
export interface EngineStreamHandle {
  append(text: string): void;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
}

export interface TTSEngineInterface<TConfig = void> {
  /** Unique engine identifier */
  readonly name: TTSEngine;

  /**
   * Initialize the engine.
   *
   * `TConfig` is the per-engine configuration object (e.g. `KokoroConfig`).
   * Engines that take no config use `void`.
   */
  initialize(config?: TConfig): Promise<void>;

  /** Check if engine is ready to use */
  isReady(): Promise<boolean>;

  /** Synthesize text to audio */
  synthesize(
    text: string,
    options?: SynthesisOptions,
  ): Promise<AudioBuffer | void>;

  /**
   * Start a streaming synthesis session. Text is pushed incrementally
   * via `append()` and the engine pulls chunks as they become ready,
   * synthesizing the next chunk while the current one plays.
   *
   * Optional — only neural engines implement this. `SpeechStream`
   * falls back to the Tier 1 adaptive batcher when this is absent.
   */
  synthesizeStream?(options?: SynthesisOptions): EngineStreamHandle;

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
 * Per-chunk synthesis timing breakdown. Populated on the chunk-done
 * event (after `synthesizeChunk` returns, before playback starts).
 * Undefined on chunk-start events.
 *
 * For engines that split an oversized chunk into sub-pieces (Kitten),
 * timings are summed across the sub-pieces — `totalMs` reflects the
 * full top-level synthesis cost the consumer cares about.
 */
export interface ChunkTimings {
  /** Pure ONNX inference time (model.run) in ms. */
  inferenceMs: number;
  /** Voice / style embedding load time in ms (often 0 after first chunk). */
  voiceLoadMs: number;
  /** End-to-end synthesizeChunk time in ms (includes phonemize, tokenize, infer). */
  totalMs: number;
  /** Length of the resulting audio buffer in seconds. */
  audioDurationS: number;
}

/**
 * Internal: the shape engines return from their per-chunk synthesis
 * function. Used by `EngineStreamSession` to extract both the audio
 * buffer and its associated timings without a side-channel getter.
 */
export interface SynthesizeChunkResult {
  audio: AudioBuffer;
  timings?: ChunkTimings;
}

/**
 * Event emitted when a chunk (sentence) reaches a milestone in the
 * synth pipeline. Neural TTS engines fire this twice per chunk:
 *   - chunk-start: timings undefined, progress reflects pre-synth state
 *   - chunk-done: timings populated (inference / voice / total / audio
 *     duration), progress reflects post-synth state
 *
 * Real-time factor (RTF) per chunk: `timings.inferenceMs / (timings.audioDurationS * 1000)`.
 * RTF < 1.0 means inference is faster than audio playback (good).
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
  /**
   * Synthesis timings — present on chunk-done events only. Engines that
   * don't break inference into discrete stages may report all of
   * `inferenceMs`/`totalMs` as the same value.
   */
  timings?: ChunkTimings;
}

/**
 * Callback type for chunk progress events
 */
export type ChunkProgressCallback = (event: ChunkProgressEvent) => void;

/**
 * Options for `Speech.createSpeechStream`.
 * Extends `SynthesisOptions` — all regular speak options apply to each batch.
 */
export interface SpeechStreamOptions extends SynthesisOptions {
  /**
   * Target size (in characters) for batches flushed after the first
   * sentence. Larger values produce more natural prosody across sentence
   * boundaries at the cost of higher latency before each batch starts.
   *
   * The first batch always flushes as soon as a complete sentence is
   * available (for low time-to-first-audio), regardless of this value.
   *
   * @default 300
   */
  targetChars?: number;

  /**
   * Called when synthesis of a batch fails. Errors from individual batches
   * do not reject `append()` (which is synchronous). `finalize()` rejects
   * with the first error encountered if any batch failed.
   */
  onError?: (error: Error) => void;
}

/**
 * Progress event emitted by a `SpeechStream` as each chunk starts
 * playing. Offsets are relative to the **total text appended to the
 * stream so far** — not to any single batch — so consumers can
 * highlight ranges directly in the accumulated LLM output.
 */
export interface StreamProgressEvent {
  /** Text of the chunk currently being spoken. */
  chunkText: string;
  /**
   * Absolute character range within the consumer's accumulated text
   * (sum of all `append()` arguments, in order). Monotonically
   * non-decreasing across a stream's lifetime.
   */
  streamRange: {start: number; end: number};
  /** Chunk index within the current batch (0-based). */
  chunkIndex: number;
  /**
   * Batch index across the whole stream (0-based). For engines that
   * support incremental streaming synth (neural engines), the entire
   * stream is a single batch and this is always 0.
   */
  batchIndex: number;
}

/**
 * Streaming input handle returned by `Speech.createSpeechStream`.
 *
 * Feed text incrementally (e.g. LLM tokens) via `append()`; the stream
 * decides when to flush batches to the underlying engine so that the
 * audio sounds continuous instead of like a sequence of per-sentence
 * utterances.
 */
export interface SpeechStream {
  /**
   * Append text to the buffer. Non-blocking and never throws. Safe to
   * call at any rate — the stream batches internally. Calls after
   * `finalize()` or `cancel()` are silently ignored.
   */
  append(text: string): void;

  /**
   * Flush any remaining buffered text (including a trailing incomplete
   * sentence) and resolve once all queued audio has finished playing.
   * Rejects if any batch failed to synthesize.
   */
  finalize(): Promise<void>;

  /**
   * Abort immediately. Clears the buffer + queue and stops any in-flight
   * synthesis. Further `append()` calls are no-ops.
   */
  cancel(): Promise<void>;

  /**
   * Subscribe to per-chunk progress events with stream-absolute offsets.
   * Returns an unsubscribe function. No events fire after `finalize()`
   * resolves or `cancel()` is called.
   *
   * Use this instead of `Speech.onChunkProgress` when you need to
   * highlight text in the accumulated consumer buffer — batch-local
   * offsets from `Speech.onChunkProgress` would not map there.
   */
  onProgress(cb: (event: StreamProgressEvent) => void): () => void;
}
