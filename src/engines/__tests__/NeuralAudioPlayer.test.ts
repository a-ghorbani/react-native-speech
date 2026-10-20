/**
 * NeuralAudioPlayer.playBuffer: native-buffer playback keeps
 * isCurrentlyPlaying in sync, so stop()/pause() reach native.
 */

const mockPlayBuffer = jest.fn();
jest.mock('../phonon/NativePhonon', () => ({
  __esModule: true,
  default: {
    playBuffer: (...args: unknown[]) => mockPlayBuffer(...args),
  },
}));

jest.mock('../../NativeAudioPlayer', () => ({
  __esModule: true,
  default: {
    playAudio: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    pause: jest.fn(async () => true),
    resume: jest.fn(async () => true),
    isSpeaking: jest.fn(async () => false),
  },
}));

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
  mockPlayBuffer.mockReset();
  Object.values(native).forEach(fn => fn.mockClear());
});

describe('NeuralAudioPlayer.playBuffer', () => {
  it('passes the buffer id and a mono config with clamped volume', async () => {
    mockPlayBuffer.mockResolvedValue(undefined);
    const player = new NeuralAudioPlayer();
    await player.playBuffer(7, 24000, {
      ducking: true,
      silentMode: 'ignore',
      volume: 1.7,
    });
    expect(mockPlayBuffer).toHaveBeenCalledWith(7, {
      sampleRate: 24000,
      channels: 1,
      ducking: true,
      silentMode: 'ignore',
      volume: 1,
    });
    await player.playBuffer(8, 22050, {channels: 2});
    expect(mockPlayBuffer).toHaveBeenLastCalledWith(8, {
      sampleRate: 22050,
      channels: 2,
    });
  });

  it('stop() and pause() call native while a playBuffer is pending', async () => {
    const d = deferred();
    mockPlayBuffer.mockReturnValue(d.promise);
    const player = new NeuralAudioPlayer();
    const playing = player.playBuffer(1, 24000);

    await expect(player.pause()).resolves.toBe(true);
    expect(native.pause).toHaveBeenCalledTimes(1);
    await player.stop();
    expect(native.stop).toHaveBeenCalledTimes(1);

    d.resolve();
    await playing;
  });

  it('clears the playing flag when playback ends or fails', async () => {
    const player = new NeuralAudioPlayer();
    mockPlayBuffer.mockResolvedValueOnce(undefined);
    await player.playBuffer(1, 24000);
    await player.stop();
    await expect(player.pause()).resolves.toBe(false);
    expect(native.stop).not.toHaveBeenCalled();

    mockPlayBuffer.mockRejectedValueOnce(new Error('PHONON_INVALID_BUFFER'));
    await expect(player.playBuffer(2, 24000)).rejects.toThrow(
      'PHONON_INVALID_BUFFER',
    );
    await player.stop();
    expect(native.stop).not.toHaveBeenCalled();
  });
});
