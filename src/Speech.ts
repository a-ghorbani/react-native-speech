/**
 * React Native Speech - Multi-Engine TTS Library
 *
 * Unified API that supports multiple TTS engines:
 * - OS Native (iOS AVSpeechSynthesizer, Android TextToSpeech)
 * - Kokoro (Neural TTS - high quality, multi-language)
 * - Supertonic (Neural TTS - ultra-fast, lightweight)
 *
 * @example
 * // Initialize with Kokoro
 * await Speech.initialize({
 *   engine: TTSEngine.KOKORO,
 *   modelPath: 'file://...',
 *   voicesPath: 'file://...',
 * });
 *
 * // Speak with any engine
 * await Speech.speak('Hello world', 'af_bella', { speed: 1.0 });
 */

import TurboSpeech from './NativeSpeech';
import type {VoiceProps, VoiceOptions, EngineProps} from './NativeSpeech';
import type {
  TTSEngine,
  KokoroConfig,
  KokoroVoice,
  SupertonicConfig,
  SupertonicVoice,
  SynthesisOptions,
} from './types';
import {engineManager} from './engines/EngineManager';
import {OSEngine} from './engines/OSEngine';
import {KokoroEngine} from './engines/kokoro';
import {SupertonicEngine} from './engines/supertonic';

// Initialize OS engine
const osEngine = new OSEngine();
engineManager.registerEngine(osEngine);

// Neural engines will be lazy-loaded
let kokoroEngine: KokoroEngine | null = null;
let supertonicEngine: SupertonicEngine | null = null;

export default class Speech {
  /**
   * The maximum number of characters allowed in a single call to the speak methods.
   */
  static readonly maxInputLength =
    TurboSpeech.getConstants().maxInputLength ?? Number.MAX_VALUE;

  // Track current engine
  private static currentEngine: TTSEngine = 'os-native' as TTSEngine;

  /**
   * Initialize Speech with a specific engine
   * @param config - Configuration object with engine and engine-specific settings
   * @example
   * // Initialize with Kokoro
   * await Speech.initialize({
   *   engine: 'kokoro',
   *   modelPath: '...',
   *   voicesPath: '...',
   *   // ... other Kokoro config
   * });
   *
   * // Initialize with OS native (default)
   * await Speech.initialize({
   *   engine: 'os-native'
   * });
   */
  public static async initialize(config: {
    engine: TTSEngine;
    [key: string]: any;
  }): Promise<void> {
    const {engine, ...engineConfig} = config;

    console.log(`[Speech.initialize] Initializing engine: ${engine}`);
    // Store current engine
    Speech.currentEngine = engine;
    console.log(
      `[Speech.initialize] currentEngine set to: ${Speech.currentEngine}`,
    );

    // Initialize the specific engine
    if (engine === 'kokoro') {
      if (!kokoroEngine) {
        kokoroEngine = new KokoroEngine();
        engineManager.registerEngine(kokoroEngine);
      }
      await engineManager.initializeEngine(
        engine,
        engineConfig as KokoroConfig,
      );
      engineManager.setDefaultEngine(engine);
    } else if (engine === 'supertonic') {
      if (!supertonicEngine) {
        supertonicEngine = new SupertonicEngine();
        engineManager.registerEngine(supertonicEngine);
      }
      await engineManager.initializeEngine(
        engine,
        engineConfig as SupertonicConfig,
      );
      engineManager.setDefaultEngine(engine);
    } else if (engine === 'os-native') {
      // OS engine is already initialized
      await engineManager.initializeEngine(engine);
      engineManager.setDefaultEngine(engine);
    } else {
      throw new Error(`Unknown engine: ${engine}`);
    }
  }

  /**
   * Speak text using the currently initialized engine
   * @param text - Text to synthesize
   * @param voiceId - Voice identifier (engine-specific)
   * @param options - Synthesis options
   * @example
   * await Speech.speak('Hello world', 'af_bella', { speed: 1.0 });
   */
  public static async speak(
    text: string,
    voiceId?: string,
    options?: SynthesisOptions,
  ): Promise<void> {
    const engine = Speech.currentEngine;

    if (!engineManager.isEngineInitialized(engine)) {
      throw new Error(
        `Engine '${engine}' not initialized. Call Speech.initialize() first.`,
      );
    }

    const engineInstance = engineManager.getEngine(engine);
    await engineInstance.synthesize(text, {
      voiceId,
      ...options,
    });
  }

  /**
   * Get available voices for the current engine
   * @param language - Optional language filter
   * @returns Array of voice identifiers
   */
  public static async getVoices(language?: string): Promise<string[]> {
    const engine = Speech.currentEngine;

    if (!engineManager.isEngineInitialized(engine)) {
      throw new Error(
        `Engine '${engine}' not initialized. Call Speech.initialize() first.`,
      );
    }

    const engineInstance = engineManager.getEngine(engine);
    return engineInstance.getAvailableVoices(language);
  }

  /**
   * Get detailed voice information (Neural engines only)
   * @param language - Optional language filter
   * @returns Array of voice objects with metadata
   */
  public static async getVoicesWithMetadata(
    language?: string,
  ): Promise<KokoroVoice[] | SupertonicVoice[]> {
    const engine = Speech.currentEngine;
    console.log(
      `[Speech.getVoicesWithMetadata] currentEngine: ${engine}, kokoroEngine: ${!!kokoroEngine}, supertonicEngine: ${!!supertonicEngine}`,
    );

    if (engine === 'kokoro') {
      if (!kokoroEngine) {
        throw new Error('Kokoro engine not initialized');
      }
      return kokoroEngine.getVoicesWithMetadata(language);
    } else if (engine === 'supertonic') {
      if (!supertonicEngine) {
        throw new Error('Supertonic engine not initialized');
      }
      return supertonicEngine.getVoicesWithMetadata(language);
    } else {
      throw new Error(
        'getVoicesWithMetadata() is only available for neural engines (Kokoro, Supertonic)',
      );
    }
  }

  /**
   * Check if the current engine is ready
   */
  public static async isReady(): Promise<boolean> {
    const engine = Speech.currentEngine;

    if (!engineManager.hasEngine(engine)) {
      return false;
    }

    const status = await engineManager.getEngineStatus(engine);
    return status.isReady;
  }

  /**
   * Get the current engine name
   */
  public static getCurrentEngine(): TTSEngine {
    return Speech.currentEngine;
  }

  /**
   * Get list of available engines
   */
  public static getAvailableEngines(): TTSEngine[] {
    return engineManager.getAvailableEngines();
  }

  // ============================================================
  // OS NATIVE TTS HELPERS (for backward compatibility)
  // ============================================================

  /**
   * Gets a list of all available OS voices on the device
   * Only works when using OS native engine
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
   * Speaks text with custom options (OS TTS)
   */
  public static speakWithOptions(
    text: string,
    options: VoiceOptions,
  ): Promise<void> {
    return TurboSpeech.speakWithOptions(text, options);
  }

  // Event listeners - unified for all engines (OS TTS and neural audio use the same events)
  public static onError = TurboSpeech.onError;
  public static onStart = TurboSpeech.onStart;
  public static onFinish = TurboSpeech.onFinish;
  public static onPause = TurboSpeech.onPause;
  public static onResume = TurboSpeech.onResume;
  public static onStopped = TurboSpeech.onStopped;
  public static onProgress = TurboSpeech.onProgress;
}

// Re-export types
export type {TTSEngine, KokoroVoice, KokoroConfig, SynthesisOptions};
