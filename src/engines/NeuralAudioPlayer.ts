/**
 * Neural Audio Player
 *
 * Handles playback of PCM audio data from neural TTS engines
 * Provides a unified interface for playing synthesized audio
 */

import {Platform} from 'react-native';
import NativeNeuralAudioPlayer from '../NativeAudioPlayer';
import type {
  AudioPlayerConfig,
  AudioPlayerEventProps,
} from '../NativeAudioPlayer';
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
   * A playback ran since the last native stop. Native can hold a pause between
   * chunks (iOS: the headphones went away), so stop() reaches native until then;
   * native ignores a stop with nothing to stop.
   */
  private nativeMayHold = false;
  /** The utterance whose held chunk keeps Android's audio focus until a native stop. */
  private focusOwner: object | null = null;
  /** The utterance whose chunks are playing, until it ends or stops. */
  private openUtterance: object | null = null;
  /** A pause between two chunks: the next chunk waits on it (#134). */
  private gapPause: {promise: Promise<void>; release: () => void} | null = null;
  private readonly gapListeners = {
    pause: new Set<(e: AudioPlayerEventProps) => void>(),
    resume: new Set<(e: AudioPlayerEventProps) => void>(),
    stopped: new Set<(e: AudioPlayerEventProps) => void>(),
  };
  /** The playback in flight is still waiting on a gap pause, not started. */
  private awaitingStart = false;
  /** Id of the last chunk native started, for the gap pause events. */
  private lastChunkId = 0;
  private trackingIds = false;

  /**
   * Play an audio buffer
   * @param audioBuffer - Audio buffer from neural TTS engine
   * @param options - Playback options
   * @param utterance - Token of the utterance this chunk belongs to: keep
   *   audio focus when the chunk ends, for the next one (Android). The
   *   caller then calls `endUtterance(utterance)` when the utterance ends.
   */
  async play(
    audioBuffer: AudioBuffer,
    options?: PlaybackOptions,
    utterance?: object,
  ): Promise<void> {
    const hold = utterance !== undefined && Platform.OS === 'android';

    // Convert Float32Array to base64-encoded Int16 PCM
    const base64Audio = float32ToBase64Int16(audioBuffer.samples);

    // Prepare configuration
    const config: AudioPlayerConfig = {
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.channels,
      ducking: options?.ducking,
      silentMode: options?.silentMode,
      ...(hold && {holdFocus: true}),
    };

    if (hold) {
      this.focusOwner = utterance;
    }
    await this.playNative(
      () => NativeNeuralAudioPlayer.playAudio(base64Audio, config),
      utterance,
    );
  }

  /**
   * Track a playback that the caller starts natively (e.g. an engine
   * add-on playing through the native PCM sink), so `stop()` and
   * `pause()` reach native while it is pending.
   * @param start - Starts playback; resolves when it finishes or is stopped
   * @param utterance - Token of the utterance this chunk belongs to, so a
   *   pause between its chunks holds the next one; the caller then calls
   *   `endUtterance(utterance)` when the utterance ends.
   */
  async playNative(
    start: () => Promise<void>,
    utterance?: object,
  ): Promise<void> {
    if (utterance !== undefined) {
      this.openUtterance = utterance;
      this.trackChunkIds();
    }
    const gen = ++this.playGen;
    this.isCurrentlyPlaying = true;
    this.nativeMayHold = true;

    try {
      while (this.gapPause) {
        this.awaitingStart = true;
        await this.gapPause.promise;
        if (gen !== this.playGen) {
          return;
        }
      }
      this.awaitingStart = false;
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
    this.openUtterance = null;
    this.awaitingStart = false;
    this.endGapPause();
    if (this.isCurrentlyPlaying || this.nativeMayHold) {
      this.playGen++;
      this.isCurrentlyPlaying = false;
      this.nativeMayHold = false;
      this.focusOwner = null;
      await NativeNeuralAudioPlayer.stop();
    }
  }

  /**
   * End of an utterance played with its token: release the audio focus it
   * kept, unless a newer utterance has played since (it then owns it) or a
   * playback is in flight.
   */
  async endUtterance(utterance: object): Promise<void> {
    if (this.openUtterance === utterance && !this.isCurrentlyPlaying) {
      // A pause after the last chunk has nothing left to hold.
      this.openUtterance = null;
      this.endGapPause();
    }
    if (this.focusOwner === utterance && !this.isCurrentlyPlaying) {
      await this.stop();
    }
  }

  /**
   * Start of a new utterance or stream: end a pause native still holds from
   * the previous one (it then reports onStopped). A playback in flight is left
   * to the engine, which replaces it.
   */
  async endHeldPause(): Promise<void> {
    if (!this.isCurrentlyPlaying && this.nativeMayHold) {
      await this.stop();
    }
  }

  /**
   * Pause current playback. Between two chunks of an utterance, the next
   * chunk is held until `resume()` (or dropped by `stop()`).
   */
  async pause(): Promise<boolean> {
    if (this.gapPause) {
      return true;
    }
    if (this.isCurrentlyPlaying && !this.awaitingStart) {
      return NativeNeuralAudioPlayer.pause();
    }
    if (this.openUtterance === null) {
      return false;
    }
    let release!: () => void;
    const promise = new Promise<void>(r => {
      release = r;
    });
    this.gapPause = {promise, release};
    this.emitGap('pause');
    return true;
  }

  /**
   * Resume paused playback
   */
  async resume(): Promise<boolean> {
    if (this.gapPause) {
      const held = this.gapPause;
      this.gapPause = null;
      this.emitGap('resume');
      held.release();
      return true;
    }
    const result = await NativeNeuralAudioPlayer.resume();
    return result;
  }

  /** onPause for a pause between chunks, which native never sees. */
  onGapPause(listener: (e: AudioPlayerEventProps) => void): {
    remove: () => void;
  } {
    this.gapListeners.pause.add(listener);
    return {remove: () => this.gapListeners.pause.delete(listener)};
  }

  /** onResume for the end of a pause between chunks. */
  onGapResume(listener: (e: AudioPlayerEventProps) => void): {
    remove: () => void;
  } {
    this.gapListeners.resume.add(listener);
    return {remove: () => this.gapListeners.resume.delete(listener)};
  }

  /** onStopped for a pause between chunks that ends without resume(). */
  onGapStopped(listener: (e: AudioPlayerEventProps) => void): {
    remove: () => void;
  } {
    this.gapListeners.stopped.add(listener);
    return {remove: () => this.gapListeners.stopped.delete(listener)};
  }

  /** Ends a pause between chunks without playing what it held. */
  private endGapPause(): void {
    if (this.gapPause) {
      this.gapPause.release();
      this.gapPause = null;
      this.emitGap('stopped');
    }
  }

  private emitGap(kind: 'pause' | 'resume' | 'stopped'): void {
    const event = {id: this.lastChunkId};
    this.gapListeners[kind].forEach(listener => listener(event));
  }

  private trackChunkIds(): void {
    if (this.trackingIds) {
      return;
    }
    this.trackingIds = true;
    NativeNeuralAudioPlayer.onStart?.(e => {
      this.lastChunkId = e.id;
    });
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
