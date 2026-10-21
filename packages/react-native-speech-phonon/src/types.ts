/**
 * Phonon TTS specific types
 *
 * Phonon (Gradium xn-ptts) is a native, on-device neural TTS engine.
 * Unlike the ONNX engines it runs entirely in native code:
 * - Android: CPU (`libptts_ffi.so`, needs arm64 dotprod or x86_64)
 * - iOS: Core ML (iOS 18+)
 *
 * Installing this package is the opt-in. If its native module is not
 * linked into the app build, the engine reports `not-compiled` and cannot
 * be initialized.
 */

import type {SynthesisOptions} from '@pocketpalai/react-native-speech';

export type PhononLanguage = 'en' | 'fr' | 'de' | 'es' | 'pt' | 'none';

/** Compute unit for the flow LM. iOS only; Android always runs on CPU. */
export type PhononComputeUnit = 'neuralEngine' | 'cpu';

/** Why Phonon is (not) available on this build and device. */
export type PhononSupportReason =
  | 'ok'
  | 'not-compiled'
  | 'unsupported-abi'
  | 'translated-abi'
  | 'missing-cpu-features'
  | 'library-missing'
  | 'symbols-missing'
  | 'load-failed'
  | 'os-too-old'
  | 'low-memory'
  | 'forced'
  | 'error';

export interface PhononConfig {
  /**
   * Android: checkpoint folder (config.json, tokenizer.json, model gguf,
   * voices). iOS: the INNER bundle folder that holds bundle.json
   * (e.g. `.../phonon-31m-en-coreml/`); must be writable and excluded
   * from backup.
   */
  modelPath: string;
  /** Default 'en' */
  language?: PhononLanguage;
  /** Default: upstream's default voice */
  defaultVoice?: string;
  /** Android only; 0/undefined = native thread policy */
  numThreads?: number;
  /** Android only; sets XN_SPIN_BUDGET */
  spinBudget?: number;
  /** iOS only; default 'neuralEngine' */
  computeUnit?: PhononComputeUnit;
  /** Maximum chunk size in characters for text splitting (default: 250) */
  maxChunkSize?: number;
  /** Path to a voices.jsonl subset, used for display names */
  voicesMetadataPath?: string;
}

export interface PhononVoice {
  /** Voice identifier as reported by the native model */
  id: string;
  /** Human-readable name */
  name: string;
  /** Language code (e.g., 'en') */
  language?: string;
  /** Locale (e.g., 'en-US') */
  locale?: string;
  gender?: string;
  description?: string;
}

export type PhononSynthesisOptions = SynthesisOptions;

// Native result shapes (TurboModule spec), re-exported for consumers.
export type {
  PhononSupportInfo,
  PhononLoadOptions,
  PhononLoadResult,
  PhononSynthResult,
  PhononPlayConfig,
  PhononDiagnostics,
} from './NativeSpeechPhonon';
