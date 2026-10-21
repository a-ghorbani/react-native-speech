const mockFn = (...args) => {
  return undefined;
};

const mockPromise = (...args) => Promise.resolve(undefined);
const mockPromiseBool = (...args) => Promise.resolve(false);
const mockPromiseArr = (...args) => Promise.resolve([]);

const {fn: jestFn} = require('jest-mock');
const eventSub = {remove: jestFn()};
const eventMock = jestFn(() => eventSub);

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
  // Phonon is never compiled into the jest mock; every other engine is.
  static getEngineSupport = engine =>
    Promise.resolve(
      engine === 'phonon'
        ? {supported: false, reason: 'not-compiled', detail: 'jest mock'}
        : {supported: true, reason: 'ok'},
    );
  static resetEngineSupport = () => Promise.resolve(true);
}

const HighlightedText = jestFn(function HighlightedText() {
  return null;
});

module.exports = {
  __esModule: true,
  default: Speech,
  HighlightedText,
};
