/**
 * Kokoro TTS Engine
 *
 * Neural TTS engine using ONNX Runtime for inference
 * Supports sentence-level chunking for long text with progress events
 */

import {Platform} from 'react-native';
import type {
  TTSEngine,
  TTSEngineInterface,
  AudioBuffer,
  KokoroConfig,
  KokoroSynthesisOptions,
  KokoroVoice,
  ChunkProgressEvent,
  ChunkProgressCallback,
  ExecutionProvider,
  ExecutionProviderPreset,
} from '../../types';
import {BPETokenizer} from './BPETokenizer';
import {VoiceLoader} from './VoiceLoader';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';
import {createPhonemizer, type IPhonemizer} from './Phonemizer';
import {TextNormalizer, type TextChunk} from './TextNormalizer';

// Lazy import ONNX Runtime to allow graceful handling if not installed
let InferenceSession: any;
let Tensor: any;

/**
 * Check if ONNX Runtime is available
 * Throws helpful error if not installed
 */
function ensureONNXRuntime() {
  if (!InferenceSession || !Tensor) {
    try {
      const onnx = require('onnxruntime-react-native');
      InferenceSession = onnx.InferenceSession;
      Tensor = onnx.Tensor;
    } catch (error) {
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
}

// Maximum tokens the Kokoro model supports (voice embeddings are for 0-509 tokens)
const MAX_TOKEN_LIMIT = 500;

// Default max chunk size in characters (conservative to stay within token limits)
// Apps can override this via KokoroConfig.maxChunkSize for streaming-like UX
const DEFAULT_MAX_CHUNK_SIZE = 400;

/**
 * Resolve execution provider preset or array to ONNX Runtime format
 * Returns the executionProviders array for InferenceSession.create()
 */
function resolveExecutionProviders(
  config: ExecutionProviderPreset | ExecutionProvider[] | undefined,
): any[] {
  // If not specified, use 'auto' preset
  if (!config) {
    config = 'auto';
  }

  // Handle preset strings
  if (typeof config === 'string') {
    const isIOS = Platform.OS === 'ios';

    switch (config) {
      case 'auto':
        // Platform-specific defaults with hardware acceleration
        if (isIOS) {
          return [
            {
              name: 'coreml',
              useCPUOnly: false,
              useCPUAndGPU: true,
              enableOnSubgraph: true,
            },
            'xnnpack',
            'cpu',
          ];
        } else {
          // Android
          return ['nnapi', 'xnnpack', 'cpu'];
        }

      case 'cpu':
        // Force CPU-only execution
        return ['cpu'];

      case 'gpu':
        // Prefer GPU acceleration
        if (isIOS) {
          return [
            {
              name: 'coreml',
              useCPUOnly: false,
              useCPUAndGPU: true,
              enableOnSubgraph: true,
            },
            'cpu',
          ];
        } else {
          return ['nnapi', 'cpu'];
        }

      case 'ane':
        // Prefer Apple Neural Engine (iOS only)
        if (isIOS) {
          return [
            {
              name: 'coreml',
              useCPUOnly: false,
              useCPUAndGPU: false, // Let CoreML decide (may use ANE)
              onlyEnableDeviceWithANE: true,
              enableOnSubgraph: true,
            },
            'cpu',
          ];
        } else {
          // Fall back to NNAPI on Android
          console.warn(
            '[KokoroEngine] ANE preset is iOS-only, falling back to NNAPI on Android',
          );
          return ['nnapi', 'cpu'];
        }

      default:
        return ['cpu'];
    }
  }

  // Handle array of providers - pass through as-is
  return config;
}

export class KokoroEngine implements TTSEngineInterface {
  readonly name: TTSEngine = 'kokoro' as TTSEngine;

  private session: any = null; // InferenceSession type
  private tokenizer: BPETokenizer;
  private voiceLoader: VoiceLoader;
  private phonemizer: IPhonemizer;
  private normalizer: TextNormalizer;

  private config: KokoroConfig | null = null;
  private isInitialized = false;
  private isLoading = false;
  private initError: string | null = null;

  private defaultVoiceId = 'af_bella'; // Default voice
  private sampleRate = 24000; // Kokoro outputs 24kHz audio

  // Chunking and progress tracking
  private stopRequested = false;
  private currentUtteranceId = 0;
  private chunkProgressCallback: ChunkProgressCallback | null = null;

  constructor() {
    this.tokenizer = new BPETokenizer();
    this.voiceLoader = new VoiceLoader();
    this.normalizer = new TextNormalizer();
    // Phonemizer will be initialized in initialize() based on config
    this.phonemizer = createPhonemizer('native'); // Default to no phonemization for backward compatibility
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
    // Check if ONNX Runtime is available
    ensureONNXRuntime();

    if (this.isInitialized) {
      return;
    }

    if (this.isLoading) {
      throw new Error('Engine is already loading');
    }

    this.isLoading = true;
    this.initError = null;

    try {
      console.log('[KokoroEngine.initialize] Received config:', config);

      // Config with model paths is required
      if (config) {
        this.config = config;
      } else {
        throw new Error('Kokoro config required for initialization');
      }

      console.log('[KokoroEngine.initialize] Stored config:', this.config);
      console.log(
        '[KokoroEngine.initialize] Config phonemizerType:',
        this.config.phonemizerType,
      );
      console.log(
        '[KokoroEngine.initialize] Config phonemizerUrl:',
        this.config.phonemizerUrl,
      );

      // Initialize phonemizer based on config
      const phonemizerType = this.config.phonemizerType || 'none';
      // const phonemizerUrl =
      //   this.config.phonemizerUrl || 'http://localhost:3000';
      console.log(
        '[KokoroEngine.initialize] Creating phonemizer with type:',
        phonemizerType,
      );
      // console.log(
      //   '[KokoroEngine.initialize] Creating phonemizer with URL:',
      //   phonemizerUrl,
      // );
      this.phonemizer = createPhonemizer(phonemizerType);

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

    // Reset stop flag and generate new utterance ID
    this.stopRequested = false;
    this.currentUtteranceId = Date.now();
    const utteranceId = this.currentUtteranceId;

    // Get voice ID early (needed for language detection)
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const language = this.getLanguageFromVoice(voiceId);

    console.log(
      '[KokoroEngine] ========== SYNTHESIS PIPELINE START ==========',
    );
    console.log('[KokoroEngine] Original text:', text);
    console.log('[KokoroEngine] Voice ID:', voiceId);
    console.log('[KokoroEngine] Utterance ID:', utteranceId);
    console.log(
      '[KokoroEngine] Phonemizer type:',
      this.config?.phonemizerType || 'none',
    );

    // STEP 1: Chunk text by sentences for streaming playback
    // Use the original text for chunking to preserve positions
    // Use configured maxChunkSize or fall back to default
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    const chunks = this.normalizer.chunkBySentencesWithMetadata(
      text,
      maxChunkSize,
    );

    console.log(
      '[KokoroEngine] STEP 1 - Text chunked into',
      chunks.length,
      'chunks',
    );

    // Use pipelined synthesis: synthesize next chunk while current one plays
    // This eliminates the gap between chunks
    let nextAudioPromise: Promise<AudioBuffer> | null = null;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      // Check if stop was requested
      if (this.stopRequested) {
        console.log('[KokoroEngine] Stop requested, aborting synthesis');
        return undefined;
      }

      const chunk = chunks[chunkIndex] as TextChunk;
      const progress = Math.round((chunkIndex / chunks.length) * 100);

      console.log(
        `[KokoroEngine] Processing chunk ${chunkIndex + 1}/${chunks.length}:`,
        chunk.text.substring(0, 50) + (chunk.text.length > 50 ? '...' : ''),
      );

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
      let audioBuffer: AudioBuffer;

      if (nextAudioPromise) {
        // We already started synthesizing this chunk, wait for it
        audioBuffer = await nextAudioPromise;
        nextAudioPromise = null;
      } else {
        // First chunk - synthesize it now
        audioBuffer = await this.synthesizeTextChunk(
          chunk.text,
          voiceId,
          language,
          options,
        );
      }

      // Check if stop was requested before playing
      if (this.stopRequested) {
        console.log('[KokoroEngine] Stop requested, aborting before playback');
        return undefined;
      }

      // Start synthesizing next chunk in parallel with playback
      const nextChunkIndex = chunkIndex + 1;
      if (nextChunkIndex < chunks.length) {
        const nextChunk = chunks[nextChunkIndex] as TextChunk;
        console.log(
          `[KokoroEngine] Pre-synthesizing chunk ${nextChunkIndex + 1}/${chunks.length}`,
        );
        nextAudioPromise = this.synthesizeTextChunk(
          nextChunk.text,
          voiceId,
          language,
          options,
        );
      }

      // Play current chunk audio (this waits for playback to complete)
      await neuralAudioPlayer.play(audioBuffer, {
        ducking: options?.ducking,
        silentMode: options?.silentMode,
      });
    }

    // Note: We don't emit a final 100% progress event here because:
    // 1. The last chunk's progress event was already emitted before playback
    // 2. The native onFinish event fires when playback completes
    // 3. Emitting another progress event after onFinish would re-set highlights
    //    that the app already cleared in response to onFinish

    console.log('[KokoroEngine] ========== SYNTHESIS COMPLETE ==========');
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
    // STEP 2: Normalize chunk text
    const normalized = this.normalizer.normalize(chunkText);
    console.log(
      '[KokoroEngine] STEP 2 - Normalized chunk:',
      normalized.substring(0, 50),
    );

    // STEP 3: Phonemize (convert text to phonemes)
    const phonemes = await this.phonemizer.phonemize(normalized, language);
    console.log(
      '[KokoroEngine] STEP 3 - Phonemes length:',
      phonemes.length,
      'chars',
    );

    // STEP 4: Tokenize phonemes
    const tokens = this.tokenizer.encode(phonemes);
    console.log('[KokoroEngine] STEP 4 - Tokens generated:', tokens.length);

    // Check token limit
    if (tokens.length > MAX_TOKEN_LIMIT) {
      console.warn(
        `[KokoroEngine] Warning: Chunk has ${tokens.length} tokens, exceeding limit of ${MAX_TOKEN_LIMIT}. Audio may be truncated.`,
      );
    }

    // STEP 5: Generate audio for this chunk
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

    // Create input tensors
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
      sampleRate: this.sampleRate,
      channels: 1, // Mono
      duration: audioData.length / this.sampleRate,
    };

    // Apply volume if specified
    if (options?.volume !== undefined && options.volume !== 1.0) {
      for (let i = 0; i < audioBuffer.samples.length; i++) {
        const sample = audioBuffer.samples[i];
        if (sample !== undefined) {
          audioBuffer.samples[i] = sample * options.volume;
        }
      }
    }

    const totalChunkTime = Date.now() - chunkStartTime;
    console.log(
      `[KokoroEngine] STEP 5 - Chunk synthesis complete: inference=${inferenceTime}ms, voice=${voiceTime}ms, total=${totalChunkTime}ms, tokens=${tokens.length}, audio=${audioBuffer.duration.toFixed(2)}s`,
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
   * Stop current playback and abort any ongoing synthesis
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    await neuralAudioPlayer.stop();
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
    try {
      // Resolve execution providers from config
      const executionProviders = resolveExecutionProviders(
        this.config?.executionProviders,
      );

      console.log(
        '[KokoroEngine] Loading model with execution providers:',
        JSON.stringify(executionProviders),
      );
      console.log(
        '[KokoroEngine] Configured preset:',
        this.config?.executionProviders,
      );

      // Create session with execution providers for hardware acceleration
      const sessionOptions = {
        executionProviders,
      };

      console.log('[KokoroEngine] Creating InferenceSession...');
      const startTime = Date.now();
      this.session = await InferenceSession.create(modelPath, sessionOptions);
      const loadTime = Date.now() - startTime;

      console.log(
        `[KokoroEngine] Model loaded successfully in ${loadTime}ms with providers:`,
        JSON.stringify(executionProviders),
      );
    } catch (error) {
      // If hardware acceleration fails, try CPU-only as fallback
      console.warn(
        '[KokoroEngine] Failed to load with acceleration, trying CPU fallback:',
        error instanceof Error ? error.message : 'Unknown error',
      );

      try {
        this.session = await InferenceSession.create(modelPath, {
          executionProviders: ['cpu'],
        });
        console.log('[KokoroEngine] Model loaded with CPU fallback');
      } catch (fallbackError) {
        throw new Error(
          `Failed to load ONNX model: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * Load BPE tokenizer
   */
  private async loadTokenizer(
    vocabPath: string,
    mergesPath: string,
  ): Promise<void> {
    try {
      // These would typically be loaded from bundled assets
      // For now, we'll need to integrate with React Native's asset system
      console.log(
        '[KokoroEngine] Loading tokenizer from:',
        vocabPath,
        mergesPath,
      );
      const {loadAssetAsJSON, loadAssetAsText} = require('./utils/AssetLoader');

      const vocabData = await loadAssetAsJSON(vocabPath);
      const mergesText = await loadAssetAsText(mergesPath);
      const mergesArray = mergesText
        .split('\n')
        .filter((line: string) => line.trim() && !line.startsWith('#'));

      await this.tokenizer.loadFromData(vocabData, mergesArray);
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
      console.log(
        '[KokoroEngine] Loading tokenizer from HF format:',
        tokenizerPath,
      );

      console.log('[KokoroEngine] Requiring AssetLoader...');
      const {loadAssetAsJSON} = require('./utils/AssetLoader');
      console.log('[KokoroEngine] AssetLoader loaded successfully');

      console.log('[KokoroEngine] Loading tokenizer JSON...');
      const tokenizerData = await loadAssetAsJSON(tokenizerPath);
      console.log(
        '[KokoroEngine] Tokenizer JSON loaded, keys:',
        Object.keys(tokenizerData),
      );

      // Extract vocab from HF tokenizer.json format
      const vocab = tokenizerData.model?.vocab || {};
      console.log('[KokoroEngine] Vocab size:', Object.keys(vocab).length);

      // Extract merges from HF tokenizer.json format
      const merges = tokenizerData.model?.merges || [];
      console.log('[KokoroEngine] Merges count:', merges.length);

      console.log('[KokoroEngine] Loading tokenizer data...');
      await this.tokenizer.loadFromData(vocab, merges);
      console.log('[KokoroEngine] Tokenizer loaded successfully');
    } catch (error) {
      console.error(
        '[KokoroEngine] Error loading tokenizer from HF format:',
        error,
      );
      throw new Error(
        `Failed to load tokenizer from HF format: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Load voice embeddings
   */
  private async loadVoices(voicesPath: string): Promise<void> {
    try {
      console.log('[KokoroEngine] Loading voices from:', voicesPath);
      console.log(
        '[KokoroEngine] Path includes manifest?',
        voicesPath.includes('manifest'),
      );
      console.log(
        '[KokoroEngine] Path ends with .json?',
        voicesPath.endsWith('.json'),
      );

      // Check if it's a manifest file (lazy loading) or direct voices file
      // Check for both 'manifest' in path AND .json extension for manifest files
      if (voicesPath.includes('manifest') && voicesPath.endsWith('.json')) {
        console.log(
          '[KokoroEngine] Detected manifest file - using lazy loading',
        );
        const {loadAssetAsJSON} = require('./utils/AssetLoader');
        const manifest = await loadAssetAsJSON(voicesPath);
        console.log('[KokoroEngine] Manifest loaded successfully');
        console.log(
          '[KokoroEngine] Manifest voices count:',
          manifest.voices?.length,
        );
        console.log('[KokoroEngine] Manifest baseUrl:', manifest.baseUrl);

        // Initialize voice loader with manifest (lazy loading mode)
        await this.voiceLoader.loadFromManifest(manifest, voicesPath);
        console.log('[KokoroEngine] Voice loader initialized with manifest');
      } else if (voicesPath.endsWith('.json')) {
        console.log('[KokoroEngine] Loading voices from JSON (non-manifest)');
        const {loadAssetAsJSON} = require('./utils/AssetLoader');
        const voicesData = await loadAssetAsJSON(voicesPath);
        console.log(
          '[KokoroEngine] Voices JSON loaded, keys:',
          Object.keys(voicesData).length,
        );
        await this.voiceLoader.loadFromJSON(voicesData);
      } else {
        console.log('[KokoroEngine] Loading voices from binary file');
        const {loadAssetAsArrayBuffer} = require('./utils/AssetLoader');
        const voicesData = await loadAssetAsArrayBuffer(voicesPath);
        console.log(
          '[KokoroEngine] Voices data loaded, size:',
          voicesData.byteLength,
        );
        await this.voiceLoader.loadFromBinary(voicesData);
      }

      console.log('[KokoroEngine] Voice loader initialized');
      console.log(
        '[KokoroEngine] Voice loader ready:',
        this.voiceLoader.isReady(),
      );
      console.log(
        '[KokoroEngine] Available voices:',
        this.voiceLoader.getAvailableVoices().length,
      );
    } catch (error) {
      console.error('[KokoroEngine] Failed to load voices:', error);
      throw new Error(
        `Failed to load voices: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get language code from voice ID
   * Voice IDs follow the pattern: {lang}{gender}_{name}
   * e.g., 'af_bella' -> 'a' (American English for remote API)
   *       'bf_emma' -> 'b' (British English for remote API)
   *
   * Returns format based on phonemizer type:
   * - Remote API: 'a' or 'b'
   * - Native espeak-ng: 'en-us' or 'en-gb'
   */
  private getLanguageFromVoice(voiceId: string): string {
    const langCode = voiceId.charAt(0).toLowerCase();
    const phonemizerType = this.config?.phonemizerType || 'none';

    // Remote API uses single-letter codes
    if (phonemizerType === 'remote') {
      switch (langCode) {
        case 'a':
          return 'a'; // American English
        case 'b':
          return 'b'; // British English
        default:
          return 'a';
      }
    }

    // Native espeak-ng uses standard language codes
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
