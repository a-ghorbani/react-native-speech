/**
 * Supertonic TTS Engine
 *
 * Ultra-fast neural TTS engine using ONNX Runtime for inference
 * - 167× faster than real-time on M4 Pro
 * - 66M parameters (lightweight)
 * - Built-in text normalization
 */

import type {
  TTSEngine,
  TTSEngineInterface,
  AudioBuffer,
  SupertonicConfig,
  SupertonicSynthesisOptions,
  SupertonicVoice,
} from '../../types';
import {VoicePresetLoader} from './VoicePresetLoader';

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
        'onnxruntime-react-native is required to use the Supertonic engine.\n\n' +
          'Install it with:\n' +
          '  npm install onnxruntime-react-native\n' +
          '  # or\n' +
          '  yarn add onnxruntime-react-native\n\n' +
          'Then rebuild your app:\n' +
          '  iOS: cd ios && pod install && cd ..\n' +
          '  Android: Rebuild the app\n\n' +
          'See https://github.com/a-ghorbani/react-native-speech/blob/main/docs/SUPERTONIC_GUIDE.md for details.',
      );
    }
  }
}

export class SupertonicEngine implements TTSEngineInterface {
  readonly name: TTSEngine = 'supertonic' as TTSEngine;

  private session: any = null; // InferenceSession type
  private voiceLoader: VoicePresetLoader;

  private config: SupertonicConfig | null = null;
  private isInitialized = false;
  private isLoading = false;
  private initError: string | null = null;

  private defaultVoiceId = 'preset_1'; // Default voice
  private sampleRate = 24000; // Supertonic outputs 24kHz audio
  private defaultInferenceSteps = 2; // 2-step for speed by default

  constructor() {
    this.voiceLoader = new VoicePresetLoader();
  }

  /**
   * Initialize the Supertonic engine with model files
   */
  async initialize(config?: SupertonicConfig): Promise<void> {
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
        if (config.defaultInferenceSteps) {
          this.defaultInferenceSteps = config.defaultInferenceSteps;
        }
      } else {
        throw new Error('Supertonic config required for initialization');
      }

      // Load voice presets
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
      this.isInitialized && this.session !== null && this.voiceLoader.isReady()
    );
  }

  /**
   * Synthesize text to audio
   */
  async synthesize(
    text: string,
    options?: SupertonicSynthesisOptions,
  ): Promise<AudioBuffer> {
    if (!this.isInitialized || !this.session) {
      throw new Error('Supertonic engine not initialized');
    }

    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    // Get voice preset
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const voicePreset = this.voiceLoader.getVoicePreset(voiceId);

    // Get inference steps
    const inferenceSteps =
      options?.inferenceSteps || this.defaultInferenceSteps;

    // Get speed parameter
    const speed = options?.speed ?? 1.0;

    // Create input tensors
    // Note: Actual tensor structure depends on Supertonic model's input requirements
    // This is a placeholder - needs to be updated based on actual model spec
    const textTensor = new Tensor('string', [text], [1]);
    const voiceTensor = new Tensor('float32', voicePreset, [
      1,
      voicePreset.length,
    ]);
    const speedTensor = new Tensor('float32', new Float32Array([speed]), [1]);
    const stepsTensor = new Tensor(
      'int64',
      new BigInt64Array([BigInt(inferenceSteps)]),
      [1],
    );

    // Run inference
    const feeds = {
      text: textTensor,
      voice: voiceTensor,
      speed: speedTensor,
      steps: stepsTensor,
    };

    const results = await this.session.run(feeds);

    // Extract audio output
    const audioTensor = results.audio;
    if (!audioTensor) {
      throw new Error('No audio output from model');
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

    return audioBuffer;
  }

  /**
   * Get available voices
   */
  async getAvailableVoices(language?: string): Promise<string[]> {
    if (!this.isInitialized) {
      throw new Error('Supertonic engine not initialized');
    }

    return this.voiceLoader.getVoiceIds(language);
  }

  /**
   * Get voices with metadata
   */
  getVoicesWithMetadata(language?: string): SupertonicVoice[] {
    if (!this.isInitialized) {
      throw new Error('Supertonic engine not initialized');
    }

    return this.voiceLoader.getVoices(language);
  }

  /**
   * Stop any ongoing synthesis
   */
  async stop(): Promise<void> {
    // Supertonic is so fast that stopping mid-synthesis is rarely needed
    // But we implement it for interface compliance
  }

  /**
   * Clean up resources
   */
  async destroy(): Promise<void> {
    if (this.session) {
      await this.session.release();
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

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

  /**
   * Load ONNX model
   */
  private async loadModel(modelPath: string): Promise<void> {
    try {
      this.session = await InferenceSession.create(modelPath);
    } catch (error) {
      throw new Error(
        `Failed to load Supertonic model: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Load voice presets
   */
  private async loadVoices(voicesPath: string): Promise<void> {
    try {
      await this.voiceLoader.loadVoices(voicesPath);
    } catch (error) {
      throw new Error(
        `Failed to load voice presets: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
