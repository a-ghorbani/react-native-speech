import {TurboModuleRegistry, type TurboModule} from 'react-native';
import type {EventEmitter} from 'react-native/Libraries/Types/CodegenTypesNamespace';

export type VoiceQuality = 'Default' | 'Enhanced';

export interface EventProps {
  /**
   * The utterance ID
   */
  id: number;
}
export interface ProgressEventProps extends EventProps {
  /**
   * The text being spoken length
   */
  length: number;
  /**
   * The current position in the spoken text
   */
  location: number;
}
export interface VoiceProps {
  /** The name of the voice */
  name: string;
  /** The quality level of the voice */
  quality: VoiceQuality;
  /** The language code of the voice (e.g., 'en-US', 'fr-FR') */
  language: string;
  /** The unique identifier for the voice */
  identifier: string;
}
export interface VoiceOptions {
  /**
   * If `true`, audio from other apps will be temporarily lowered (ducked) while speech is active.
   * This is for critical announcements (e.g., navigation) and takes priority over `silentMode` on iOS.
   * @default false
   */
  ducking?: boolean;
  /**
   * Determines how speech audio interacts with the device's silent (ringer) switch.
   * This option is ignored if `ducking` is `true`.
   * @platform iOS
   *
   * - `obey`: (Default) Speech plays through the device's silent switch using the Playback audio category. Use `respect` to honor the ringer switch.
   * - `respect`: Speech will be silenced by the ringer switch. Use for non-critical audio.
   * - `ignore`: Speech will play even if the ringer is off. Use for critical audio when ducking is not desired.
   */
  silentMode?: 'obey' | 'respect' | 'ignore';
  /** The language code to use (e.g., 'en', 'fr', 'en-US', 'fr-FR') */
  language?: string;
  /** Volume level from 0.0 to 1.0 */
  volume?: number;
  /** Specific voice identifier to use */
  voice?: string;
  /**
   * Pitch multiplier from 0.5 to 2.0
   * - `Android`: (0.1 - 2.0)
   * - `iOS`: (0.5 - 2.0)
   */
  pitch?: number;
  /**
   * Speech rate
   * - `Android`: (0.1 - 2.0)
   * - `iOS`: (`AVSpeechUtteranceMinimumSpeechRate` - `AVSpeechUtteranceMaximumSpeechRate`)
   */
  rate?: number;
}
export interface EngineProps {
  /**
   * The unique system identifier for the engine.
   * This is typically the package name (e.g., "com.google.android.tts")
   */
  name: string;
  /**
   * The human-readable display name for the engine (e.g., "Google Text-to-Speech Engine").
   */
  label: string;
  /**
   * A boolean flag indicating if this is the default engine
   */
  isDefault: boolean;
}

interface ConstantsProps {
  /**
   * The maximum number of characters allowed in a single call to `speak()` or `speakWithOptions()`.
   * @platform Android
   */
  maxInputLength?: number;
}

export interface AudioInterruptionProps {
  /**
   * The interruption phase.
   * - `began`: audio was paused due to an external interruption (incoming call, other media, audio focus loss).
   * - `ended`: the interruption has ended.
   */
  type: 'began' | 'ended';
  /**
   * On `ended`, indicates whether the system suggests the app should resume playback.
   * Always `true` on Android when focus is regained after a transient loss.
   * On iOS, mirrors `AVAudioSessionInterruptionOptionShouldResume`.
   */
  shouldResume?: boolean;
}

export interface AudioPlayerConfig {
  /**
   * Sample rate in Hz (e.g., 24000)
   */
  sampleRate: number;
  /**
   * Number of channels (1 = mono, 2 = stereo)
   */
  channels: number;
  /**
   * If `true`, audio from other apps will be temporarily lowered (ducked) while speech is active.
   * @default false
   */
  ducking?: boolean;
  /**
   * Determines how speech audio interacts with the device's silent (ringer) switch.
   * @platform iOS
   *
   * - `obey`: (Default) Speech plays through the device's silent switch using the Playback audio category. Use `respect` to honor the ringer switch.
   * - `respect`: Speech will be silenced by the ringer switch. Use for non-critical audio.
   * - `ignore`: Speech will play even if the ringer is off. Use for critical audio when ducking is not desired.
   */
  silentMode?: 'obey' | 'respect' | 'ignore';
}

