/**
 * Type definitions export
 */

export * from './Engine';
export * from './Kokoro';

// Re-export existing types for backward compatibility
export type {
  VoiceQuality,
  VoiceProps,
  VoiceOptions,
  EngineProps,
  EventProps,
  ProgressEventProps,
} from '../NativeSpeech';
