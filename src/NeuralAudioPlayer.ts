import TurboSpeech from './NativeSpeech';

export type {AudioPlayerConfig} from './NativeSpeech';
export type {EventProps as AudioPlayerEventProps} from './NativeSpeech';
export type {ProgressEventProps as AudioPlayerProgressEventProps} from './NativeSpeech';

// Wrapper for neural audio player methods from RNSpeech
export const NativeNeuralAudioPlayer = {
  playAudio: TurboSpeech.playAudio,
  stop: TurboSpeech.stopAudio,
  pause: TurboSpeech.pauseAudio,
  resume: TurboSpeech.resumeAudio,
  isSpeaking: TurboSpeech.isAudioPlaying,

  // Event emitters (same as main Speech module)
  onStart: TurboSpeech.onStart,
  onFinish: TurboSpeech.onFinish,
  onError: TurboSpeech.onError,
  onProgress: TurboSpeech.onProgress,
  onPause: TurboSpeech.onPause,
  onResume: TurboSpeech.onResume,
  onStopped: TurboSpeech.onStopped,
};

export default NativeNeuralAudioPlayer;
