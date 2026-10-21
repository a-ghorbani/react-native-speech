/**
 * Compile-time checks (run by `yarn typecheck`): add-on configs merge into
 * SpeechInitConfig, and built-in configs are still checked per engine.
 */
import type {SpeechInitConfig} from '../Speech';
import {TTSEngine} from '../types';

declare module '../Speech' {
  interface CustomEngineConfigs {
    'typed-addon': {modelPath: string; quality?: 'low' | 'high'};
  }
}

export const addon: SpeechInitConfig = {
  engine: 'typed-addon',
  modelPath: '/m',
  quality: 'high',
  ducking: true,
};

// @ts-expect-error modelPath is required by the add-on config
export const addonMissing: SpeechInitConfig = {engine: 'typed-addon'};

export const kokoro: SpeechInitConfig = {
  engine: TTSEngine.KOKORO,
  modelPath: '/k.onnx',
  voicesPath: '/v.bin',
};

export const kokoroWrong: SpeechInitConfig = {
  engine: TTSEngine.KOKORO,
  modelPath: '/k.onnx',
  voicesPath: '/v.bin',
  // @ts-expect-error not a Kokoro option
  inferenceSteps: 2,
};

// @ts-expect-error unregistered ids are not accepted
export const unknown: SpeechInitConfig = {engine: 'nope'};

it('type checks compile', () => {
  expect(addon.engine).toBe('typed-addon');
});
