/**
 * React Native Speech - Multi-Engine TTS Library
 *
 * Unified API that supports multiple TTS engines:
 * - OS Native (iOS AVSpeechSynthesizer, Android TextToSpeech)
 * - Kokoro (Neural TTS - high quality, multi-language)
 * - Supertonic (Neural TTS - ultra-fast, lightweight)
 * - Kitten (Neural TTS - lightweight StyleTTS 2, English)
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
import {TTSEngine} from './types';
import type {
  KokoroConfig,
  KokoroVoice,
  SupertonicConfig,
  SupertonicVoice,
  KittenConfig,
  KittenVoice,
  SynthesisOptions,
  ChunkProgressEvent,
  ChunkProgressCallback,
  ReleaseResult,
} from './types';
import {engineManager} from './engines/EngineManager';
import {OSEngine} from './engines/OSEngine';
import {KokoroEngine} from './engines/kokoro';
import {SupertonicEngine} from './engines/supertonic';
import {KittenEngine} from './engines/kitten';
import {neuralAudioPlayer} from './engines/NeuralAudioPlayer';
import {createComponentLogger} from './utils/logger';

const log = createComponentLogger('Speech', 'Api');

// Initialize OS engine
const osEngine = new OSEngine();
engineManager.registerEngine(osEngine);

// Neural engines will be lazy-loaded
let kokoroEngine: KokoroEngine | null = null;
let supertonicEngine: SupertonicEngine | null = null;
let kittenEngine: KittenEngine | null = null;

// Store pending chunk progress callback (set before engine is initialized)
let pendingChunkProgressCallback: ChunkProgressCallback | null = null;

/**
 * Default synthesis-option fields that can also be provided at init time
 * (applied on the native side for audio-session configuration).
 * These mirror the subset of `SynthesisOptions` relevant at initialization.
 */
export interface SpeechInitAudioDefaults {
  /** iOS silent-switch behavior — see `SynthesisOptions.silentMode` */
  silentMode?: 'obey' | 'respect' | 'ignore';
  /** Duck other audio while speaking — see `SynthesisOptions.ducking` */
  ducking?: boolean;
}

/**
 * Discriminated union of engine init configs.
 * `engine` is the discriminant; the remaining fields are engine-specific.
 */
