/**
 * React Native Speech - Multi-Engine TTS Library
 *
 * Unified API that supports multiple TTS engines:
 * - OS Native (iOS AVSpeechSynthesizer, Android TextToSpeech)
 * - Kokoro (Neural TTS - high quality, multi-language)
 * - Supertonic (Neural TTS - ultra-fast, lightweight)
 * - Kitten (Neural TTS - lightweight StyleTTS 2, English)
 * - Engine add-ons registered with `Speech.registerEngine`
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
  EngineId,
  EngineStreamHandle,
  EngineSupport,
  TTSEngineInterface,
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
  SpeechInput,
  PhonemeInput,
  SpeechStream as ISpeechStream,
  SpeechStreamOptions,
  StreamProgressEvent,
} from './types';
import {engineManager} from './engines/EngineManager';
import {OSEngine} from './engines/OSEngine';
import {KokoroEngine} from './engines/kokoro';
import {SupertonicEngine} from './engines/supertonic';
import {KittenEngine} from './engines/kitten';
import {neuralAudioPlayer} from './engines/NeuralAudioPlayer';
import {SpeechStreamImpl} from './engines/SpeechStream';
import {createComponentLogger} from './utils/logger';

const log = createComponentLogger('Speech', 'Api');

type AnyEngine = TTSEngineInterface<any>;

engineManager.registerEngine(new OSEngine());

// Built-in neural engines are constructed on their first initialize().
const builtinFactories: Record<string, () => AnyEngine> = {
  [TTSEngine.KOKORO]: () => new KokoroEngine(),
  [TTSEngine.SUPERTONIC]: () => new SupertonicEngine(),
  [TTSEngine.KITTEN]: () => new KittenEngine(),
};
const builtinDisplayNames: Record<string, string> = {
  [TTSEngine.KOKORO]: 'Kokoro',
  [TTSEngine.SUPERTONIC]: 'Supertonic',
  [TTSEngine.KITTEN]: 'Kitten',
};
const builtinIds = new Set<string>(Object.values(TTSEngine));

// Instances Speech has initialized before: a later initialize() goes
// through reinitializeEngine so new config (e.g. execution providers) applies.
const initializeAttempted = new WeakSet<AnyEngine>();

function registeredEngine(id: EngineId): AnyEngine | undefined {
  return engineManager.hasEngine(id) ? engineManager.getEngine(id) : undefined;
}

function neuralEngine(id: EngineId): AnyEngine | undefined {
  return id === TTSEngine.OS_NATIVE ? undefined : registeredEngine(id);
}

function resolveEngine(id: EngineId): AnyEngine | undefined {
  const existing = registeredEngine(id);
  if (existing) {
    return existing;
  }
  const factory = builtinFactories[id];
  if (!factory) {
    return undefined;
  }
  const created = factory();
  engineManager.registerEngine(created);
  return created;
}

// Engines get `dispatchChunkProgress` at init; it fans out to the
// `setChunkProgressCallback` slot and every `onChunkProgress` subscription.
// Subscriptions are wrapped so one callback can be added twice and removed
// independently.
let chunkProgressCallback: ChunkProgressCallback | null = null;
const chunkProgressSubscriptions = new Set<{
  callback: ChunkProgressCallback;
}>();

function dispatchChunkProgress(event: ChunkProgressEvent): void {
  chunkProgressCallback?.(event);
  for (const sub of [...chunkProgressSubscriptions]) {
    try {
      sub.callback(event);
    } catch (err) {
      log.warn('chunk progress listener threw:', err);
    }
  }
}

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
  | ({engine: TTSEngine.KITTEN} & KittenConfig & SpeechInitAudioDefaults)
  | CustomEngineInitConfig;

/**
 * Init configs of engine add-ons, keyed by engine id. Add-ons extend it
 * by declaration merging, which adds `{engine: id, ...config}` to
 * `SpeechInitConfig`:
 *
 * @example
 * declare module '@pocketpalai/react-native-speech' {
 *   interface CustomEngineConfigs {
 *     'my-engine': MyEngineConfig;
 *   }
 * }
 */
export interface CustomEngineConfigs {}

type CustomEngineInitConfig = {
  [K in keyof CustomEngineConfigs]: {engine: K} & CustomEngineConfigs[K] &
    SpeechInitAudioDefaults;
}[keyof CustomEngineConfigs];

export default class Speech {
  /**
   * The maximum number of characters allowed in a single call to the speak methods.
   */
  static readonly maxInputLength =
    TurboSpeech.getConstants().maxInputLength ?? Number.MAX_VALUE;

  // Track current engine
  private static currentEngine: EngineId = TTSEngine.OS_NATIVE;

