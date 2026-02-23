/**
 * Pocket TTS Engine
 *
 * 100M-parameter CALM-based neural TTS engine using ONNX Runtime.
 * Uses a 4-ONNX-session pipeline with autoregressive generation:
 * 1. Text Conditioner - tokens to embeddings
 * 2. Flow LM Main - stateful autoregressive generation
 * 3. Flow LM Flow - LSD flow matching
 * 4. Mimi Decoder - neural audio codec
 *
 * Features:
 * - CPU-optimized (designed for on-device inference)
 * - 8 built-in English voices
 * - 24kHz mono output
 * - SentencePiece tokenizer (no external G2P needed)
 * - Sentence-level chunking with progress events
 *
 * Based on: https://github.com/kyutai-labs/pocket-tts
 */

import type {
  TTSEngine,
  TTSEngineInterface,
  AudioBuffer,
  PocketConfig,
  PocketSynthesisOptions,
  PocketVoice,
  ChunkProgressEvent,
  ChunkProgressCallback,
  ReleaseResult,
  ReleaseError,
} from '../../types';
import {PocketInference} from './PocketInference';
import {
  VoiceEmbeddingLoader,
  type VoiceEmbeddingManifest,
  type RawVoiceEmbeddingData,
} from './VoiceEmbeddingLoader';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';
import {loadAssetAsJSON} from '../../utils/AssetLoader';
import {TextChunker, type TextChunk} from '../../utils/TextChunker';
import {POCKET_CONSTANTS} from './constants';
import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('Pocket', 'Engine');

const {
  DEFAULT_MAX_CHUNK_SIZE,
  DEFAULT_LSD_STEPS,
  DEFAULT_TEMPERATURE,
  DEFAULT_EOS_THRESHOLD,
  DEFAULT_MAX_TOKENS,
} = POCKET_CONSTANTS;

export class PocketEngine implements TTSEngineInterface {
  readonly name: TTSEngine = 'pocket' as TTSEngine;

  private inference: PocketInference;
  private voiceLoader: VoiceEmbeddingLoader;

  private config: PocketConfig | null = null;
  private isInitialized = false;
  private isLoading = false;
  private initError: string | null = null;

  private defaultVoiceId = 'alba';
  private defaultLsdSteps: number = DEFAULT_LSD_STEPS;
  private defaultTemperature: number = DEFAULT_TEMPERATURE;
  private defaultEosThreshold: number = DEFAULT_EOS_THRESHOLD;
  private defaultMaxTokens: number = DEFAULT_MAX_TOKENS;

  // Chunking and progress tracking
  private stopRequested = false;
  private currentUtteranceId = 0;
  private chunkProgressCallback: ChunkProgressCallback | null = null;

  // Synthesis state tracking for safe resource release
  private isSynthesizing = false;
  private synthesisCompleteResolver: (() => void) | null = null;

