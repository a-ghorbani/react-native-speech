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

const {DEFAULT_MAX_CHUNK_SIZE, DEFAULT_INFERENCE_STEPS} = SUPERTONIC_CONSTANTS;

export class SupertonicEngine implements TTSEngineInterface {
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
  private currentUtteranceId = 0;
  private chunkProgressCallback: ChunkProgressCallback | null = null;

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

      console.log('[SupertonicEngine] Initializing with config:', {
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
      console.log('[SupertonicEngine] Initialization complete');
    } catch (error) {
      // Clean up any partial initialization to allow retry
      await this.destroy();
      this.initError = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SupertonicEngine] Initialization failed:', error);
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

    // Reset stop flag and generate new utterance ID
    this.stopRequested = false;
    this.currentUtteranceId = Date.now();
    const utteranceId = this.currentUtteranceId;

    // Get synthesis options
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const inferenceSteps =
      options?.inferenceSteps || this.defaultInferenceSteps;
    const speed = options?.speed ?? 1.0;

    console.log('[SupertonicEngine] ========== SYNTHESIS START ==========');
    console.log(`[SupertonicEngine] Text: "${text.substring(0, 50)}..."`);
    console.log(
      `[SupertonicEngine] Voice: ${voiceId}, Steps: ${inferenceSteps}, Speed: ${speed}`,
    );

    // Load voice style
    const voiceStyle = await this.styleLoader.getVoiceStyle(voiceId);

    // Chunk text by sentences
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    const chunks = TextChunker.chunkBySentences(text, maxChunkSize);

    console.log(`[SupertonicEngine] Split into ${chunks.length} chunks`);

    // Pipelined synthesis: synthesize next chunk while current one plays
    let nextAudioPromise: Promise<AudioBuffer> | null = null;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (this.stopRequested) {
        console.log('[SupertonicEngine] Stop requested, aborting synthesis');
        return undefined;
      }

      const chunk = chunks[chunkIndex] as TextChunk;
      const progress = Math.round((chunkIndex / chunks.length) * 100);

      console.log(
        `[SupertonicEngine] Processing chunk ${chunkIndex + 1}/${chunks.length}`,
      );

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

      // Get current chunk's audio
      let audioBuffer: AudioBuffer;

      try {
        if (nextAudioPromise) {
          audioBuffer = await nextAudioPromise;
          nextAudioPromise = null;
        } else {
          audioBuffer = await this.synthesizeChunk(
            chunk.text,
            voiceStyle,
            inferenceSteps,
            speed,
          );
        }
        console.log(
          `[SupertonicEngine] Chunk synthesized: ${audioBuffer.samples.length} samples`,
        );
      } catch (synthError) {
        console.error('[SupertonicEngine] Synthesis error:', synthError);
        throw synthError;
      }

      if (this.stopRequested) {
        console.log('[SupertonicEngine] Stop requested before playback');
        return undefined;
      }

      // Start synthesizing next chunk in parallel
      const nextChunkIndex = chunkIndex + 1;
      if (nextChunkIndex < chunks.length) {
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

      // Play current chunk
      await neuralAudioPlayer.play(audioBuffer, {
        ducking: options?.ducking,
        silentMode: options?.silentMode,
      });
    }

    console.log('[SupertonicEngine] ========== SYNTHESIS COMPLETE ==========');
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
   * Stop current playback
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    await neuralAudioPlayer.stop();
  }

  /**
   * Clean up resources
   */
  async destroy(): Promise<void> {
    this.stopRequested = true;

    await this.inference.destroy();
    this.styleLoader.clear();

    this.isInitialized = false;
    this.isLoading = false;
    this.initError = null;
    this.config = null;
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
      console.log('[SupertonicEngine] Loading voices from:', voicesPath);

      if (voicesPath.includes('manifest') && voicesPath.endsWith('.json')) {
        // Manifest mode - lazy loading
        const manifest = await loadAssetAsJSON<VoiceManifest>(voicesPath);
        await this.styleLoader.loadFromManifest(manifest, voicesPath);
        console.log('[SupertonicEngine] Loaded voice manifest');
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

      console.log(
        '[SupertonicEngine] Voices loaded:',
        this.styleLoader.getVoiceIds().length,
      );
    } catch (error) {
      throw new Error(
        `Failed to load voices: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
