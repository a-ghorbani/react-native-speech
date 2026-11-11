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
  /** Native utterance id, known from its onStart. */
  nativeId?: number;
  onStart?: ChunkProgressCallback;
  end: () => void;
}

export class OSEngine implements TTSEngineInterface<void> {
  readonly name: TTSEngine = 'os-native' as TTSEngine;

  // In native queue order: each native onStart belongs to the first one
  // without an id.
  private pending: PendingUtterance[] = [];
  private chunkProgressCallback: ChunkProgressCallback | null = null;
  private listening = false;

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
    pending.forEach(u => u.end());
  }

  private listen(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    NativeSpeech.onStart(({id}) => {
      // A repeated start of a bound utterance (Android resume) is not a new one.
      if (this.pending.some(u => u.nativeId === id)) {
        return;
      }
      const utterance = this.pending.find(u => u.nativeId === undefined);
      if (!utterance) {
        return;
      }
      utterance.nativeId = id;
      const event: ChunkProgressEvent = {
        id,
        chunkIndex: 0,
        totalChunks: 1,
        chunkText: utterance.text,
        textRange: {start: 0, end: utterance.text.length},
        progress: 0,
      };
      this.chunkProgressCallback?.(event);
      utterance.onStart?.(event);
    });
    const ended = ({id}: {id: number}) => {
      const i = this.pending.findIndex(u => u.nativeId === id);
      if (i >= 0) {
        this.pending.splice(i, 1)[0]!.end();
      }
    };
    NativeSpeech.onFinish(ended);
    NativeSpeech.onError(ended);
    NativeSpeech.onStopped(ended);
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
    const utterance: PendingUtterance = {text, onStart, end};
    this.pending.push(utterance);

    try {
      await this.speakNative(text, options);
    } catch (err) {
      const i = this.pending.indexOf(utterance);
      if (i >= 0) {
        this.pending.splice(i, 1);
      }
      end();
      throw err;
    }
    return {ended};
  }

  private async speakNative(
    text: string,
    options?: SynthesisOptions,
  ): Promise<void> {
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