/**
 * Result of the cheap Phonon capability probe. Never loads the Phonon
 * library itself.
 */
export interface PhononSupportInfo {
  supported: boolean;
  /**
   * 'ok' | 'not-compiled' | 'unsupported-abi' | 'translated-abi'
   * | 'missing-cpu-features' | 'library-missing' | 'symbols-missing'
   * | 'load-failed' | 'os-too-old' | 'low-memory' | 'forced' | 'error'
   */
  reason: string;
  detail: string;
  /** Android: shim compile-time ABI ('arm64-v8a' | 'x86_64'). iOS: 'ios-arm64', ... */
  abi: string;
  osVersion: string;
  /** e.g. '0.4.0-r1' from phonon.lock.json; '' if not compiled */
  libraryVersion: string;
  isSimulator: boolean;
  /** sysconf(_SC_PAGESIZE) on Android, 16384 on iOS */
  pageSize: number;
}

export interface PhononLoadOptions {
  /** 'en' | 'fr' | 'de' | 'es' | 'pt' | 'none' */
  language: string;
  /** 0 = native default policy (Android only) */
  numThreads: number;
  /** 'neuralEngine' | 'cpu' (iOS); Android always runs on CPU */
  computeUnit: string;
}

export interface PhononLoadResult {
  handleId: number;
  voices: string[];
  languages: string[];
  /** Voice upstream picks when none is set ('' = unconditioned) */
  defaultVoice: string;
  sampleRate: number;
  loadMs: number;
  /** iOS: true if this load had to compile Core ML. Android: always false */
  compiled: boolean;
  /** Effective RAYON_NUM_THREADS (Android); 0 on iOS */
  numThreads: number;
  /** Effective unit: 'cpu' on Android; 'neuralEngine' | 'cpu' on iOS */
  computeUnit: string;
}

export interface PhononSynthResult {
  requestId: number;
  /** 0 when cancelled or empty */
  bufferId: number;
  samples: number;
  sampleRate: number;
  /** Includes normalization, voice conditioning and prefill */
  ttfaMs: number;
  totalMs: number;
  /** Time spent waiting for the synth thread */
  queuedMs: number;
  /** Voice or language differed from the previous speak */
  voiceChanged: boolean;
  cancelled: boolean;
  /** Native monotonic clock, for [BENCH] timelines */
  startedAtMs: number;
  finishedAtMs: number;
}

export interface PhononPlayConfig extends AudioPlayerConfig {
  /** Gain applied natively during the float -> int16 conversion */
  volume?: number;
}

export interface PhononDiagnostics {
  /** Android: VmRSS. iOS: phys_footprint */
  memKb: number;
  /** Android: VmHWM. iOS: lifetime peak footprint */
  peakMemKb: number;
  threads: number;
  libraryLoaded: boolean;
  handleOpen: boolean;
  liveBuffers: number;
  orphanBuffers: number;
  /** 'idle' | 'loading' | 'compiling' | 'speaking' */
  busy: string;
  lastIssuedId: number;
  cancelWatermark: number;
}

export interface Spec extends TurboModule {
  getConstants: () => ConstantsProps;
  //Methods
  reset: () => void;
  stop: () => Promise<void>;
  pause: () => Promise<boolean>;
  resume: () => Promise<boolean>;
  isSpeaking: () => Promise<boolean>;
  speak: (text: string) => Promise<void>;
  getEngines: () => Promise<EngineProps[]>;
  initialize: (options: VoiceOptions) => void;
  openVoiceDataInstaller: () => Promise<void>;
  setEngine: (engineName: string) => Promise<void>;
  getAvailableVoices: (language?: string) => Promise<VoiceProps[]>;
  speakWithOptions: (text: string, options: VoiceOptions) => Promise<void>;

