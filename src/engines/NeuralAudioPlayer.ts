/**
 * Neural Audio Player
 *
 * Handles playback of PCM audio data from neural TTS engines
 * Provides a unified interface for playing synthesized audio
 */

import NativeNeuralAudioPlayer from '../NativeAudioPlayer';
import type {AudioPlayerConfig} from '../NativeAudioPlayer';
import type {AudioBuffer} from '../types';
import type {PhononPlayConfig} from '../NativeSpeech';
import {float32ToBase64Int16} from '../utils/AudioConverter';
import NativePhonon from './phonon/NativePhonon';

export interface PlaybackOptions {
  /**
   * If `true`, audio from other apps will be temporarily lowered (ducked) while speech is active.
   * @default false
   */
  ducking?: boolean;

  /**
   * Determines how speech audio interacts with the device's silent (ringer) switch.
   * @platform iOS
   *
   * - `obey`: (Default) Does not change the app's audio session. Speech follows the system default.
   * - `respect`: Speech will be silenced by the ringer switch. Use for non-critical audio.
   * - `ignore`: Speech will play even if the ringer is off. Use for critical audio when ducking is not desired.
   */
  silentMode?: 'obey' | 'respect' | 'ignore';
}

/**
 * Neural Audio Player class
 * Manages playback of neural TTS audio
 */
export class NeuralAudioPlayer {
  private isCurrentlyPlaying = false;

  /**
   * Play an audio buffer
   * @param audioBuffer - Audio buffer from neural TTS engine
   * @param options - Playback options
   */
  async play(
    audioBuffer: AudioBuffer,
    options?: PlaybackOptions,
  ): Promise<void> {
    // Convert Float32Array to base64-encoded Int16 PCM
    const base64Audio = float32ToBase64Int16(audioBuffer.samples);

    // Prepare configuration
    const config: AudioPlayerConfig = {
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.channels,
      ducking: options?.ducking,
      silentMode: options?.silentMode,
    };

    // Play audio via native module
    this.isCurrentlyPlaying = true;

    try {
      await NativeNeuralAudioPlayer.playAudio(base64Audio, config);
    } finally {
      this.isCurrentlyPlaying = false;
    }
  }

  /**
   * Play PCM that stays in native memory (Phonon buffer store). The
   * buffer is consumed by the native side, whatever the outcome.
   * Keeps `isCurrentlyPlaying` in sync exactly like `play()`, so
   * `stop()` and `pause()` reach native during the playback.
   * @param bufferId - Native buffer id from `phononSynthesize`
   * @param sampleRate - Sample rate of the buffer in Hz
   * @param options - Playback options plus a native gain (`volume`)
   */
  async playBuffer(
    bufferId: number,
    sampleRate: number,
    options?: PlaybackOptions & {volume?: number; channels?: number},
  ): Promise<void> {
    const config: PhononPlayConfig = {
      sampleRate,
      channels: options?.channels ?? 1,
    };
    if (options?.ducking !== undefined) {
      config.ducking = options.ducking;
    }
    if (options?.silentMode !== undefined) {
      config.silentMode = options.silentMode;
    }
    if (options?.volume !== undefined) {
      config.volume = Math.max(0, Math.min(1, options.volume));
    }

    this.isCurrentlyPlaying = true;

    try {
      await NativePhonon.playBuffer(bufferId, config);
    } finally {
      this.isCurrentlyPlaying = false;
    }
  }

  /**
   * Stop current playback
   */
  async stop(): Promise<void> {
    if (this.isCurrentlyPlaying) {
      await NativeNeuralAudioPlayer.stop();
      this.isCurrentlyPlaying = false;
    }
  }

  /**
   * Pause current playback
   */
  async pause(): Promise<boolean> {
    if (this.isCurrentlyPlaying) {
      const result = await NativeNeuralAudioPlayer.pause();
      return result;
    }
    return false;
  }

  /**
   * Resume paused playback
   */
  async resume(): Promise<boolean> {
    const result = await NativeNeuralAudioPlayer.resume();
    return result;
  }

  /**
   * Check if audio is currently playing
   */
  async isSpeaking(): Promise<boolean> {
    return NativeNeuralAudioPlayer.isSpeaking();
  }

  /**
   * Get event emitters for playback events
   */
  get events() {
    return {
      onStart: NativeNeuralAudioPlayer.onStart,
      onFinish: NativeNeuralAudioPlayer.onFinish,
      onError: NativeNeuralAudioPlayer.onError,
      onProgress: NativeNeuralAudioPlayer.onProgress,
      onPause: NativeNeuralAudioPlayer.onPause,
      onResume: NativeNeuralAudioPlayer.onResume,
      onStopped: NativeNeuralAudioPlayer.onStopped,
    };
  }
}

// Singleton instance
export const neuralAudioPlayer = new NeuralAudioPlayer();
