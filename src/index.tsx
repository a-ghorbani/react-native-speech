/**
 * React Native Speech - Multi-Engine TTS Library
 *
 * Supports:
 * - OS Native TTS (iOS AVSpeechSynthesizer, Android TextToSpeech)
 * - Kokoro Neural TTS (high quality, multi-language)
 * - Supertonic Neural TTS (ultra-fast, lightweight)
 * - Kitten Neural TTS (lightweight StyleTTS 2, English)
 *
 * ## Default usage (recommended for ~95% of apps)
 *
 * ```ts
 * import Speech from '@pocketpalai/react-native-speech';
 *
 * await Speech.initialize({ engine: TTSEngine.OS_NATIVE });
 * await Speech.speak('Hello world');
 * ```
 *
 * The default `Speech` class wraps engine selection, lazy loading,
 * and lifecycle management. Most apps only ever need this entry.
 *
 * ## Advanced usage
 *
 * ```ts
 * import {engineManager, KokoroEngine} from '@pocketpalai/react-native-speech';
 * ```
 *
 * Per-engine classes (`KokoroEngine`, `SupertonicEngine`, `KittenEngine`,
 * `OSEngine`) and the `engineManager` singleton are exported for advanced
 * scenarios such as multi-engine orchestration, custom pipelines, or
 * integrating an engine without going through the unified `Speech` API.
 *
 * These exports are tagged `@internal` — they are part of the public
 * surface but their shape may change between minor releases. Pin the
 * library version if you depend on them.
 */

// Export Speech API as default
export {default} from './Speech';

// Export types from native API
export type {
  VoiceProps,
  EventProps,
  VoiceOptions,
  ProgressEventProps,
  EngineProps,
} from './NativeSpeech';

// Export TTSEngine enum (as value, not type)
export {TTSEngine} from './types';

// Export engine types
export type {
  TTSEngineInterface,
  EngineStreamHandle,
  AudioBuffer,
  SynthesisOptions,
  EngineStatus,
  ChunkProgressEvent,
  ChunkProgressCallback,
  SpeechStream,
  SpeechStreamOptions,
  StreamProgressEvent,
} from './types';

// Export Kokoro types
export type {
  KokoroVoice,
  KokoroConfig,
  KokoroSynthesisOptions,
  SupportedLanguage,
  // Execution provider types for hardware acceleration
  ExecutionProvider,
  ExecutionProviderPreset,
  CoreMLExecutionProviderOption,
  XNNPackExecutionProviderOption,
  CPUExecutionProviderOption,
} from './types';
export {CoreMlFlag, DEFAULT_COREML_FLAGS} from './types';

// Export Supertonic types
export type {
  SupertonicVoice,
  SupertonicConfig,
  SupertonicSynthesisOptions,
  SupertonicLanguage,
  SupertonicModelPaths,
  InferenceSteps,
} from './types';

// Export Kitten types
export type {
  KittenVoice,
  KittenConfig,
  KittenSynthesisOptions,
  KittenLanguage,
  KittenBuiltinVoice,
} from './types';

// Export component types
export type {
  HighlightedTextProps,
  HighlightedSegmentArgs,
  HighlightedSegmentProps,
} from './components/types';

// Export components
export {default as HighlightedText} from './components/HighlightedText';

// Export engines for advanced usage.
// These are part of the public API but their shape is not covered by
// the same semver guarantees as the default `Speech` API — see the
// header comment above.

/** @internal Advanced: low-level engine registry. */
export {engineManager} from './engines/EngineManager';
/** @internal Advanced: OS native engine class. */
export {OSEngine} from './engines/OSEngine';
/** @internal Advanced: Kokoro neural engine class. */
export {KokoroEngine} from './engines/kokoro';
/** @internal Advanced: Supertonic neural engine class. */
export {SupertonicEngine} from './engines/supertonic';
/** @internal Advanced: Kitten neural engine class. */
export {KittenEngine} from './engines/kitten';
