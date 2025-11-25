/**
 * Kokoro TTS Engine
 *
 * Neural TTS engine using ONNX Runtime for inference
 */

import type {
  TTSEngine,
  TTSEngineInterface,
  AudioBuffer,
  KokoroConfig,
  KokoroSynthesisOptions,
  KokoroVoice,
} from '../../types';
import {BPETokenizer} from './BPETokenizer';
import {VoiceLoader} from './VoiceLoader';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';

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

export class KokoroEngine implements TTSEngineInterface {
  readonly name: TTSEngine = 'kokoro' as TTSEngine;

  private session: any = null; // InferenceSession type
  private tokenizer: BPETokenizer;
  private voiceLoader: VoiceLoader;

  private config: KokoroConfig | null = null;
  private isInitialized = false;
  private isLoading = false;
  private initError: string | null = null;

  private defaultVoiceId = 'af_bella'; // Default voice
  private sampleRate = 24000; // Kokoro outputs 24kHz audio

  constructor() {
    this.tokenizer = new BPETokenizer();
    this.voiceLoader = new VoiceLoader();
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
      // Config with model paths is required
      if (config) {
        this.config = config;
      } else {
        throw new Error('Kokoro config required for initialization');
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

    // Tokenize text first (needed to determine voice embedding offset)
    const tokens = this.tokenizer.encode(text);

    // Get voice embedding
    const voiceId = options?.voiceId || this.defaultVoiceId;
    let voiceEmbedding: Float32Array;

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

    const results = await this.session.run(feeds);

    // Debug: Log available output names
    console.log('[KokoroEngine] Model outputs:', Object.keys(results));

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

    // Play audio using neural audio player
    // This maintains the unified API - speak() works the same for all engines
    await neuralAudioPlayer.play(audioBuffer, {
      ducking: options?.ducking,
      silentMode: options?.silentMode,
    });

    // Return void to match OS engine behavior (plays directly, doesn't return buffer)
    return undefined;
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
   * Stop current playback
   */
  async stop(): Promise<void> {
    await neuralAudioPlayer.stop();
  }

  /**
   * Destroy engine and free resources
   */
  async destroy(): Promise<void> {
    if (this.session) {
      // Note: onnxruntime-react-native doesn't have explicit dispose
      this.session = null;
    }

    this.isInitialized = false;
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
   * Load ONNX model
   */
  private async loadModel(modelPath: string): Promise<void> {
    try {
      this.session = await InferenceSession.create(modelPath);
    } catch (error) {
      throw new Error(
        `Failed to load ONNX model: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
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
}
