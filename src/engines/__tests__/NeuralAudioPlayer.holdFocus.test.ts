/**
 * Android keeps audio focus across the chunks of one utterance (#133): each
 * chunk is played with the utterance's token, and endUtterance(token)
 * releases the focus once, through a native stop.
 */

jest.mock('../../NativeAudioPlayer', () => ({
  __esModule: true,
  default: {
    playAudio: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
  },
}));

import {Platform} from 'react-native';
import NativeNeuralAudioPlayer from '../../NativeAudioPlayer';
import {NeuralAudioPlayer} from '../NeuralAudioPlayer';

const native = NativeNeuralAudioPlayer as unknown as Record<string, jest.Mock>;
const buffer = {
  samples: new Float32Array([0, 0.5]),
  sampleRate: 24000,
  channels: 1,
  duration: 0,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return {promise, resolve};
}

const originalOS = Platform.OS;
beforeEach(() => {
  Object.values(native).forEach(fn => fn.mockClear());
  native.playAudio!.mockImplementation(async () => {});
  Platform.OS = 'android';
});
afterAll(() => {
  Platform.OS = originalOS;
});

describe('NeuralAudioPlayer: audio focus per utterance (Android)', () => {
  it('asks native to hold focus for chunks played with a token, not others', async () => {
    const player = new NeuralAudioPlayer();
    await player.play(buffer, undefined, {});
    await player.play(buffer);
    expect(native.playAudio!.mock.calls[0][1].holdFocus).toBe(true);
    expect(native.playAudio!.mock.calls[1][1].holdFocus).toBeUndefined();
  });

  it('releases the focus once when the utterance ends', async () => {
    const player = new NeuralAudioPlayer();
    const utterance = {};
    await player.play(buffer, undefined, utterance);
    await player.play(buffer, undefined, utterance);
    expect(native.stop).not.toHaveBeenCalled();
    await player.endUtterance(utterance);
    await player.endUtterance(utterance);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it("an older utterance's end leaves a newer utterance's focus alone", async () => {
    const player = new NeuralAudioPlayer();
    const older = {};
    const newer = {};
    await player.play(buffer, undefined, older);
    // The newer one played a chunk and is synthesizing its next one.
    await player.play(buffer, undefined, newer);
    await player.endUtterance(older);
    expect(native.stop).not.toHaveBeenCalled();
    await player.endUtterance(newer);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('does not stop a playback in flight', async () => {
    const player = new NeuralAudioPlayer();
    const utterance = {};
    const d = deferred();
    native.playAudio!.mockImplementationOnce(() => d.promise);
    const playing = player.play(buffer, undefined, utterance);
    await player.endUtterance(utterance);
    expect(native.stop).not.toHaveBeenCalled();
    d.resolve();
    await playing;
  });

  it('is a no-op after stop() already released it', async () => {
    const player = new NeuralAudioPlayer();
    const utterance = {};
    await player.play(buffer, undefined, utterance);
    await player.stop();
    await player.endUtterance(utterance);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('iOS: no hold and no native stop at the utterance end', async () => {
    Platform.OS = 'ios';
    const player = new NeuralAudioPlayer();
    const utterance = {};
    await player.play(buffer, undefined, utterance);
    await player.endUtterance(utterance);
    expect(native.playAudio!.mock.calls[0][1].holdFocus).toBeUndefined();
    expect(native.stop).not.toHaveBeenCalled();
  });
});
