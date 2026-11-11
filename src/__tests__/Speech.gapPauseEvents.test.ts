/**
 * #134: Speech.onPause / onResume / onStopped also report a pause between
 * two neural chunks, and remove() detaches both sources.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});

const mockRemoved: string[] = [];
jest.mock('../NativeSpeech', () => {
  const store: Record<string, unknown> = {};
  for (const ev of ['onPause', 'onResume', 'onStopped']) {
    store[ev] = jest.fn(() => ({remove: () => mockRemoved.push(ev)}));
  }
  return {
    __esModule: true,
    default: new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'getConstants') return () => ({maxInputLength: 4000});
          if (!store[prop]) store[prop] = jest.fn(async () => false);
          return store[prop];
        },
      },
    ),
  };
});

import Speech from '../Speech';
import {neuralAudioPlayer} from '../engines/NeuralAudioPlayer';

const buffer = {
  samples: new Float32Array([0.1]),
  sampleRate: 24000,
  channels: 1,
  duration: 0,
};

test('gap pause, resume and stop reach the Speech event subscribers', async () => {
  const events: string[] = [];
  const subs = [
    Speech.onPause(() => {
      events.push('pause');
    }),
    Speech.onResume(() => {
      events.push('resume');
    }),
    Speech.onStopped(() => {
      events.push('stopped');
    }),
  ];
  const u = {};
  await neuralAudioPlayer.play(buffer, undefined, u);
  await neuralAudioPlayer.pause();
  await neuralAudioPlayer.resume();
  await neuralAudioPlayer.pause();
  await neuralAudioPlayer.stop();
  expect(events).toEqual(['pause', 'resume', 'pause', 'stopped']);

  subs.forEach(s => s.remove());
  expect(mockRemoved.sort()).toEqual(['onPause', 'onResume', 'onStopped']);
  await neuralAudioPlayer.play(buffer, undefined, {});
  await neuralAudioPlayer.pause();
  await neuralAudioPlayer.stop();
  expect(events).toHaveLength(4);
});
