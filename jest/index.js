const mockFn = (...args) => {
  return undefined;
};

const mockPromise = (...args) => Promise.resolve(undefined);
const mockPromiseBool = (...args) => Promise.resolve(false);
const mockPromiseArr = (...args) => Promise.resolve([]);

const {fn: jestFn} = require('jest-mock');
const eventSub = {remove: jestFn()};
const eventMock = jestFn(() => eventSub);
const BUILTIN_ENGINES = ['os-native', 'kokoro', 'supertonic', 'kitten'];

class Speech {
  static maxInputLength = 4000;
  static reset = mockFn;
  static stop = mockPromise;
  static initialize = mockFn;
  static speak = mockPromise;
  static pause = mockPromiseBool;
  static resume = mockPromiseBool;
  static isSpeaking = mockPromiseBool;
  static speakWithOptions = mockPromise;
  static getAvailableVoices = mockPromiseArr;
  static getEngines = mockPromiseArr;
  static setEngine = mockPromise;
  static openVoiceDataInstaller = mockPromise;
  static onError = eventMock;
  static onStart = eventMock;
  static onFinish = eventMock;
  static onPause = eventMock;
  static onResume = eventMock;
  static onStopped = eventMock;
  static onProgress = eventMock;
  static registerEngine = jestFn();
  static getEngineSupport = engine =>
    Promise.resolve(
      BUILTIN_ENGINES.includes(engine)
        ? {supported: true, reason: 'ok'}
        : {supported: false, reason: 'unknown-engine', detail: String(engine)},
    );
  static resetEngineSupport = () => Promise.resolve(true);
  static getCurrentEngineId = () => 'os-native';
  static getAvailableEngineIds = () => [...BUILTIN_ENGINES];
}

const HighlightedText = jestFn(function HighlightedText() {
  return null;
});

module.exports = {
  __esModule: true,
  default: Speech,
  HighlightedText,
};
