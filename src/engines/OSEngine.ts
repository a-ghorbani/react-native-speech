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
  SpeechInput,
  ReleaseResult,
  ChunkProgressCallback,
  ChunkProgressEvent,
} from '../types';
import {isPhonemeInput} from '../types';

/** An utterance handed to the native queue that has not ended yet. */
interface PendingUtterance {
  text: string;
  /** Id of its native events, from `speak()`; unknown until it resolves. */
  nativeId?: number;
  started: boolean;
  onStart?: ChunkProgressCallback;
  end: () => void;
}

type NativeEvent = 'start' | 'end';

export class OSEngine implements TTSEngineInterface<void> {
  readonly name: TTSEngine = 'os-native' as TTSEngine;

  private pending: PendingUtterance[] = [];
  // Events whose id no pending utterance has yet: native can emit them
  // before its speak() promise resolves.
  private early = new Map<number, NativeEvent[]>();
  private chunkProgressCallback: ChunkProgressCallback | null = null;
  private listening = false;
  private audioDefaults: Pick<SynthesisOptions, 'ducking' | 'silentMode'> = {};

  /**
   * `ducking` / `silentMode` from `Speech.initialize({engine: 'os-native'})`,
   * used when a speak's own options leave them out.
   */
  setAudioDefaults(
    defaults: Pick<SynthesisOptions, 'ducking' | 'silentMode'>,
  ): void {
    this.audioDefaults = {
      ducking: defaults.ducking,
      silentMode: defaults.silentMode,
    };
  }

  setChunkProgressCallback(callback: ChunkProgressCallback | null): void {
    this.chunkProgressCallback = callback;
  }

  /**
   * Settle every utterance still pending. Called when the native queue is
   * stopped, so a stopped utterance emits no progress and nothing waits on it.
   */
  abandonPending(): void {
    const pending = this.pending;
    this.pending = [];
    this.early.clear();
    pending.forEach(u => u.end());
  }

  private listen(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    NativeSpeech.onStart(({id}) => this.onNativeEvent(id, 'start'));
    const ended = ({id}: {id: number}) => this.onNativeEvent(id, 'end');
    NativeSpeech.onFinish(ended);
    NativeSpeech.onError(ended);
    NativeSpeech.onStopped(ended);
  }

  private onNativeEvent(id: number, event: NativeEvent): void {
    const utterance = this.pending.find(u => u.nativeId === id);
    if (utterance) {
      this.apply(utterance, event);
    } else if (this.pending.some(u => u.nativeId === undefined)) {
      this.early.set(id, [...(this.early.get(id) ?? []), event]);
    }
  }

  private apply(utterance: PendingUtterance, event: NativeEvent): void {
    if (event === 'end') {
      this.settle(utterance);
      return;
    }
    // Android resumes a paused utterance with a second onStart.
    if (utterance.started) {
      return;
    }
    utterance.started = true;
    const progress: ChunkProgressEvent = {
      id: utterance.nativeId!,
      chunkIndex: 0,
      totalChunks: 1,
      chunkText: utterance.text,
      textRange: {start: 0, end: utterance.text.length},
      progress: 0,
    };
    this.chunkProgressCallback?.(progress);
    utterance.onStart?.(progress);
  }

  private settle(utterance: PendingUtterance): void {
    const i = this.pending.indexOf(utterance);
    if (i >= 0) {
      this.pending.splice(i, 1);
    }
    utterance.end();
  }

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
   * Queue text on the OS synthesizer. Resolves once it is queued natively;
   * the OS plays it directly and returns no audio buffer.
   */
  async synthesize(
    input: SpeechInput,
    options?: SynthesisOptions,
  ): Promise<AudioBuffer | void> {
    await this.speakTracked(input, options);
    // OS TTS doesn't return audio buffer, it plays directly
    return undefined;
  }

  /**
   * Queue `input` natively. Resolves once it is queued, with `ended`, which
   * resolves when its audio ends (finish, error, stop) or it is abandoned.
   * `onStart` is called when its audio starts.
   */
  async speakTracked(
    input: SpeechInput,
    options?: SynthesisOptions,
    onStart?: ChunkProgressCallback,
  ): Promise<{ended: Promise<void>}> {
    if (isPhonemeInput(input)) {
      throw new Error(
        'OS engine has no phoneme path; phoneme input requires the ' +
          'Kokoro or Kitten engine.',
      );
    }
    const text = input;
    this.listen();
    let end!: () => void;
    const ended = new Promise<void>(resolve => {
      end = resolve;
    });
    const utterance: PendingUtterance = {text, started: false, onStart, end};
    this.pending.push(utterance);

    let id: unknown;
    try {
      id = await this.speakNative(text, options);
    } catch (err) {
      this.settle(utterance);
      throw err;
    }
    if (typeof id !== 'number') {
      // A native module without event ids: nothing to track.
      this.settle(utterance);
    } else if (this.pending.includes(utterance)) {
      utterance.nativeId = id;
      const early = this.early.get(id) ?? [];
      this.early.delete(id);
      early.forEach(event => this.apply(utterance, event));
      if (!this.pending.some(u => u.nativeId === undefined)) {
        this.early.clear();
      }
    }
    return {ended};
  }

  private speakNative(
    text: string,
    options?: SynthesisOptions,
  ): Promise<number> {
    const ducking = options?.ducking ?? this.audioDefaults.ducking;
    const silentMode = options?.silentMode ?? this.audioDefaults.silentMode;
    if (options || ducking !== undefined || silentMode !== undefined) {
      return NativeSpeech.speakWithOptions(text, {
        language: options?.language,
        voice: options?.voiceId,
        pitch: options?.pitch,
        rate: options?.speed, // Map speed to rate
        volume: options?.volume,
        ducking,
        silentMode,
      });
    }
    return NativeSpeech.speak(text);
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
    this.abandonPending();
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
