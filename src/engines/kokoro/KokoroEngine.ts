/**
 * Kokoro TTS Engine
 *
 * Neural TTS engine using ONNX Runtime for inference.
 * Supports sentence-level chunking for long text with progress events.
 *
 * Features:
 * - High-quality neural voice synthesis
 * - Hardware acceleration (CoreML on iOS, NNAPI on Android)
 * - Pipelined synthesis for seamless playback
 * - Voice blending support
 */

import {Platform} from 'react-native';
import type {
  TTSEngine,
  TTSEngineInterface,
  AudioBuffer,
  EngineStreamHandle,
  KokoroConfig,
  KokoroSynthesisOptions,
  KokoroVoice,
  ChunkProgressEvent,
  ChunkProgressCallback,
  ExecutionProvider,
  ReleaseResult,
  ReleaseError,
  OnnxInferenceSession,
  OnnxInferenceSessionConstructor,
  OnnxTensorConstructor,
} from '../../types';
import {BPETokenizer} from './BPETokenizer';
import {VoiceLoader} from './VoiceLoader';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';
import {createPhonemizer, NoOpPhonemizer, type IPhonemizer} from './Phonemizer';
import {DEFAULT_COREML_FLAGS} from '../../types/Kokoro';
import {loadNativeDict} from '../../phonemization';
import {TextNormalizer, type TextChunk} from './TextNormalizer';
import {EngineStreamSession} from '../EngineStreamSession';
import {createComponentLogger} from '../../utils/logger';
import {
  stripMarkdown,
  createMarkdownStreamBuffer,
} from '../../utils/stripMarkdown';
import {KOKORO_CONSTANTS} from './constants';

const log = createComponentLogger('Kokoro', 'Engine');

// Lazy-loaded ONNX Runtime references (loaded via dynamic require)
interface OnnxRuntimeBindings {
  InferenceSession: OnnxInferenceSessionConstructor;
  Tensor: OnnxTensorConstructor;
}
let OnnxRuntime: OnnxRuntimeBindings | null = null;

/**
 * Ensure ONNX Runtime is available and return it
 * @throws Error with installation instructions if not installed
 */
function getOnnxRuntime(): OnnxRuntimeBindings {
  if (!OnnxRuntime) {
    try {
      const onnx = require('onnxruntime-react-native');
      OnnxRuntime = {
        InferenceSession: onnx.InferenceSession,
        Tensor: onnx.Tensor,
      };
    } catch {
      throw new Error(
        'onnxruntime-react-native is required to use the Kokoro engine.\n\n' +
          'Install it with:\n' +
          '  npm install onnxruntime-react-native\n' +
          '  # or\n' +
          '  yarn add onnxruntime-react-native\n\n' +
          'Then rebuild your app:\n' +
          '  iOS: cd ios && pod install && cd ..\n' +
          '  Android: Rebuild the app\n\n' +
          'See https://github.com/a-ghorbani/react-native-speech/blob/main/docs/KOKORO_GUIDE.md for details.',
      );
    }
  }
  return OnnxRuntime;
}

const {MAX_TOKEN_LIMIT, DEFAULT_MAX_CHUNK_SIZE, SAMPLE_RATE} = KOKORO_CONSTANTS;

/**
 * Default execution providers when the caller doesn't specify any.
 *
 *   - iOS: CoreML (Metal/ANE) with sensible flags, xnnpack second, bare
 *     CPU last.
 *   - Android: xnnpack + CPU. NNAPI was removed (deprecated in Android
 *     15) and there is no other public GPU/NPU EP exposed by
 *     `onnxruntime-react-native`.
 */
function getDefaultExecutionProviders(): ExecutionProvider[] {
  if (Platform.OS === 'ios') {
    return [
      {name: 'coreml', coreMlFlags: DEFAULT_COREML_FLAGS},
      'xnnpack',
      'cpu',
    ];
  }
  return ['xnnpack', 'cpu'];
}

export class KokoroEngine implements TTSEngineInterface<KokoroConfig> {
  readonly name: TTSEngine = 'kokoro' as TTSEngine;

  private session: OnnxInferenceSession | null = null;
  private tokenizer: BPETokenizer;
  private voiceLoader: VoiceLoader;
  private phonemizer: IPhonemizer;
  private normalizer: TextNormalizer;

  private config: KokoroConfig | null = null;
  private isInitialized = false;
  private isLoading = false;
  private initError: string | null = null;