  /**
   * Make an engine add-on available to `Speech.initialize({engine: id})`,
   * where `id` is `engine.name`. Registering the same instance again is a
   * no-op; a different instance may replace one that has never been
   * initialized (`release()` does not lift this).
   * @throws if `engine.name` is a built-in engine id, or another instance
   *   under that id has been initialized
   * @example
   * Speech.registerEngine(new MyEngine());
   * await Speech.initialize({engine: 'my-engine', modelPath: '...'});
   */
  public static registerEngine<TConfig>(
    engine: TTSEngineInterface<TConfig>,
  ): void {
    const id = engine.name;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Engine name must be a non-empty string');
    }
    if (builtinIds.has(id)) {
      throw new Error(`Engine id '${id}' is reserved for a built-in engine`);
    }
    const existing = registeredEngine(id);
    if (existing === engine) {
      return;
    }
    if (existing && engineManager.isEngineInitialized(id)) {
      throw new Error(`Engine '${id}' is already registered and initialized`);
    }
    engineManager.registerEngine(engine);
  }

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

    // `currentEngine` switches only after a successful init, so a failed
    // init keeps the previous engine usable.
    const instance = resolveEngine(engine);
    if (!instance) {
      throw new Error(`Unknown engine: ${engine}`);
    }
    const options = engine === TTSEngine.OS_NATIVE ? undefined : engineConfig;
    if (initializeAttempted.has(instance) && engine !== TTSEngine.OS_NATIVE) {
      await engineManager.reinitializeEngine(engine, options);
    } else {
      initializeAttempted.add(instance);
      await engineManager.initializeEngine(engine, options);
    }
    engineManager.setDefaultEngine(engine);
    instance.setChunkProgressCallback?.(dispatchChunkProgress);

    Speech.currentEngine = engine;
    log.debug(`currentEngine set to: ${Speech.currentEngine}`);
  }

  /**
   * Whether an engine can run on this build and device. Never throws and
   * never loads a model: built-in engines report `{supported: true,
   * reason: 'ok'}`, registered add-ons answer through their `getSupport()`,
   * and unregistered ids report `reason: 'unknown-engine'`.
   *
   * @example
   * const {supported, reason} = await Speech.getEngineSupport('my-engine');
   * if (!supported) console.log(`my-engine hidden: ${reason}`);
   */
  public static async getEngineSupport(
    engine: EngineId,
  ): Promise<EngineSupport> {
    try {
      const instance = registeredEngine(engine);
      if (instance?.getSupport) {
        const {supported, reason, detail} = await instance.getSupport();
        return detail === undefined
          ? {supported, reason}
          : {supported, reason, detail};
      }
      if (instance || builtinIds.has(engine)) {
        return {supported: true, reason: 'ok'};
      }
      return {
        supported: false,
        reason: 'unknown-engine',
        detail: String(engine),
      };
    } catch (e) {
      return {
        supported: false,
        reason: 'error',
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Forget an engine's persisted negative support result, so the next
   * `getEngineSupport` / `initialize` probes again. Resolves `true` for
   * engines that persist none, and `false` (never throws) if the record
   * could not be cleared.
   */
  public static async resetEngineSupport(engine: EngineId): Promise<boolean> {
    try {
      return (await registeredEngine(engine)?.resetSupport?.()) ?? true;
    } catch (e) {
      log.warn(`resetEngineSupport(${engine}) failed:`, e);
      return false;
    }
  }

  /**
   * Speak text — or pre-phonemized IPA — using the current engine.
   *
   * @param input - Either a text string (runs the full pipeline,
   *   including g2p) or `{ phonemes }` to feed IPA directly and
   *   short-circuit g2p. Phoneme input is supported only by the IPA
   *   neural engines (Kokoro, Kitten); the OS and Supertonic engines
   *   reject it with a clear error.
   * @param voiceId - Voice identifier (engine-specific)
   * @param options - Synthesis options
   * @example
   * // Text (unchanged behaviour — g2p runs)
   * await Speech.speak('Hello world', 'af_bella', { speed: 1.0 });
   *
   * // Pre-phonemized IPA — skips the engine's g2p
   * await Speech.speak({ phonemes: 'həˈloʊ wˈɜːld' }, 'af_bella');
   */
  public static async speak(
    input: SpeechInput,
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
    await engineInstance.synthesize(input, {
      voiceId,
      ...options,
    });
  }

  /**
   * Create a streaming input handle for incremental TTS.
   *
   * Feed text to the returned stream as it becomes available (e.g. from
   * an LLM token stream). The stream internally buffers and batches
   * text so that playback sounds like one continuous utterance — the
   * first sentence flushes as soon as it's complete (low latency) and
   * subsequent batches are packed up to `targetChars` characters.
   *
   * **Engine support**: designed for the neural engines (Kokoro,
   * Supertonic, Kitten), where each `speak()` resolves only after the
   * batch finishes playing so the stream can pack large batches while
   * earlier ones play. The OS engine's native `speak()` resolves on
   * dispatch, which makes the adaptive batching effectively a no-op —
   * the stream still works (the OS queues utterances natively) but
   * sounds roughly the same as per-sentence `speak()`.
   *
   * @param voiceId - Voice identifier for the active engine
   * @param options - Synthesis options + stream-specific tuning
   * @returns A handle with `append()`, `finalize()`, and `cancel()`
   *
   * @example
   * const stream = Speech.createSpeechStream('af_bella');
   * for await (const token of llmStream) {
   *   stream.append(token);
   * }
   * await stream.finalize();
   */
  public static createSpeechStream(
    voiceId?: string,
    options?: SpeechStreamOptions,
  ): ISpeechStream {
    // `SpeechStreamOptions` extends `SynthesisOptions`; engines ignore the
    // stream-only fields (`targetChars`, `onError`) since they only read
    // the properties they care about.
    const synthesisOptions: SynthesisOptions | undefined = options;

    // Detect whether the active engine supports streaming. Neural engines
    // expose synthesizeStream(), which eliminates cross-batch gaps by
    // keeping the pipelined synth+play loop alive for the stream's
    // lifetime. OS engine doesn't — fall back to the adaptive batcher.
    const instance = neuralEngine(Speech.currentEngine);
    let engineStreamFactory:
      | ((opts?: SpeechStreamOptions) => EngineStreamHandle)
      | undefined;

    const streamVoiceOpt = voiceId ? {voiceId} : {};
    if (instance?.synthesizeStream) {
      engineStreamFactory = opts =>
        instance.synthesizeStream!({...streamVoiceOpt, ...opts});
    }

    return new SpeechStreamImpl({
      synthesize: (text: string) =>
        Speech.speak(text, voiceId, synthesisOptions),
      stop: () => Speech.stop(),
      subscribeProgress: (cb: ChunkProgressCallback) =>
        Speech.onChunkProgress(cb),
      engineStreamFactory,
      options,
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
  public static async getVoicesWithMetadata<
    T = KokoroVoice[] | SupertonicVoice[] | KittenVoice[],
  >(language?: string): Promise<T> {
    const engine = Speech.currentEngine;
    const instance = neuralEngine(engine);
    log.debug(
      `getVoicesWithMetadata currentEngine: ${engine}, registered: ${!!instance}`,
    );

    if (engine !== TTSEngine.OS_NATIVE && !instance) {
      throw new Error(
        `${builtinDisplayNames[engine] ?? engine} engine not initialized`,
      );
    }
    if (!instance) {
      throw new Error(
        'getVoicesWithMetadata() is only available for neural engines (Kokoro, Supertonic, Kitten)',
      );
    }
    if (!instance.getVoicesWithMetadata) {
      throw new Error(
        `Engine '${engine}' does not provide getVoicesWithMetadata()`,
      );
    }
    return (await instance.getVoicesWithMetadata(language)) as T;
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
   * Get the current engine name (an add-on's id when one is current;
   * typed `TTSEngine` for backward compatibility)
   */
  public static getCurrentEngine(): TTSEngine {
    return Speech.currentEngine as TTSEngine;
  }

  /**
   * Get list of registered engines (add-on ids included; typed
   * `TTSEngine[]` for backward compatibility)
   */
  public static getAvailableEngines(): TTSEngine[] {
    return engineManager.getAvailableEngines() as TTSEngine[];
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
   *
   * Replaces any previous callback; does not affect `onChunkProgress`
   * listeners.
   */
  public static setChunkProgressCallback(
    callback: ChunkProgressCallback | null,
  ): void {
    chunkProgressCallback = callback;
  }

  /**
   * Add a chunk progress listener. Listeners stack with each other, with
   * `setChunkProgressCallback`, and with `SpeechStream.onProgress`. The
   * returned function removes only this one.
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
    const sub = {callback};
    chunkProgressSubscriptions.add(sub);
    return () => {
      chunkProgressSubscriptions.delete(sub);
    };
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
    neuralEngine(engine)?.stop();

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

    const instance = neuralEngine(engine);
    if (instance) {
      return instance.release();
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
    if (neuralEngine(Speech.currentEngine)) {
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
    if (neuralEngine(Speech.currentEngine)) {
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
  EngineId,
  EngineSupport,
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
  SpeechInput,
  PhonemeInput,
  ISpeechStream as SpeechStream,
  SpeechStreamOptions,
  StreamProgressEvent,
};
