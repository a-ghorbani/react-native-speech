/**
 * Supertonic TTS Engine
 *
 * Ultra-fast neural TTS engine using ONNX Runtime for inference.
 * Uses a 4-model pipeline:
 * 1. Duration Predictor - predicts phoneme durations
 * 2. Text Encoder - encodes text into embeddings
 * 3. Vector Estimator - iterative diffusion for mel-spectrogram
 * 4. Vocoder - converts mel-spectrogram to audio
 *
 * Features:
 * - 167× faster than real-time on M4 Pro
 * - 66M parameters (lightweight)
 * - No G2P/phonemization needed (uses raw Unicode)
 * - Sentence-level chunking with progress events
 */

import type {
  TTSEngine,
  TTSEngineInterface,
  AudioBuffer,
  SupertonicConfig,
  SupertonicSynthesisOptions,
  SupertonicVoice,
  SupertonicVoiceStyle,
  ChunkProgressEvent,
  ChunkProgressCallback,
  ReleaseResult,
  ReleaseError,
} from '../../types';
import {SupertonicInference} from './SupertonicInference';
import {
  StyleLoader,
  type VoiceManifest,
  type RawVoiceStyleData,
} from './StyleLoader';
import {UnicodeProcessor} from './UnicodeProcessor';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';
import {loadAssetAsJSON} from '../../utils/AssetLoader';
import {TextChunker, type TextChunk} from '../../utils/TextChunker';
import {SUPERTONIC_CONSTANTS} from './constants';
import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('Supertonic', 'Engine');

const {DEFAULT_MAX_CHUNK_SIZE, DEFAULT_INFERENCE_STEPS} = SUPERTONIC_CONSTANTS;

export class SupertonicEngine implements TTSEngineInterface<SupertonicConfig> {
  readonly name: TTSEngine = 'supertonic' as TTSEngine;

  private inference: SupertonicInference;
  private styleLoader: StyleLoader;
  private unicodeProcessor: UnicodeProcessor;

  private config: SupertonicConfig | null = null;
  private isInitialized = false;
  private isLoading = false;
  private initError: string | null = null;

  private defaultVoiceId = 'F1'; // Female voice 1
  private defaultInferenceSteps: number = DEFAULT_INFERENCE_STEPS;

  // Chunking and progress tracking
  private stopRequested = false;
  private stopSignalResolver: (() => void) | null = null;
  private currentUtteranceId = 0;
  private chunkProgressCallback: ChunkProgressCallback | null = null;

  // Synthesis state tracking for safe resource release
  private isSynthesizing = false;
  private synthesisCompleteResolver: (() => void) | null = null;

  constructor() {
    this.inference = new SupertonicInference();
    this.styleLoader = new StyleLoader();
    this.unicodeProcessor = new UnicodeProcessor();
  }

  /**
   * Set callback for chunk progress events
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
   * Initialize the Supertonic engine with model files.
   * If initialization fails partway through, cleans up any partial state.
   */
  async initialize(config?: SupertonicConfig): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (this.isLoading) {
      throw new Error('Engine is already loading');
    }

    this.isLoading = true;
    this.initError = null;