  private defaultVoiceId = 'af_bella'; // Default voice

  // Chunking and progress tracking
  private stopRequested = false;
  private stopSignalResolver: (() => void) | null = null;
  private currentUtteranceId = 0;
  private chunkProgressCallback: ChunkProgressCallback | null = null;

  // Synthesis state tracking for safe resource release
  private isSynthesizing = false;
  private synthesisCompleteResolver: (() => void) | null = null;

  private activeStreamSession: EngineStreamSession | null = null;

  constructor() {
    this.tokenizer = new BPETokenizer();
    this.voiceLoader = new VoiceLoader();
    this.normalizer = new TextNormalizer();
    // Real phonemizer is created in initialize() once config/dict are known.
    this.phonemizer = new NoOpPhonemizer();
  }

  /**
   * Set callback for chunk progress events
   * @param callback - Function to call when chunk progress changes
   */
  setChunkProgressCallback(callback: ChunkProgressCallback | null): void {
    this.chunkProgressCallback = callback;
  }

  /**
   * Emit a chunk progress event
   */
  private emitChunkProgress(event: ChunkProgressEvent): void {
    if (this.chunkProgressCallback) {
      this.chunkProgressCallback(event);
    }
  }

  /**
   * Initialize the Kokoro engine with model files
   */
  async initialize(config?: KokoroConfig): Promise<void> {
    // Check if ONNX Runtime is available (throws if not installed)
    getOnnxRuntime();

    if (this.isInitialized) {
      return;
    }

    if (this.isLoading) {
      throw new Error('Engine is already loading');
    }

    this.isLoading = true;
    this.initError = null;
    const initStart = Date.now();

    try {
      // Config with model paths is required
      if (!config) {
        throw new Error('Kokoro config required for initialization');
      }
      this.config = config;

      log.debug(
        `Initializing with phonemizerType=${config.phonemizerType || 'none'}`,
      );

      // Initialize phonemizer based on config
      const phonemizerType = config.phonemizerType || 'js';
      if (phonemizerType === 'js') {
        if (!config.dictPath) {
          throw new Error(
            "Kokoro phonemizerType 'js' requires `dictPath` in config " +
              '(path to the IPA dictionary .bin file, EPD1 format).',
          );
        }
        const dict = await loadNativeDict(config.dictPath);
        this.phonemizer = createPhonemizer('js', {dict});
      } else {
        this.phonemizer = createPhonemizer(phonemizerType);
      }

      // Load tokenizer (support both tokenizer.json and vocab+merges format)
      if (this.config.tokenizerPath) {
        await this.loadTokenizerFromHF(this.config.tokenizerPath);
      } else if (this.config.vocabPath && this.config.mergesPath) {
        await this.loadTokenizer(this.config.vocabPath, this.config.mergesPath);
      } else {
        throw new Error(
          'Either tokenizerPath or (vocabPath + mergesPath) must be provided',
        );
      }

      // Load voice embeddings
      await this.loadVoices(this.config.voicesPath);

      // Load ONNX model
      await this.loadModel(this.config.modelPath);

      this.isInitialized = true;
      this.isLoading = false;
      log.info(`engine_init_ms=${Date.now() - initStart}`);
      log.info(
        'Kokoro uses Kokoro-82M (Apache-2.0); verify upstream license for your use case.',
      );
    } catch (error) {
      this.isLoading = false;
      this.initError = error instanceof Error ? error.message : 'Unknown error';
      throw error;
    }
  }

  /**
   * Check if engine is ready
   */
  async isReady(): Promise<boolean> {
    return (
      this.isInitialized &&
      this.session !== null &&
      this.tokenizer.isReady() &&
      this.voiceLoader.isReady()
    );
  }

  /**
   * Synthesize text to audio and play it
   * Automatically chunks long text by sentences for better performance and progress tracking
   * This maintains the unified API - synthesize() now plays audio for neural engines
   */
  async synthesize(
    text: string,
    options?: KokoroSynthesisOptions,
  ): Promise<AudioBuffer | void> {
    if (!this.isInitialized || !this.session) {
      throw new Error('Kokoro engine not initialized');
    }

    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    // Track synthesis state for safe resource release
    this.isSynthesizing = true;
    try {
      return await this.doSynthesize(text, options);
    } finally {
      this.isSynthesizing = false;
      // Resolve any pending waitForSynthesisComplete() calls
      if (this.synthesisCompleteResolver) {
        this.synthesisCompleteResolver();
        this.synthesisCompleteResolver = null;
      }
    }
  }