  constructor() {
    this.inference = new PocketInference();
    this.voiceLoader = new VoiceEmbeddingLoader();
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
   * Initialize the Pocket engine with model files.
   * If initialization fails partway through, cleans up any partial state.
   */
  async initialize(config?: PocketConfig): Promise<void> {
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
        throw new Error('Pocket config required for initialization');
      }

      this.config = config;

      // Apply config defaults
      if (config.defaultLsdSteps) {
        this.defaultLsdSteps = config.defaultLsdSteps;
      }
      if (config.defaultTemperature !== undefined) {
        this.defaultTemperature = config.defaultTemperature;
      }
      if (config.defaultEosThreshold !== undefined) {
        this.defaultEosThreshold = config.defaultEosThreshold;
      }
      if (config.defaultMaxTokens !== undefined) {
        this.defaultMaxTokens = config.defaultMaxTokens;
      }

      log.info('Initializing with config:', {
        textConditionerPath: config.textConditionerPath,
        flowLmMainPath: config.flowLmMainPath,
        flowLmFlowPath: config.flowLmFlowPath,
        mimiDecoderPath: config.mimiDecoderPath,
        tokenizerModelPath: config.tokenizerModelPath,
        voiceEmbeddingsPath: config.voiceEmbeddingsPath,
      });

      // Initialize inference pipeline (loads 4 ONNX models + tokenizer)
      await this.inference.initialize(config);

      // Load voice embeddings
      await this.loadVoices(config.voiceEmbeddingsPath);

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
      this.voiceLoader.isReady()
    );
  }

  /**
   * Synthesize text to audio and play it.
   * Automatically chunks long text by sentences for better performance.
   */
  async synthesize(
    text: string,
    options?: PocketSynthesisOptions,
  ): Promise<AudioBuffer | void> {
    if (!this.isInitialized) {
      throw new Error('Pocket engine not initialized');
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
   * Internal synthesis implementation
   */
  private async doSynthesize(
    text: string,
    options?: PocketSynthesisOptions,
  ): Promise<AudioBuffer | void> {
    // Reset stop flag and generate new utterance ID
    this.stopRequested = false;
    this.currentUtteranceId = Date.now();
    const utteranceId = this.currentUtteranceId;

    // Get synthesis options
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const lsdSteps = options?.lsdSteps || this.defaultLsdSteps;
    const temperature = options?.temperature ?? this.defaultTemperature;
    const eosThreshold = options?.eosThreshold ?? this.defaultEosThreshold;
    const maxTokens = options?.maxTokens ?? this.defaultMaxTokens;

    log.info(
      `Synthesizing: voice=${voiceId}, lsdSteps=${lsdSteps}, temp=${temperature}, ` +
        `text="${text.substring(0, 50)}..."`,
    );

    // Load voice embedding
    const voiceEmbedding = await this.voiceLoader.getVoiceEmbedding(voiceId);

    // Chunk text by sentences
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    const chunks = TextChunker.chunkBySentences(text, maxChunkSize);

    log.info(`Split into ${chunks.length} chunks`);

    // Sequential synthesis: Pocket TTS autoregressive generation is expensive
    // and holds KV cache state, so pipelining is deferred to a future version.
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (this.stopRequested) {
        log.info('Stop requested, aborting synthesis');
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

      // Synthesize chunk
      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await this.inference.synthesize(
          chunk.text,
          voiceEmbedding,
          lsdSteps,
          temperature,
          eosThreshold,
          maxTokens,
        );
        log.debug(`Chunk synthesized: ${audioBuffer.samples.length} samples`);
      } catch (synthError) {
        log.error('Synthesis error:', synthError);
        throw synthError;
      }

      if (this.stopRequested) {
        log.debug('Stop requested before playback');
        return undefined;
      }

      // Apply volume if specified
      if (options?.volume !== undefined && options.volume !== 1.0) {
        const clampedVolume = Math.max(0, Math.min(1, options.volume));
        for (let i = 0; i < audioBuffer.samples.length; i++) {
          const sample = audioBuffer.samples[i];
          if (sample !== undefined) {
            audioBuffer.samples[i] = Math.max(
              -1,
              Math.min(1, sample * clampedVolume),
            );
          }
        }
      }

      // Play current chunk
      await neuralAudioPlayer.play(audioBuffer, {
        ducking: options?.ducking,
        silentMode: options?.silentMode,
      });
    }

    log.info('Synthesis complete');
    return undefined;
  }

  /**
   * Get available voices
   */
  async getAvailableVoices(language?: string): Promise<string[]> {
    if (!this.isInitialized) {
      throw new Error('Pocket engine not initialized');
    }

    return this.voiceLoader.getVoiceIds(language);
  }

  /**
   * Get voices with metadata
   */
  getVoicesWithMetadata(language?: string): PocketVoice[] {
    if (!this.isInitialized) {
      throw new Error('Pocket engine not initialized');
    }

    return this.voiceLoader.getVoices(language);
  }

  /**
   * Stop current playback and abort autoregressive generation
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.inference.requestStop();
    await neuralAudioPlayer.stop();
  }

  /**
   * Clean up resources
   */
  async destroy(): Promise<void> {
    this.stopRequested = true;

    await this.inference.destroy();
    this.voiceLoader.clear();

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
      this.synthesisCompleteResolver = resolve;

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
   * - 4 ONNX InferenceSessions (text conditioner, flow LM main, flow LM flow, mimi decoder)
   * - SentencePiece tokenizer vocabulary
   * - Voice embeddings cache
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
    this.inference.requestStop();

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

    // 4. Release inference pipeline (4 ONNX sessions + tokenizer)
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

    // 5. Clear voice embeddings cache
    try {
      this.voiceLoader.clear();
      log.debug('Voice loader cleared');
    } catch (e) {
      log.warn('Failed to clear voice loader:', e);
      errors.push({component: 'voiceLoader', error: e as Error});
    }

    // 6. Reset state to allow re-initialization
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
   * Load voice embeddings from manifest or single file
   */
  private async loadVoices(voiceEmbeddingsPath: string): Promise<void> {
    try {
      log.info('Loading voices from:', voiceEmbeddingsPath);

      if (
        voiceEmbeddingsPath.includes('manifest') &&
        voiceEmbeddingsPath.endsWith('.json')
      ) {
        // Manifest mode - lazy loading
        const manifest =
          await loadAssetAsJSON<VoiceEmbeddingManifest>(voiceEmbeddingsPath);
        await this.voiceLoader.loadFromManifest(manifest, voiceEmbeddingsPath);
        log.info('Loaded voice manifest');
      } else if (voiceEmbeddingsPath.endsWith('.json')) {
        // Single voice file or voice list
        const data = await loadAssetAsJSON<
          VoiceEmbeddingManifest | RawVoiceEmbeddingData
        >(voiceEmbeddingsPath);

        if ('voices' in data && Array.isArray(data.voices)) {
          // Manifest format
          await this.voiceLoader.loadFromManifest(
            data as VoiceEmbeddingManifest,
            voiceEmbeddingsPath,
          );
        } else if ('embedding' in data || 'data' in data) {
          // Single voice embedding
          const voiceId =
            voiceEmbeddingsPath.split('/').pop()?.replace('.json', '') ||
            'default';
          this.voiceLoader.loadEmbeddingFromData(
            voiceId,
            data as RawVoiceEmbeddingData,
          );
        }
      } else {
        throw new Error(
          'Pocket requires a voices manifest JSON file. ' +
            'Directory scanning is not supported.',
        );
      }

      log.info('Voices loaded:', this.voiceLoader.getVoiceIds().length);
    } catch (error) {
      throw new Error(
        `Failed to load voices: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
