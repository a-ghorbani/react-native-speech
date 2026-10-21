import {TurboModuleRegistry, type TurboModule} from 'react-native';

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
  /** XN_SPIN_BUDGET (Android only; 0 = upstream default). iOS ignores it */
  spinBudget?: number;
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

/** Playback settings for `playBuffer`; played on the core neural player. */
export interface PhononPlayConfig {
  sampleRate: number;
  channels: number;
  ducking?: boolean;
  /** iOS only, as in the core player config */
  silentMode?: 'obey' | 'respect' | 'ignore';
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

// Access only through NativePhonon.ts; PCM stays native, JS passes ids.
export interface Spec extends TurboModule {
  /** Cheap capability probe; never loads the Phonon library. */
  getSupport: () => Promise<PhononSupportInfo>;
  /** iOS: true if any .mlpackage in modelDir lacks a compiled .mlmodelc. */
  needsCompile: (modelDir: string) => Promise<boolean>;
  /** Load a model; replaces any live handle. */
  create: (
    modelDir: string,
    options: PhononLoadOptions,
  ) => Promise<PhononLoadResult>;
  /** Synchronous. Process-wide, monotonic, never reset (survives reloads). */
  allocRequestId: () => number;
  /** voice '' keeps upstream's default voice. */
  synthesize: (
    handleId: number,
    requestId: number,
    text: string,
    voice: string,
    language: string,
  ) => Promise<PhononSynthResult>;
  /** Synchronous. Cancels every request id <= upToRequestId. */
  cancel: (upToRequestId: number) => boolean;
  /** Synchronous. Cancels every id issued so far; later ids are unaffected. */
  cancelAll: () => boolean;
  /** Plays and consumes the buffer on the core neural player. */
  playBuffer: (bufferId: number, config: PhononPlayConfig) => Promise<void>;
  /** Base64 little-endian float32 copy; does not consume the buffer. */
  copyBuffer: (bufferId: number) => Promise<string>;
  /** Synchronous and idempotent. */
  releaseBuffer: (bufferId: number) => boolean;
  /** Enqueued on the synth thread; never blocks the caller. */
  destroy: (handleId: number) => Promise<void>;
  getDiagnostics: () => Promise<PhononDiagnostics>;
  /** Clears the persisted capability record and cached probe; true if none is left. */
  resetSupport: () => Promise<boolean>;
}

/** null when the add-on's native module is not linked into this build. */
export default TurboModuleRegistry.get<Spec>('RNSpeechPhonon');