export type SpeechInitConfig =
  | ({engine: TTSEngine.OS_NATIVE} & SpeechInitAudioDefaults)
  | ({engine: TTSEngine.KOKORO} & KokoroConfig & SpeechInitAudioDefaults)
  | ({engine: TTSEngine.SUPERTONIC} & SupertonicConfig &
      SpeechInitAudioDefaults)
  | ({engine: TTSEngine.KITTEN} & KittenConfig & SpeechInitAudioDefaults);

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
  public static async initialize(config: SpeechInitConfig): Promise<void> {
    const {engine, ...engineConfig} = config;

    log.info(`Initializing engine: ${engine}`);
    // Store current engine
    Speech.currentEngine = engine;
    log.debug(`currentEngine set to: ${Speech.currentEngine}`);

    // Initialize the specific engine
    if (engine === 'kokoro') {
      if (!kokoroEngine) {
        kokoroEngine = new KokoroEngine();
        engineManager.registerEngine(kokoroEngine);
        // First time: use regular initialization
        await engineManager.initializeEngine(
          engine,
          engineConfig as KokoroConfig,
        );
      } else {
        // Already initialized: force re-initialization to apply new config
        // This is important when switching execution providers (gpu/ane/cpu)
        await engineManager.reinitializeEngine(
          engine,
          engineConfig as KokoroConfig,
        );
      }
      engineManager.setDefaultEngine(engine);

      // Apply pending chunk progress callback if one was set before initialization
      if (pendingChunkProgressCallback) {
        kokoroEngine.setChunkProgressCallback(pendingChunkProgressCallback);
      }
    } else if (engine === 'supertonic') {
      if (!supertonicEngine) {
        supertonicEngine = new SupertonicEngine();
        engineManager.registerEngine(supertonicEngine);
        // First time: use regular initialization
        await engineManager.initializeEngine(
          engine,
          engineConfig as SupertonicConfig,
        );
      } else {
        // Already initialized: force re-initialization to apply new config
        // This is important when switching execution providers (gpu/ane/cpu)
        await engineManager.reinitializeEngine(
          engine,
          engineConfig as SupertonicConfig,
        );
      }
      engineManager.setDefaultEngine(engine);

      // Apply pending chunk progress callback if one was set before initialization
      if (pendingChunkProgressCallback) {
        supertonicEngine.setChunkProgressCallback(pendingChunkProgressCallback);
      }
    } else if (engine === 'kitten') {
      if (!kittenEngine) {
        kittenEngine = new KittenEngine();
        engineManager.registerEngine(kittenEngine);
        await engineManager.initializeEngine(
          engine,
          engineConfig as KittenConfig,
        );
      } else {
        await engineManager.reinitializeEngine(
          engine,
          engineConfig as KittenConfig,
        );
      }
      engineManager.setDefaultEngine(engine);

      if (pendingChunkProgressCallback) {
        kittenEngine.setChunkProgressCallback(pendingChunkProgressCallback);
      }
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
  ): Promise<KokoroVoice[] | SupertonicVoice[] | KittenVoice[]> {
    const engine = Speech.currentEngine;
    log.debug(
      `getVoicesWithMetadata currentEngine: ${engine}, kokoroEngine: ${!!kokoroEngine}, supertonicEngine: ${!!supertonicEngine}, kittenEngine: ${!!kittenEngine}`,
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
    } else if (engine === 'kitten') {
      if (!kittenEngine) {
        throw new Error('Kitten engine not initialized');
      }
      return kittenEngine.getVoicesWithMetadata();
    } else {
      throw new Error(
        'getVoicesWithMetadata() is only available for neural engines (Kokoro, Supertonic, Kitten)',
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
  // CHUNK PROGRESS (Neural TTS only)
  // ============================================================

  /**
   * Set callback for chunk progress events (Neural TTS only)
   * This is called when each sentence/chunk starts being spoken
   *
   * @param callback - Function to call on chunk progress, or null to remove
   * @example
   * Speech.setChunkProgressCallback((event) => {
   *   console.log(`Speaking chunk ${event.chunkIndex + 1}/${event.totalChunks}`);
   *   console.log(`Current sentence: "${event.chunkText}"`);
   *   console.log(`Progress: ${event.progress}%`);
   *   // Highlight current text in UI
   *   highlightText(event.textRange.start, event.textRange.end);
   * });
   */
  public static setChunkProgressCallback(
    callback: ChunkProgressCallback | null,
  ): void {
    // Store the callback for later if engine not yet initialized
    pendingChunkProgressCallback = callback;

    // Apply immediately if engines are already initialized
    if (kokoroEngine) {
      kokoroEngine.setChunkProgressCallback(callback);
    }
    if (supertonicEngine) {
      supertonicEngine.setChunkProgressCallback(callback);
    }
    if (kittenEngine) {
      kittenEngine.setChunkProgressCallback(callback);
    }
  }

  /**
   * Convenience method to add a chunk progress listener
   * Returns an unsubscribe function
   *
   * @param callback - Function to call on chunk progress
   * @returns Function to unsubscribe the listener
   * @example
   * const unsubscribe = Speech.onChunkProgress((event) => {
   *   console.log(`Chunk ${event.chunkIndex + 1}/${event.totalChunks}: ${event.chunkText}`);
   * });
   *
   * // Later, to stop listening:
   * unsubscribe();
   */
  public static onChunkProgress(callback: ChunkProgressCallback): () => void {
    Speech.setChunkProgressCallback(callback);
    return () => Speech.setChunkProgressCallback(null);
  }

  // ============================================================
  // OS NATIVE TTS HELPERS (for backward compatibility)
  // ============================================================

  /**
   * Gets a list of all available OS voices on the device
   * Only works when using OS native engine
   */
  public static getAvailableVoices(language?: string): Promise<VoiceProps[]> {
    return TurboSpeech.getAvailableVoices(language);
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
   * Immediately stops any ongoing synthesis.
   * Sets the stop flag synchronously, then fires native stops concurrently.
   * Works for both OS native and neural TTS engines.
   */
  public static async stop(): Promise<void> {
    const engine = Speech.currentEngine;

    // Set stop flag synchronously — takes effect in synthesis loop immediately
    if (engine === 'kokoro' && kokoroEngine) {
      kokoroEngine.stop();
    } else if (engine === 'supertonic' && supertonicEngine) {
      supertonicEngine.stop();
    } else if (engine === 'kitten' && kittenEngine) {
      kittenEngine.stop();
    }

    // Fire native stops (OS TTS stop is always safe to call)
    await TurboSpeech.stop();
  }

  /**
   * Release the current neural engine's resources from memory.
   * The engine can be re-initialized later with initialize().
   * OS native engine does not need releasing.
   *
   * Use this when:
   * - App goes to background and won't use TTS
   * - Switching between engines and want to free previous engine's memory
   * - Memory pressure situations
   *
   * After release(), call initialize() before using speak().
   *
   * @returns ReleaseResult with success status and any errors
   *
   * @example
   * // Free memory when app goes to background
   * AppState.addEventListener('change', async (state) => {
   *   if (state === 'background') {
   *     await Speech.release();
   *   }
   * });
   *
   * // Later, when needed again
   * await Speech.initialize({ engine: 'kokoro', ... });
   */
  public static async release(): Promise<ReleaseResult> {
    const engine = Speech.currentEngine;

    log.info(`Releasing engine: ${engine}`);

    if (engine === 'kokoro' && kokoroEngine) {
      return kokoroEngine.release();
    } else if (engine === 'supertonic' && supertonicEngine) {
      return supertonicEngine.release();
    } else if (engine === 'kitten' && kittenEngine) {
      return kittenEngine.release();
    }

    // OS engine doesn't need releasing
    return {success: true, partialRelease: false, errors: []};
  }

  /**
   * Pauses the current speech.
   * For neural engines, pauses audio playback (synthesis loop waits naturally).
   * For OS native engine, pauses the system synthesizer.
   */
  public static async pause(): Promise<boolean> {
    const engine = Speech.currentEngine;

    if (
      (engine === 'kokoro' && kokoroEngine) ||
      (engine === 'supertonic' && supertonicEngine) ||
      (engine === 'kitten' && kittenEngine)
    ) {
      return neuralAudioPlayer.pause();
    }

    return TurboSpeech.pause();
  }

  /**
   * Resumes previously paused speech.
   * For neural engines, resumes audio playback.
   * For OS native engine, resumes the system synthesizer.
   */
  public static async resume(): Promise<boolean> {
    const engine = Speech.currentEngine;

    if (
      (engine === 'kokoro' && kokoroEngine) ||
      (engine === 'supertonic' && supertonicEngine) ||
      (engine === 'kitten' && kittenEngine)
    ) {
      return neuralAudioPlayer.resume();
    }

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
export type {
  TTSEngine,
  KokoroVoice,
  KokoroConfig,
  SupertonicVoice,
  SupertonicConfig,
  KittenVoice,
  KittenConfig,
  SynthesisOptions,
  ChunkProgressEvent,
  ChunkProgressCallback,
  ReleaseResult,
};