  synthesizeStream(options?: KokoroSynthesisOptions): EngineStreamHandle {
    if (!this.isInitialized || !this.session) {
      throw new Error('Kokoro engine not initialized');
    }

    if (this.activeStreamSession) {
      this.activeStreamSession.cancel().catch(() => {});
      this.activeStreamSession = null;
    }

    this.stopRequested = false;
    this.isSynthesizing = true;
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const language = this.getLanguageFromVoice(voiceId);
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;

    const stripMd = options?.stripMarkdown !== false;
    // When stripping is enabled, buffer incoming text by complete lines and
    // strip BEFORE StreamingChunker sees it — so hrules / headers / table
    // rows get converted into sentence boundaries the chunker recognizes.
    // Stripping inside synthesizeChunk (post-chunker) would only catch
    // inline markers; structural breaks would be lost.
    const mdBuffer = stripMd ? createMarkdownStreamBuffer() : null;
    const session = new EngineStreamSession({
      synthesizeChunk: (text: string) =>
        this.synthesizeTextChunk(text, voiceId, language, options),
      playAudio: (buffer, playOpts) => neuralAudioPlayer.play(buffer, playOpts),
      stopPlayback: () => neuralAudioPlayer.stop(),
      maxChunkSize,
      playbackOptions: {
        ducking: options?.ducking,
        silentMode: options?.silentMode,
      },
      onChunkProgress: this.chunkProgressCallback
        ? event => this.emitChunkProgress(event)
        : undefined,
    });

    this.activeStreamSession = session;

    const wrapFinalize = async () => {
      try {
        await session.finalize();
      } finally {
        this.activeStreamSession = null;
        this.isSynthesizing = false;
        if (this.synthesisCompleteResolver) {
          this.synthesisCompleteResolver();
          this.synthesisCompleteResolver = null;
        }
      }
    };

    const wrapCancel = async () => {
      try {
        await session.cancel();
      } finally {
        this.activeStreamSession = null;
        this.isSynthesizing = false;
        if (this.synthesisCompleteResolver) {
          this.synthesisCompleteResolver();
          this.synthesisCompleteResolver = null;
        }
      }
    };

    return {
      append: (text: string) => {
        if (mdBuffer) {
          const emit = mdBuffer.push(text);
          if (emit) session.append(emit);
        } else {
          session.append(text);
        }
      },
      finalize: async () => {
        if (mdBuffer) {
          const tail = mdBuffer.flush();
          if (tail) session.append(tail);
        }
        return wrapFinalize();
      },
      cancel: wrapCancel,
    };
  }

