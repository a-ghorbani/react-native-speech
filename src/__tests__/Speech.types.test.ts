/**
 * Compile-time checks (run by `yarn typecheck`): add-on configs merge into
 * SpeechInitConfig, and built-in configs are still checked per engine.
 */
import type {SpeechInitConfig, VoiceProps} from '../index';
import {TTSEngine} from '../types';

declare module '../index' {
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

// Android-only availability flags are optional: iOS voices omit them.
export const iosVoice: VoiceProps = {
  name: 'Samantha',
  quality: 'Default',
  language: 'en-US',
  identifier: 'com.apple.voice.compact.en-US.Samantha',
};

export const androidVoice: VoiceProps = {
  name: 'en-us-x-iol-network',
  quality: 'Enhanced',
  language: 'en-US',
  identifier: 'en-us-x-iol-network',
  networkConnectionRequired: true,
  notInstalled: false,
};

export const androidVoiceWrong: VoiceProps = {
  ...iosVoice,
  // @ts-expect-error the flag is a boolean
  notInstalled: 'yes',
};

it('type checks compile', () => {
  expect(addon.engine).toBe('typed-addon');
});
