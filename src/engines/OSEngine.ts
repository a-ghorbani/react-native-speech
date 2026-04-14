/**
 * OS Native TTS Engine Wrapper
 *
 * Wraps the existing OS TTS functionality (AVSpeechSynthesizer on iOS, Android TTS on Android)
 * to conform to the TTSEngineInterface
 */

import NativeSpeech from '../NativeSpeech';
import type {
  TTSEngine,
  TTSEngineInterface,
  AudioBuffer,
  SynthesisOptions,
  ReleaseResult,
} from '../types';

export class OSEngine implements TTSEngineInterface<void> {
  readonly name: TTSEngine = 'os-native' as TTSEngine;

  /**
   * Initialize the OS engine (no-op, always ready)
   */
  async initialize(): Promise<void> {
    // OS TTS is always available, no initialization needed
  }

  /**
   * Check if engine is ready (always true for OS TTS)
   */
  async isReady(): Promise<boolean> {
    return true;
  }

  /**
   * Synthesize text using OS TTS
   *
   * Note: OS TTS engines don't return audio buffers, they play directly
   * This method will trigger playback and resolve when complete
   */
  async synthesize(
    text: string,
    options?: SynthesisOptions,
  ): Promise<AudioBuffer | void> {
    if (options) {
      // Use speakWithOptions if options provided
      await NativeSpeech.speakWithOptions(text, {
        language: options.language,
        voice: options.voiceId,
        pitch: options.pitch,
        rate: options.speed, // Map speed to rate
        volume: options.volume,
      });
    } else {
      // Use simple speak
      await NativeSpeech.speak(text);
    }

    // OS TTS doesn't return audio buffer, it plays directly
    return undefined;
  }

  /**
   * Get available voices for OS TTS
   */
  async getAvailableVoices(language?: string): Promise<string[]> {
    const voices = await NativeSpeech.getAvailableVoices(language || '');
    return voices.map(v => v.identifier);
  }

  /**
   * Stop current synthesis
   */
  async stop(): Promise<void> {
    await NativeSpeech.stop();
  }

  /**
   * Destroy engine (no-op for OS TTS)
   */
  async destroy(): Promise<void> {
    // Nothing to clean up for OS TTS
  }

  /**
   * Release engine resources (no-op for OS TTS)
   * OS TTS doesn't load models into memory, so there's nothing to release
   */
  async release(): Promise<ReleaseResult> {
    // Nothing to release for OS TTS
    return {success: true, partialRelease: false, errors: []};
  }
}
