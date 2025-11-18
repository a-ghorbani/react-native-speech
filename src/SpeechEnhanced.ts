/**
 * Enhanced Speech API with Multi-Engine Support
 *
 * This is the new v2.0 API that supports multiple TTS engines
 * while maintaining backward compatibility with v1.x
 */

import TurboSpeech from './NativeSpeech';
import type {VoiceProps, VoiceOptions, EngineProps} from './NativeSpeech';
import type {
  TTSEngine,
  KokoroConfig,
  KokoroVoice,
  SynthesisOptions,
} from './types';
import {engineManager} from './engines/EngineManager';
import {OSEngine} from './engines/OSEngine';
import {KokoroEngine} from './engines/kokoro';

// Initialize engines
const osEngine = new OSEngine();
engineManager.registerEngine(osEngine);

// Kokoro engine will be lazy-loaded
let kokoroEngine: KokoroEngine | null = null;

export default class Speech {
  /**
   * The maximum number of characters allowed in a single call to the speak methods.
   */
  static readonly maxInputLength =
    TurboSpeech.getConstants().maxInputLength ?? Number.MAX_VALUE;

  // ============================================================
  // BACKWARD COMPATIBLE API (v1.x)
  // ============================================================

  /**
   * Gets a list of all available OS voices on the device
   * @deprecated Use getAvailableVoices with engine parameter for v2.0
   */
  public static getAvailableVoices(language?: string): Promise<VoiceProps[]> {
    return TurboSpeech.getAvailableVoices(language ?? '');
  }

  /**
   * Gets a list of all available text-to-speech engines on the device
   * @platform Android
   */
  public static getEngines(): Promise<EngineProps[]> {
    return TurboSpeech.getEngines();
  }

  /**
   * Sets the Android text-to-speech engine
   * @platform Android
   * @deprecated This sets Android OS TTS engine, not our multi-engine system
   */
  public static setEngine(engineName: string): Promise<void> {
    return TurboSpeech.setEngine(engineName);
  }

  /**
   * Opens the system UI to install or update TTS voice data
   * @platform Android
   */
  public static openVoiceDataInstaller(): Promise<void> {
    return TurboSpeech.openVoiceDataInstaller();
  }

  /**
   * Sets the global options for all subsequent speak() calls (OS TTS only)
   */
  public static initialize(options: VoiceOptions): void {
    TurboSpeech.initialize(options);
  }

  /**
   * Resets all speech options to their default values (OS TTS only)
   */
  public static reset(): void {
    TurboSpeech.reset();
  }

  /**
   * Immediately stops any ongoing synthesis
   */
  public static stop(): Promise<void> {
    return TurboSpeech.stop();
  }

  /**
   * Pauses the current speech
   */
  public static pause(): Promise<boolean> {
    return TurboSpeech.pause();
  }

  /**
   * Resumes previously paused speech
   */
  public static resume(): Promise<boolean> {
    return TurboSpeech.resume();
  }

  /**
   * Checks if speech is currently being synthesized
   */
  public static isSpeaking(): Promise<boolean> {
    return TurboSpeech.isSpeaking();
  }

  /**
   * Speaks text using OS TTS (default engine)
   */
  public static speak(text: string): Promise<void> {
    return TurboSpeech.speak(text);
  }

  /**
   * Speaks text with custom options (OS TTS)
   */
  public static speakWithOptions(
    text: string,
    options: VoiceOptions,
  ): Promise<void> {
    return TurboSpeech.speakWithOptions(text, options);
  }

  // Event listeners (OS TTS)
  public static onError = TurboSpeech.onError;
  public static onStart = TurboSpeech.onStart;
  public static onFinish = TurboSpeech.onFinish;
  public static onPause = TurboSpeech.onPause;
  public static onResume = TurboSpeech.onResume;
  public static onStopped = TurboSpeech.onStopped;
  public static onProgress = TurboSpeech.onProgress;

  // ============================================================
  // NEW MULTI-ENGINE API (v2.0)
  // ============================================================

  /**
   * Set the default TTS engine
   * @param engine - Engine to use as default
   * @example
   * Speech.setDefaultEngine('kokoro');
   */
  public static setDefaultEngine(engine: TTSEngine): void {
    engineManager.setDefaultEngine(engine);
  }

  /**
   * Get the current default engine
   */
  public static getDefaultEngine(): TTSEngine {
    return engineManager.getDefaultEngine();
  }

  /**
   * Get list of available engines
   */
  public static getAvailableEnginesV2(): TTSEngine[] {
    return engineManager.getAvailableEngines();
  }

  /**
   * Check if an engine is ready to use
   */
  public static async isEngineReady(engine: TTSEngine): Promise<boolean> {
    const status = await engineManager.getEngineStatus(engine);
    return status.isReady;
  }

  /**
   * Speak text with a specific engine
   * @param text - Text to synthesize
   * @param engine - Engine to use
   * @param options - Synthesis options
   */
  public static async speakWithEngine(
    text: string,
    engine: TTSEngine,
    options?: SynthesisOptions,
  ): Promise<void> {
    // Ensure engine is initialized
    if (!engineManager.isEngineInitialized(engine)) {
      if (engine === 'kokoro') {
        throw new Error(
          'Kokoro engine not initialized. Call Speech.kokoro.initialize() first.',
        );
      }
      await engineManager.initializeEngine(engine);
    }

    const engineInstance = engineManager.getEngine(engine);
    await engineInstance.synthesize(text, options);
  }

  // ============================================================
  // KOKORO-SPECIFIC API
  // ============================================================

  /**
   * Kokoro TTS specific methods
   */
  public static kokoro = {
    /**
     * Initialize Kokoro engine with model files
     */
    async initialize(config: KokoroConfig): Promise<void> {
      if (!kokoroEngine) {
        kokoroEngine = new KokoroEngine();
        engineManager.registerEngine(kokoroEngine);
      }

      await kokoroEngine.initialize(config);
    },

    /**
     * Check if Kokoro is ready
     */
    async isReady(): Promise<boolean> {
      if (!kokoroEngine) {
        return false;
      }
      return await kokoroEngine.isReady();
    },

    /**
     * Get available Kokoro voices
     */
    async getVoices(language?: string): Promise<KokoroVoice[]> {
      if (!kokoroEngine) {
        throw new Error('Kokoro engine not initialized');
      }
      return kokoroEngine.getVoicesWithMetadata(language);
    },

    /**
     * Speak text using Kokoro
     */
    async speak(
      text: string,
      voiceId: string,
      options?: {
        speed?: number;
        volume?: number;
        voiceBlend?: {voices: string[]; weights: number[]};
      },
    ): Promise<void> {
      if (!kokoroEngine) {
        throw new Error('Kokoro engine not initialized');
      }

      await kokoroEngine.synthesize(text, {
        voiceId,
        ...options,
      });
    },

    /**
     * Get Kokoro engine status
     */
    getStatus() {
      if (!kokoroEngine) {
        return {
          isReady: false,
          isLoading: false,
          error: 'Engine not created',
        };
      }
      return kokoroEngine.getStatus();
    },
  };
}

// Re-export types
export type {TTSEngine, KokoroVoice, KokoroConfig, SynthesisOptions};