  // Neural Audio Player Methods
  /**
   * Play PCM audio data (for neural TTS engines)
   * @param audioData - Base64-encoded Int16 PCM audio data
   * @param config - Audio configuration
   */
  playAudio: (audioData: string, config: AudioPlayerConfig) => Promise<void>;
  /**
   * Stop neural audio playback
   */
  stopAudio: () => Promise<void>;
  /**
   * Pause neural audio playback
   */
  pauseAudio: () => Promise<boolean>;
  /**
   * Resume neural audio playback
   */
  resumeAudio: () => Promise<boolean>;
  /**
   * Check if neural audio is playing
   */
  isAudioPlaying: () => Promise<boolean>;

  /**
   * Open a phonemizer dict file (mmap'd native dict, EPD1 format).
   * Replaces any previously open dict. Returns true on success.
   */
  dictOpen: (path: string) => Promise<boolean>;
  /**
   * Look up a word in the currently-open dict.
   * Returns null on miss or if no dict open.
   * Synchronous: hot path, called many times per phonemize() call.
   */
  dictLookup: (word: string) => string | null;

  // Phonon engine methods. Present in every build; when the library is
  // built without Phonon (RNSpeech_phononEnabled / RN_SPEECH_PHONON off)
  // the native side is a stub: getSupport resolves `not-compiled` and the
  // work methods reject `PHONON_NOT_COMPILED`. Access only through
  // src/engines/phonon/NativePhonon.ts. PCM stays native; JS passes ids.
  /** Cheap capability probe; never loads the Phonon library. */
  phononGetSupport: () => Promise<PhononSupportInfo>;
  /** iOS: true if any .mlpackage in modelDir lacks a compiled .mlmodelc. */
  phononNeedsCompile: (modelDir: string) => Promise<boolean>;
  /** Load a model; replaces any live handle. */
  phononCreate: (
    modelDir: string,
    options: PhononLoadOptions,
  ) => Promise<PhononLoadResult>;
  /** Synchronous. Process-wide, monotonic, never reset (survives reloads). */
  phononAllocRequestId: () => number;
  /** voice '' keeps upstream's default voice. */
  phononSynthesize: (
    handleId: number,
    requestId: number,
    text: string,
    voice: string,
    language: string,
  ) => Promise<PhononSynthResult>;
  /** Synchronous. Cancels every request id <= upToRequestId. */
  phononCancel: (upToRequestId: number) => boolean;
  /** Synchronous. Cancels every id issued so far; later ids are unaffected. */
  phononCancelAll: () => boolean;
  /** Plays and consumes the buffer. */
  phononPlayBuffer: (
    bufferId: number,
    config: PhononPlayConfig,
  ) => Promise<void>;
  /** Base64 little-endian float32 copy; does not consume the buffer. */
  phononCopyBuffer: (bufferId: number) => Promise<string>;
  /** Synchronous and idempotent. */
  phononReleaseBuffer: (bufferId: number) => boolean;
  /** Enqueued on the synth thread; never blocks the caller. */
  phononDestroy: (handleId: number) => Promise<void>;
  phononGetDiagnostics: () => Promise<PhononDiagnostics>;

  //Listeners
  readonly onError: EventEmitter<EventProps>;
  readonly onStart: EventEmitter<EventProps>;
  readonly onFinish: EventEmitter<EventProps>;
  readonly onPause: EventEmitter<EventProps>;
  readonly onResume: EventEmitter<EventProps>;
  readonly onStopped: EventEmitter<EventProps>;
  readonly onProgress: EventEmitter<ProgressEventProps>;
  readonly onAudioInterruption: EventEmitter<AudioInterruptionProps>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RNSpeech');
