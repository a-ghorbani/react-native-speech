jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('onnxruntime-react-native', () => ({}), {virtual: true});
jest.mock('../../NeuralAudioPlayer', () => ({
  neuralAudioPlayer: {
    play: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../../phonemization', () => ({
  loadNativeDict: jest.fn(),
}));

import {KokoroEngine} from '../KokoroEngine';

describe('KokoroEngine - release() during an active stream', () => {
  test('release() cancels the active stream session', async () => {
    const e = new KokoroEngine();
    // Skip model loading: mark initialized so release() runs its teardown.
    (e as any).isInitialized = true;
    const cancel = jest.fn().mockResolvedValue(undefined);
    (e as any).activeStreamSession = {cancel};

    await e.release();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect((e as any).activeStreamSession).toBeNull();
  });
});