  /**
   * Create a stop signal promise that resolves when stop() is called.
   * Used to race against long-running operations (ONNX inference, playback).
   */
  private createStopSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      this.stopSignalResolver = () => resolve(null);
    });
  }

  /**
   * Race a promise against the stop signal.
   * Returns null if stop was triggered before the promise resolved.
   */
  private raceWithStop<T>(
    promise: Promise<T>,
    stopSignal: Promise<null>,
  ): Promise<T | null> {
    return Promise.race([promise, stopSignal]);
  }

  /**
   * Internal synthesis implementation
   */
  private async doSynthesize(
    text: string,
    options?: KokoroSynthesisOptions,
  ): Promise<AudioBuffer | void> {
    // Reset stop flag and generate new utterance ID
    this.stopRequested = false;
    this.stopSignalResolver = null;
    this.currentUtteranceId = Date.now();
    const utteranceId = this.currentUtteranceId;

    // Create stop signal for racing against long-running operations
    const stopSignal = this.createStopSignal();

    // Get voice ID early (needed for language detection)
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const language = this.getLanguageFromVoice(voiceId);

    log.debug(
      `Synthesis start: voice=${voiceId}, text="${text.substring(0, 50)}..."`,
    );

    // Strip markdown syntax before chunking so structural markers (`---`,
    // `###`, table rows) get converted into sentence breaks the chunker
    // recognizes. Default on; consumer can opt out via options.
    const cleanText =
      options?.stripMarkdown === false ? text : stripMarkdown(text);

    // Chunk text by sentences for streaming playback
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    const chunks = this.normalizer.chunkBySentencesWithMetadata(
      cleanText,
      maxChunkSize,
    );

    log.debug(`Text chunked into ${chunks.length} chunks`);

    // Use pipelined synthesis: synthesize next chunk while current one plays
    // This eliminates the gap between chunks
    let nextAudioPromise: Promise<AudioBuffer> | null = null;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      // Check if stop was requested
      if (this.stopRequested) {
        log.debug('Stop requested, aborting synthesis');
        return undefined;
      }

      const chunk = chunks[chunkIndex] as TextChunk;
      const progress = Math.round((chunkIndex / chunks.length) * 100);

      log.debug(`Processing chunk ${chunkIndex + 1}/${chunks.length}`);

      // Emit chunk start progress event
      this.emitChunkProgress({
        id: utteranceId,
        chunkIndex,
        totalChunks: chunks.length,
        chunkText: chunk.text,
        textRange: {
          start: chunk.startIndex,
          end: chunk.endIndex,
        },
        progress,
      });

      // Get current chunk's audio (either from pipeline or synthesize now)
      // Race against stop signal so we don't block on ONNX inference
      let audioBuffer: AudioBuffer | null;

      if (nextAudioPromise) {
        audioBuffer = await this.raceWithStop(nextAudioPromise, stopSignal);
        nextAudioPromise = null;
      } else {
        audioBuffer = await this.raceWithStop(
          this.synthesizeTextChunk(chunk.text, voiceId, language, options),
          stopSignal,
        );
      }

      // Stop signal won the race, or empty buffer from early-stop check
      if (
        audioBuffer === null ||
        this.stopRequested ||
        audioBuffer.samples.length === 0
      ) {
        log.debug('Stop requested, aborting before playback');
        return undefined;
      }

      // Start synthesizing next chunk in parallel with playback
      // (only if not already stopping to avoid wasted work)
      const nextChunkIndex = chunkIndex + 1;
      if (!this.stopRequested && nextChunkIndex < chunks.length) {
        const nextChunk = chunks[nextChunkIndex] as TextChunk;
        nextAudioPromise = this.synthesizeTextChunk(
          nextChunk.text,
          voiceId,
          language,
          options,
        );
      }

      // Play current chunk audio, racing against stop signal
      await this.raceWithStop(
        neuralAudioPlayer.play(audioBuffer, {
          ducking: options?.ducking,
          silentMode: options?.silentMode,
        }),
        stopSignal,
      );
    }

    log.debug('Synthesis complete');
    return undefined;
  }

  /**
   * Synthesize a text chunk to audio (normalize -> phonemize -> tokenize -> infer)
   * This is the full pipeline for a single chunk
   */
  private async synthesizeTextChunk(
    chunkText: string,
    voiceId: string,
    language: string,
    options?: KokoroSynthesisOptions,
  ): Promise<AudioBuffer> {
    // Normalize chunk text
    const normalized = this.normalizer.normalize(chunkText);

    // Check stop between pipeline steps
    if (this.stopRequested) {
      return {
        samples: new Float32Array(0),
        sampleRate: SAMPLE_RATE,
        channels: 1,
        duration: 0,
      };
    }

    // Phonemize (convert text to phonemes)
    const phonemes = await this.phonemizer.phonemize(normalized, language);

    // Check stop after phonemization (can be slow)
    if (this.stopRequested) {
      return {
        samples: new Float32Array(0),
        sampleRate: SAMPLE_RATE,
        channels: 1,
        duration: 0,
      };
    }

    // Tokenize phonemes
    const tokens = this.tokenizer.encode(phonemes);

    // Check token limit
    if (tokens.length > MAX_TOKEN_LIMIT) {
      log.warn(
        `Chunk has ${tokens.length} tokens, exceeding limit of ${MAX_TOKEN_LIMIT}. Audio may be truncated.`,
      );
    }

    // Generate audio for this chunk
    return this.synthesizeChunk(tokens, voiceId, options);
  }

  /**
   * Synthesize a single chunk of tokens to audio
   * This is the core inference method without playback
   */
  private async synthesizeChunk(
    tokens: number[],
    voiceId: string,
    options?: KokoroSynthesisOptions,
  ): Promise<AudioBuffer> {
    const chunkStartTime = Date.now();

    // Get voice embedding
    let voiceEmbedding: Float32Array;

    const voiceStartTime = Date.now();
    if (options?.voiceBlend) {
      // Blend multiple voices
      voiceEmbedding = await this.voiceLoader.blendVoices(
        options.voiceBlend.voices,
        options.voiceBlend.weights,
        tokens.length,
      );
    } else {
      // Use single voice
      voiceEmbedding = await this.voiceLoader.getVoiceEmbedding(
        voiceId,
        tokens.length,
      );
    }
    const voiceTime = Date.now() - voiceStartTime;

    // Convert to BigInt64Array for ONNX (int64)
    const tokensBigInt = new BigInt64Array(tokens.map(t => BigInt(t)));

    // Get speed parameter
    const speed = options?.speed ?? 1.0;
    const speedArray = new Float32Array([speed]);

    // Create input tensors using ONNX Runtime
    const {Tensor} = getOnnxRuntime();
    const tokensTensor = new Tensor('int64', tokensBigInt, [1, tokens.length]);
    const voiceTensor = new Tensor('float32', voiceEmbedding, [
      1,
      voiceEmbedding.length,
    ]);
    const speedTensor = new Tensor('float32', speedArray, [1]);

    // Run inference
    const feeds = {
      input_ids: tokensTensor,
      style: voiceTensor,
      speed: speedTensor,
    };

    if (!this.session) {
      throw new Error('Kokoro session not initialized');
    }
    const inferenceStartTime = Date.now();
    const results = await this.session.run(feeds);
    const inferenceTime = Date.now() - inferenceStartTime;

    // Extract audio output (kokoro.js uses 'waveform')
    const audioTensor = results.waveform || results.audio;
    if (!audioTensor) {
      throw new Error(
        `No audio output from model. Available outputs: ${Object.keys(results).join(', ')}`,
      );
    }

    const audioData = audioTensor.data as Float32Array;

    // Create audio buffer
    const audioBuffer: AudioBuffer = {
      samples: audioData,
      sampleRate: SAMPLE_RATE,
      channels: 1, // Mono
      duration: audioData.length / SAMPLE_RATE,
    };

    // Apply volume if specified (with bounds checking to prevent clipping)
    if (options?.volume !== undefined && options.volume !== 1.0) {
      const clampedVolume = Math.max(0, Math.min(1, options.volume));
      for (let i = 0; i < audioBuffer.samples.length; i++) {
        const sample = audioBuffer.samples[i];
        if (sample !== undefined) {
          // Apply volume and clamp to [-1, 1] to prevent clipping
          const adjusted = sample * clampedVolume;
          audioBuffer.samples[i] = Math.max(-1, Math.min(1, adjusted));
        }
      }
    }

    const totalChunkTime = Date.now() - chunkStartTime;
    log.debug(
      `Chunk done: inference=${inferenceTime}ms, voice=${voiceTime}ms, total=${totalChunkTime}ms, audio=${audioBuffer.duration.toFixed(2)}s`,
    );

    return audioBuffer;
  }

  /**
   * Get available voices
   */
  async getAvailableVoices(language?: string): Promise<string[]> {
    const voices = this.voiceLoader.getAvailableVoices(language);
    return voices.map(v => v.id);
  }

  /**
   * Get available voices with metadata
   */
  getVoicesWithMetadata(language?: string): KokoroVoice[] {
    return this.voiceLoader.getAvailableVoices(language);
  }

  /**
   * Stop current playback and abort any ongoing synthesis.
   * Sets the stop flag and resolves the stop signal immediately,
   * so any in-flight ONNX inference is abandoned without waiting.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    // Resolve stop signal so Promise.race exits immediately
    if (this.stopSignalResolver) {
      this.stopSignalResolver();
      this.stopSignalResolver = null;
    }
    if (this.activeStreamSession) {
      await this.activeStreamSession.cancel().catch(() => {});
      this.activeStreamSession = null;
      this.isSynthesizing = false;
    }
    // Fire-and-forget native audio stop
    neuralAudioPlayer.stop().catch(() => {});
  }

  /**
   * Destroy engine and free resources
   * After calling destroy(), the engine can be re-initialized with new config
   */
  async destroy(): Promise<void> {
    // Stop any ongoing synthesis
    this.stopRequested = true;

    if (this.session) {
      // Note: onnxruntime-react-native doesn't have explicit dispose
      this.session = null;
    }

    // Reset all state to allow re-initialization
    this.isInitialized = false;
    this.isLoading = false;
    this.initError = null;
    this.config = null;
  }

  /**
   * Wait for any ongoing synthesis to complete or abort
   */
  private async waitForSynthesisComplete(
    timeoutMs: number = 5000,
  ): Promise<void> {
    if (!this.isSynthesizing) {
      return;
    }

    log.debug('Waiting for synthesis to complete...');

    return new Promise<void>(resolve => {
      // Set up resolver for when synthesis completes
      this.synthesisCompleteResolver = resolve;

      // Timeout fallback
      setTimeout(() => {
        if (this.synthesisCompleteResolver === resolve) {
          log.warn('Synthesis wait timeout, proceeding with release');
          this.synthesisCompleteResolver = null;
          resolve();
        }
      }, timeoutMs);
    });
  }

  /**
   * Reset engine state to uninitialized
   */
  private resetState(): void {
    this.isInitialized = false;
    this.isLoading = false;
    this.initError = null;
    this.config = null;
  }

  /**
   * Release model resources from memory while keeping engine instance reusable.
   * After calling release(), initialize() must be called before synthesize().
   *
   * This method properly releases:
   * - ONNX InferenceSession (main memory consumer ~450MB)
   * - Voice embeddings cache
   * - Tokenizer vocabulary data
   *
   * @returns ReleaseResult with success status and any errors encountered
   */
  async release(): Promise<ReleaseResult> {
    const errors: ReleaseError[] = [];

    // Guard: Already released / not initialized
    if (!this.isInitialized && !this.isLoading) {
      log.debug('Engine already released, skipping');
      return {success: true, partialRelease: false, errors: []};
    }

    log.info('Releasing engine resources...');

    // Guard: Don't release while loading
    if (this.isLoading) {
      log.warn('Cannot release while engine is loading');
      return {
        success: false,
        partialRelease: false,
        errors: [
          {
            component: 'engine',
            error: new Error('Cannot release while loading'),
          },
        ],
      };
    }

    // 1. Signal stop and wait for any ongoing synthesis to complete
    this.stopRequested = true;

    // 2. Stop audio player first
    try {
      await neuralAudioPlayer.stop();
      log.debug('Audio player stopped');
    } catch (e) {
      log.warn('Failed to stop audio player:', e);
      errors.push({component: 'audioPlayer', error: e as Error});
    }

    // 3. Wait for synthesis to complete (with timeout)
    await this.waitForSynthesisComplete();

    // 4. Release ONNX session (main memory consumer)
    if (this.session) {
      try {
        if (typeof this.session.release === 'function') {
          await this.session.release();
          log.debug('ONNX session released');
        }
      } catch (e) {
        log.warn('Failed to release ONNX session:', e);
        errors.push({component: 'session', error: e as Error});
      }
      this.session = null;
    }

    // 5. Clear voice embeddings cache
    try {
      this.voiceLoader.clear();
      log.debug('Voice loader cleared');
    } catch (e) {
      log.warn('Failed to clear voice loader:', e);
      errors.push({component: 'voiceLoader', error: e as Error});
    }

    // 6. Clear tokenizer data
    try {
      this.tokenizer.clear();
      log.debug('Tokenizer cleared');
    } catch (e) {
      log.warn('Failed to clear tokenizer:', e);
      errors.push({component: 'tokenizer', error: e as Error});
    }

    // 7. Reset state to allow re-initialization
    this.resetState();

    const success = errors.length === 0;
    log.info(
      success
        ? 'Engine resources released successfully'
        : `Engine released with ${errors.length} error(s)`,
    );

    return {
      success,
      partialRelease: errors.length > 0,
      errors,
    };
  }

  /**
   * Get engine status
   */
  getStatus() {
    return {
      isReady: this.isInitialized,
      isLoading: this.isLoading,
      error: this.initError,
    };
  }

  /**
   * Load ONNX model with hardware acceleration
   */
  private async loadModel(modelPath: string): Promise<void> {
    const {InferenceSession} = getOnnxRuntime();

    try {
      const executionProviders =
        this.config?.executionProviders ?? getDefaultExecutionProviders();

      log.debug(
        `Loading model with providers: ${JSON.stringify(executionProviders)}`,
      );

      const sessionOptions = {
        executionProviders,
      };

      const startTime = Date.now();
      this.session = await InferenceSession.create(modelPath, sessionOptions);
      const loadTime = Date.now() - startTime;

      log.info(`Model loaded in ${loadTime}ms`);
    } catch (error) {
      // If hardware acceleration fails, try CPU-only as fallback
      log.warn(
        `Failed to load with acceleration, trying CPU fallback: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );

      try {
        this.session = await InferenceSession.create(modelPath, {
          executionProviders: ['cpu'],
        });
        log.info('Model loaded with CPU fallback');
      } catch (fallbackError) {
        throw new Error(
          `Failed to load ONNX model: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * Load BPE tokenizer from vocab and merges files
   */
  private async loadTokenizer(
    vocabPath: string,
    mergesPath: string,
  ): Promise<void> {
    try {
      log.debug('Loading tokenizer from vocab+merges files');
      const {
        loadAssetAsJSON,
        loadAssetAsText,
      } = require('../../utils/AssetLoader');

      const vocabData = await loadAssetAsJSON(vocabPath);
      const mergesText = await loadAssetAsText(mergesPath);
      const mergesArray = mergesText
        .split('\n')
        .filter((line: string) => line.trim() && !line.startsWith('#'));

      await this.tokenizer.loadFromData(vocabData, mergesArray);
      log.debug('Tokenizer loaded');
    } catch (error) {
      throw new Error(
        `Failed to load tokenizer: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Load BPE tokenizer from HuggingFace tokenizer.json format
   */
  private async loadTokenizerFromHF(tokenizerPath: string): Promise<void> {
    try {
      log.debug('Loading tokenizer from HuggingFace format');
      const {loadAssetAsJSON} = require('../../utils/AssetLoader');

      const tokenizerData = await loadAssetAsJSON(tokenizerPath);

      // Extract vocab from HF tokenizer.json format
      const vocab = tokenizerData.model?.vocab || {};
      const merges = tokenizerData.model?.merges || [];

      log.debug(
        `Tokenizer vocab size: ${Object.keys(vocab).length}, merges: ${merges.length}`,
      );

      await this.tokenizer.loadFromData(vocab, merges);
      log.debug('Tokenizer loaded');
    } catch (error) {
      log.error(
        `Failed to load tokenizer: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error(
        `Failed to load tokenizer from HF format: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Load voice embeddings from manifest, JSON, or binary file
   */
  private async loadVoices(voicesPath: string): Promise<void> {
    try {
      const {
        loadAssetAsJSON,
        loadAssetAsArrayBuffer,
      } = require('../../utils/AssetLoader');

      // Check if it's a manifest file (lazy loading) or direct voices file
      if (voicesPath.includes('manifest') && voicesPath.endsWith('.json')) {
        log.debug('Loading voices from manifest (lazy loading mode)');
        const manifest = await loadAssetAsJSON(voicesPath);
        await this.voiceLoader.loadFromManifest(manifest, voicesPath);
        log.debug(
          `Manifest loaded: ${manifest.voices?.length || 0} voices available`,
        );
      } else if (voicesPath.endsWith('.json')) {
        log.debug('Loading voices from JSON file');
        const voicesData = await loadAssetAsJSON(voicesPath);
        await this.voiceLoader.loadFromJSON(voicesData);
        log.debug(`Voices loaded: ${Object.keys(voicesData).length} voices`);
      } else {
        log.debug('Loading voices from binary file');
        const voicesData = await loadAssetAsArrayBuffer(voicesPath);
        await this.voiceLoader.loadFromBinary(voicesData);
        log.debug(`Voices loaded: ${voicesData.byteLength} bytes`);
      }

      log.info(
        `Voice loader ready: ${this.voiceLoader.getAvailableVoices().length} voices`,
      );
    } catch (error) {
      log.error(
        `Failed to load voices: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error(
        `Failed to load voices: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get language code from voice ID
   * Voice IDs follow the pattern: {lang}{gender}_{name}
   * e.g., 'af_bella' -> 'en-us' (American English)
   *       'bf_emma' -> 'en-gb' (British English)
   *
   * Returns BCP-47-ish language codes used by the phonemizer (kept
   * compatible with the original Kokoro pipeline's labels).
   */
  private getLanguageFromVoice(voiceId: string): string {
    const langCode = voiceId.charAt(0).toLowerCase();

    switch (langCode) {
      case 'a':
        return 'en-us'; // American English
      case 'b':
        return 'en-gb'; // British English
      default:
        return 'en-us';
    }
  }
}
