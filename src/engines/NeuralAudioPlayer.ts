/**
 * Neural Audio Player
 *
 * Handles playback of PCM audio data from neural TTS engines
 * Provides a unified interface for playing synthesized audio
 */

import NativeNeuralAudioPlayer from '../NativeAudioPlayer';
import type {AudioPlayerConfig} from '../NativeAudioPlayer';
import type {AudioBuffer} from '../types';
import {float32ToBase64Int16} from '../utils/AudioConverter';

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
  private playGen = 0;

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

    await this.playNative(() =>
      NativeNeuralAudioPlayer.playAudio(base64Audio, config),
    );
  }

  /**
   * Track a playback that the caller starts natively (e.g. an engine
   * add-on playing through the native PCM sink), so `stop()` and
   * `pause()` reach native while it is pending.
   * @param start - Starts playback; resolves when it finishes or is stopped
   */
  async playNative(start: () => Promise<void>): Promise<void> {
    const gen = ++this.playGen;
    this.isCurrentlyPlaying = true;

    try {
      await start();
    } finally {
      if (gen === this.playGen) {
        this.isCurrentlyPlaying = false;
      }
    }
  }

  /**
   * Stop current playback
   */
  async stop(): Promise<void> {
    if (this.isCurrentlyPlaying) {
      this.playGen++;
      this.isCurrentlyPlaying = false;
      await NativeNeuralAudioPlayer.stop();
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
