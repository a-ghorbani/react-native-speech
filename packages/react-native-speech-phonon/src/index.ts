/**
 * Phonon engine add-on for @pocketpalai/react-native-speech.
 *
 * ```ts
 * import Speech from '@pocketpalai/react-native-speech';
 * import {PhononEngine, PHONON} from '@pocketpalai/react-native-speech-phonon';
 *
 * Speech.registerEngine(new PhononEngine());
 * await Speech.initialize({engine: PHONON, modelPath});
 * ```
 */

import type {PhononConfig} from './types';

declare module '@pocketpalai/react-native-speech' {
  interface CustomEngineConfigs {
    phonon: PhononConfig;
  }
}

export {
  PhononEngine,
  normalizePhononLanguage,
  type PhononChunkMetrics,
} from './PhononEngine';
export {PHONON, PHONON_CONSTANTS, PHONON_LANGUAGES} from './constants';
export {
  PhononError,
  PhononUnsupportedError,
  toPhononError,
  type PhononErrorCode,
} from './errors';
export {parseVoicesJsonl, buildVoices, type PhononCatalogEntry} from './voices';
export type {
  PhononVoice,
  PhononConfig,
  PhononSynthesisOptions,
  PhononLanguage,
  PhononComputeUnit,
  PhononSupportReason,
  PhononSupportInfo,
  PhononLoadOptions,
  PhononLoadResult,
  PhononSynthResult,
  PhononPlayConfig,
  PhononDiagnostics,
} from './types';