    try {
      if (!config) {
        throw new Error('Supertonic config required for initialization');
      }

      this.config = config;

      if (config.defaultInferenceSteps) {
        this.defaultInferenceSteps = config.defaultInferenceSteps;
      }

      log.info('Initializing with config:', {
        durationPredictorPath: config.durationPredictorPath,
        textEncoderPath: config.textEncoderPath,
        vectorEstimatorPath: config.vectorEstimatorPath,
        vocoderPath: config.vocoderPath,
        voicesPath: config.voicesPath,
        unicodeIndexerPath: config.unicodeIndexerPath,
      });

      // Initialize unicode processor
      await this.unicodeProcessor.initialize(config.unicodeIndexerPath);

      // Pass unicode processor to inference
      this.inference.setUnicodeProcessor(this.unicodeProcessor);

      // Initialize inference pipeline (loads all 4 ONNX models)
      await this.inference.initialize(config);

      // Load voice styles
      await this.loadVoices(config.voicesPath);

      this.isInitialized = true;
      log.info('Initialization complete');
    } catch (error) {
      // Clean up any partial initialization to allow retry
      await this.destroy();
      this.initError = error instanceof Error ? error.message : 'Unknown error';
      log.error('Initialization failed:', error);
      throw error;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Check if engine is ready
   */
  async isReady(): Promise<boolean> {
    return (
      this.isInitialized &&
      this.inference.isReady() &&
      this.unicodeProcessor.isReady() &&
      this.styleLoader.isReady()
    );
  }

  /**
   * Synthesize text to audio and play it
   * Automatically chunks long text by sentences for better performance
   */
  async synthesize(
    text: string,
    options?: SupertonicSynthesisOptions,
  ): Promise<AudioBuffer | void> {
    if (!this.isInitialized) {
      throw new Error('Supertonic engine not initialized');
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

  /**
   * Create a stop signal promise that resolves when stop() is called.
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
    options?: SupertonicSynthesisOptions,
  ): Promise<AudioBuffer | void> {
    // Reset stop flag and generate new utterance ID
    this.stopRequested = false;
    this.stopSignalResolver = null;
    this.currentUtteranceId = Date.now();
    const utteranceId = this.currentUtteranceId;

    // Create stop signal for racing against long-running operations
    const stopSignal = this.createStopSignal();

    // Get synthesis options
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const inferenceSteps =
      options?.inferenceSteps || this.defaultInferenceSteps;
    const speed = options?.speed ?? 1.0;

    log.debug(
      `Synthesis start: text="${text.substring(0, 50)}...", voice=${voiceId}, steps=${inferenceSteps}, speed=${speed}`,
    );

    // Load voice style
    const voiceStyle = await this.styleLoader.getVoiceStyle(voiceId);

    // Chunk text by sentences
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    const chunks = TextChunker.chunkBySentences(text, maxChunkSize);

    log.debug(`Split into ${chunks.length} chunks`);

    // Pipelined synthesis: synthesize next chunk while current one plays
    let nextAudioPromise: Promise<AudioBuffer> | null = null;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (this.stopRequested) {
        log.debug('Stop requested, aborting synthesis');
        return undefined;
      }

      const chunk = chunks[chunkIndex] as TextChunk;
      const progress = Math.round((chunkIndex / chunks.length) * 100);

      log.debug(`Processing chunk ${chunkIndex + 1}/${chunks.length}`);

      // Emit chunk progress event
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

      // Get current chunk's audio, racing against stop signal
      let audioBuffer: AudioBuffer | null;

      try {
        if (nextAudioPromise) {
          audioBuffer = await this.raceWithStop(nextAudioPromise, stopSignal);
          nextAudioPromise = null;
        } else {
          audioBuffer = await this.raceWithStop(
            this.synthesizeChunk(chunk.text, voiceStyle, inferenceSteps, speed),
            stopSignal,
          );
        }

        // Stop signal won the race
        if (audioBuffer === null || this.stopRequested) {
          log.debug('Stop requested, aborting synthesis');
          return undefined;
        }

        log.debug(`Chunk synthesized: ${audioBuffer.samples.length} samples`);
      } catch (synthError) {
        log.error('Synthesis error:', synthError);
        throw synthError;
      }

      if (this.stopRequested || audioBuffer.samples.length === 0) {
        log.debug('Stop requested before playback');
        return undefined;
      }

      // Start synthesizing next chunk in parallel
      // (only if not already stopping to avoid wasted work)
      const nextChunkIndex = chunkIndex + 1;
      if (!this.stopRequested && nextChunkIndex < chunks.length) {
        const nextChunk = chunks[nextChunkIndex] as TextChunk;
        nextAudioPromise = this.synthesizeChunk(
          nextChunk.text,
          voiceStyle,
          inferenceSteps,
          speed,
        );
      }

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

      // Play current chunk, racing against stop signal
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
   * Synthesize a single chunk of text
   */
  private async synthesizeChunk(
    text: string,
    voiceStyle: SupertonicVoiceStyle,
    inferenceSteps: number,
    speed: number,
  ): Promise<AudioBuffer> {
    // Normalize text
    const normalized = this.unicodeProcessor.normalize(text);

    // Check stop before expensive inference
    if (this.stopRequested) {
      return {
        samples: new Float32Array(0),
        sampleRate: SUPERTONIC_CONSTANTS.SAMPLE_RATE,
        channels: 1,
        duration: 0,
      };
    }

    // Run inference pipeline
    return this.inference.synthesize(
      normalized,
      voiceStyle,
      inferenceSteps,
      speed,
    );
  }

  /**
   * Get available voices
   */
  async getAvailableVoices(language?: string): Promise<string[]> {
    if (!this.isInitialized) {
      throw new Error('Supertonic engine not initialized');
    }

    return this.styleLoader.getVoiceIds(language);
  }

  /**
   * Get voices with metadata
   */
  getVoicesWithMetadata(language?: string): SupertonicVoice[] {
    if (!this.isInitialized) {
      throw new Error('Supertonic engine not initialized');
    }

    return this.styleLoader.getVoices(language);
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
    // Fire-and-forget native audio stop
    neuralAudioPlayer.stop().catch(() => {});
  }

  /**
   * Clean up resources
   */
  async destroy(): Promise<void> {
    this.stopRequested = true;

    await this.inference.destroy();
    this.styleLoader.clear();
    this.unicodeProcessor.clear();

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
   * - 4 ONNX InferenceSessions (duration predictor, text encoder, vector estimator, vocoder)
   * - Voice style embeddings cache
   * - Unicode processor data
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

    // 4. Release inference pipeline (4 ONNX sessions)
    try {
      const inferenceErrors = await this.inference.release();
      if (inferenceErrors.length > 0) {
        for (const err of inferenceErrors) {
          errors.push({component: 'inference', error: err});
        }
      }
      log.debug('Inference pipeline released');
    } catch (e) {
      log.warn('Failed to release inference:', e);
      errors.push({component: 'inference', error: e as Error});
    }

    // 5. Clear style cache
    try {
      this.styleLoader.clear();
      log.debug('Style loader cleared');
    } catch (e) {
      log.warn('Failed to clear style loader:', e);
      errors.push({component: 'styleLoader', error: e as Error});
    }

    // 6. Clear unicode processor
    try {
      this.unicodeProcessor.clear();
      log.debug('Unicode processor cleared');
    } catch (e) {
      log.warn('Failed to clear unicode processor:', e);
      errors.push({component: 'unicodeProcessor', error: e as Error});
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
  getStatus(): {isReady: boolean; isLoading: boolean; error: string | null} {
    return {
      isReady: this.isInitialized,
      isLoading: this.isLoading,
      error: this.initError,
    };
  }

  /**
   * Load voice styles from manifest or directory
   */
  private async loadVoices(voicesPath: string): Promise<void> {
    try {
      log.info('Loading voices from:', voicesPath);

      if (voicesPath.includes('manifest') && voicesPath.endsWith('.json')) {
        // Manifest mode - lazy loading
        const manifest = await loadAssetAsJSON<VoiceManifest>(voicesPath);
        await this.styleLoader.loadFromManifest(manifest, voicesPath);
        log.info('Loaded voice manifest');
      } else if (voicesPath.endsWith('.json')) {
        // Single voice file or voice list - could be manifest or single voice
        const data = await loadAssetAsJSON<VoiceManifest | RawVoiceStyleData>(
          voicesPath,
        );
        if ('voices' in data && Array.isArray(data.voices)) {
          // Manifest format
          await this.styleLoader.loadFromManifest(
            data as VoiceManifest,
            voicesPath,
          );
        } else if ('style_dp' in data && 'style_ttl' in data) {
          // Single voice style
          const voiceId =
            voicesPath.split('/').pop()?.replace('.json', '') || 'default';
          this.styleLoader.loadVoiceFromData(
            voiceId,
            data as RawVoiceStyleData,
          );
        }
      } else {
        throw new Error(
          'Supertonic requires a voices manifest JSON file. ' +
            'Directory scanning is not supported.',
        );
      }

      log.info('Voices loaded:', this.styleLoader.getVoiceIds().length);
    } catch (error) {
      throw new Error(
        `Failed to load voices: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
