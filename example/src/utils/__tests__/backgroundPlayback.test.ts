import {NativeModules, Platform} from 'react-native';
import {setBackgroundPlayback} from '../backgroundPlayback';

const start = jest.fn(() => Promise.resolve());
const stop = jest.fn(() => Promise.resolve());

beforeEach(() => {
  start.mockClear();
  stop.mockClear();
  NativeModules.BackgroundPlayback = {start, stop};
});

const onPlatform = (os: 'android' | 'ios') =>
  Object.defineProperty(Platform, 'OS', {value: os, configurable: true});

it('starts the service on Android when enabled', async () => {
  onPlatform('android');
  await setBackgroundPlayback(true);
  expect(start).toHaveBeenCalledTimes(1);
  expect(stop).not.toHaveBeenCalled();
});

it('stops the service on Android when disabled', async () => {
  onPlatform('android');
  await setBackgroundPlayback(false);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
});

it('does nothing on iOS', async () => {
  onPlatform('ios');
  await setBackgroundPlayback(true);
  await setBackgroundPlayback(false);
  expect(start).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});
