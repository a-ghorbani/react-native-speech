// Export enhanced Speech API as default (v2.0 with backward compatibility)
export {default} from './SpeechEnhanced';

// Export original Speech API for users who want explicit v1.x behavior
export {default as SpeechV1} from './Speech';

// Export types from original API
export type {
  VoiceProps,
  EventProps,
  VoiceOptions,
  ProgressEventProps,
} from './NativeSpeech';

// Export new v2.0 types
export type {
  TTSEngine,
  TTSEngineInterface,
  AudioBuffer,
  SynthesisOptions,
  EngineStatus,
  KokoroVoice,
  KokoroConfig,
  KokoroSynthesisOptions,
  SupportedLanguage,
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
