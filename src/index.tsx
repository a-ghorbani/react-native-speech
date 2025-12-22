/**
 * React Native Speech - Multi-Engine TTS Library
 *
 * Supports:
 * - OS Native TTS (iOS AVSpeechSynthesizer, Android TextToSpeech)
 * - Kokoro Neural TTS (high quality, multi-language)
 * - Supertonic Neural TTS (ultra-fast, lightweight)
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
  AudioBuffer,
  SynthesisOptions,
  EngineStatus,
  ChunkProgressEvent,
  ChunkProgressCallback,
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
  NNAPIExecutionProviderOption,
  XNNPackExecutionProviderOption,
  CPUExecutionProviderOption,
} from './types';

// Export Supertonic types
export type {
  SupertonicVoice,
  SupertonicConfig,
  SupertonicSynthesisOptions,
  SupertonicLanguage,
  InferenceSteps,
} from './types';

// Export component types
export type {
  HighlightedTextProps,
  HighlightedSegmentArgs,
  HighlightedSegmentProps,
} from './components/types';

// Export components
export {default as HighlightedText} from './components/HighlightedText';

// Export engines for advanced usage
export {engineManager} from './engines/EngineManager';
export {OSEngine} from './engines/OSEngine';
export {KokoroEngine} from './engines/kokoro';
export {SupertonicEngine} from './engines/supertonic';
