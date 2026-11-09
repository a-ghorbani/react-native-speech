/**
 * NeuralAudioPlayer.playNative: native-started playback keeps
 * isCurrentlyPlaying in sync, so stop()/pause() reach native.
 */

jest.mock('../../NativeAudioPlayer', () => ({
  __esModule: true,
  default: {
    playAudio: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    pause: jest.fn(async () => true),
    resume: jest.fn(async () => true),
    isSpeaking: jest.fn(async () => false),
    onPause: jest.fn((listener: () => void) => {
      pauseListeners.push(listener);
      return {remove: jest.fn()};
    }),
  },
}));

const pauseListeners: Array<() => void> = [];
/** A native onPause that JS did not ask for (iOS: the headphones went away). */
const emitNativePause = () => pauseListeners.forEach(l => l());

import NativeNeuralAudioPlayer from '../../NativeAudioPlayer';
import {NeuralAudioPlayer} from '../NeuralAudioPlayer';

const native = NativeNeuralAudioPlayer as unknown as Record<string, jest.Mock>;

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

beforeEach(() => {
  Object.values(native).forEach(fn => fn.mockClear());
  pauseListeners.length = 0;
});

describe('NeuralAudioPlayer.playNative', () => {
  it('stop() and pause() call native while a native playback is pending', async () => {
    const d = deferred();
    const player = new NeuralAudioPlayer();
    const playing = player.playNative(() => d.promise);

    await expect(player.pause()).resolves.toBe(true);
    expect(native.pause).toHaveBeenCalledTimes(1);
    await player.stop();
    expect(native.stop).toHaveBeenCalledTimes(1);

    d.resolve();
    await playing;
  });

  it('clears the playing flag when playback ends or fails', async () => {
    const player = new NeuralAudioPlayer();
    await player.playNative(async () => {});
    await player.stop();
    await expect(player.pause()).resolves.toBe(false);
    expect(native.stop).not.toHaveBeenCalled();

    await expect(
      player.playNative(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await player.stop();
    expect(native.stop).not.toHaveBeenCalled();
  });

  it('a replaced playback settling does not clear the newer one', async () => {
    const a = deferred();
    const b = deferred();
    const player = new NeuralAudioPlayer();
    const first = player.playNative(() => a.promise);
    const second = player.playNative(() => b.promise);

    a.resolve();
    await first;
    await expect(player.pause()).resolves.toBe(true);
    await player.stop();
    expect(native.stop).toHaveBeenCalledTimes(1);

    b.resolve();
    await second;
  });

  it('play() goes through the same tracking', async () => {
    const d = deferred();
    native.playAudio!.mockReturnValueOnce(d.promise);
    const player = new NeuralAudioPlayer();
    const playing = player.play({
      samples: new Float32Array([0, 0.5]),
      sampleRate: 24000,
      channels: 1,
      duration: 2 / 24000,
    });

    await player.stop();
    expect(native.stop).toHaveBeenCalledTimes(1);

    d.resolve();
    await playing;
    expect(native.playAudio).toHaveBeenCalledWith(expect.any(String), {
      sampleRate: 24000,
      channels: 1,
      ducking: undefined,
      silentMode: undefined,
    });
  });
});

describe('NeuralAudioPlayer held pause (native paused between chunks)', () => {
  it('stop() in a held gap reaches native', async () => {
    const player = new NeuralAudioPlayer();
    await player.playNative(async () => {});
    emitNativePause();
    await player.stop();
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('after that stop, the next utterance plays and an idle stop() stays local', async () => {
    const player = new NeuralAudioPlayer();
    await player.playNative(async () => {});
    emitNativePause();
    await player.stop();
    native.stop!.mockClear();

    await player.playNative(async () => {});
    await player.stop();
    expect(native.stop).not.toHaveBeenCalled();
  });

  it('resume() clears the held pause', async () => {
    const player = new NeuralAudioPlayer();
    await player.playNative(async () => {});
    emitNativePause();
    await player.resume();
    expect(native.resume).toHaveBeenCalledTimes(1);
    await player.stop();
    expect(native.stop).not.toHaveBeenCalled();
  });

  it('a pause during a playback is not a held pause', async () => {
    const d = deferred();
    const player = new NeuralAudioPlayer();
    const playing = player.playNative(() => d.promise);
    emitNativePause();
    d.resolve();
    await playing;
    await player.stop();
    expect(native.stop).not.toHaveBeenCalled();
  });

  it('subscribes to native onPause once', async () => {
    const player = new NeuralAudioPlayer();
    await player.playNative(async () => {});
    await player.playNative(async () => {});
    expect(native.onPause).toHaveBeenCalledTimes(1);
  });
});
