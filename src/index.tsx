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
 * The engine classes and `engineManager` are `@internal`: their shape
 * may change between minor releases. Building blocks for engine add-ons
 * live in the experimental `@pocketpalai/react-native-speech/engine-sdk`
 * subpath; see docs/USAGE.md "Engine add-on API".
 */

// Export Speech API as default
export {default} from './Speech';
export type {SpeechInitConfig, CustomEngineConfigs} from './Speech';

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

// Runtime guard for SpeechInput — exported so consumers (especially
// untyped JS callers) can branch on input kind without deep imports.
export {isPhonemeInput} from './types';

// Export engine types
export type {
  TTSEngineInterface,
  EngineId,
  EngineSupport,
  EngineStreamHandle,
  AudioBuffer,
  SynthesisOptions,
  SpeechInput,
  PhonemeInput,
  EngineStatus,
  ChunkProgressEvent,
  ChunkProgressCallback,
  SpeechStream,
  SpeechStreamOptions,
  StreamProgressEvent,
  FirstChunkMode,
} from './types';

// Export Kokoro types
export type {
  KokoroVoice,
  KokoroConfig,
  KokoroSynthesisOptions,
  SupportedLanguage,
  // Execution provider types for hardware acceleration
  ExecutionProvider,
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

// OS audio interruptions (calls, other media, audio focus loss).
export {onAudioInterruption} from './NativeAudioPlayer';
export type {AudioInterruptionProps} from './NativeAudioPlayer';

// Streaming markdown stripper — lets consumers strip markdown themselves
// (with `stripMarkdown: false` on the stream) so `streamRange` offsets
// map onto the exact text they appended.
export {createMarkdownStreamBuffer} from './utils/stripMarkdown';
export type {
  MarkdownStreamBuffer,
  StripMarkdownOptions,
} from './utils/stripMarkdown';

// Advanced: not covered by semver (see the header comment).

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

// Return types of TTSEngineInterface.release().
export type {ReleaseResult, ReleaseError} from './types';
