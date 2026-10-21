// Jest mock: `module.exports = require('@pocketpalai/react-native-speech-phonon/jest');`
// The engine reports `not-compiled`, as in an app without the native module.
const {fn: jestFn} = require('jest-mock');

const NOT_COMPILED = {
  supported: false,
  reason: 'not-compiled',
  detail: 'jest mock',
  abi: '',
  osVersion: '',
  libraryVersion: '',
  isSimulator: false,
  pageSize: 0,
};

class PhononError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhononError';
    this.code = code;
  }
}

class PhononUnsupportedError extends PhononError {
  constructor(reason = 'not-compiled', detail = '') {
    super('ERR_PHONON_UNSUPPORTED', `Phonon is not supported: ${reason}`);
    this.name = 'PhononUnsupportedError';
    this.reason = reason;
    this.detail = detail;
  }
}

class PhononEngine {
  name = 'phonon';
  static getSupport = jestFn(() => Promise.resolve({...NOT_COMPILED}));
  static resetSupport = jestFn(() => Promise.resolve(true));
  static clearSupportCache = jestFn();
  static needsCompile = jestFn(() => Promise.resolve(false));
  static getDiagnostics = jestFn(() => Promise.resolve(null));
  getSupport = jestFn(() => PhononEngine.getSupport());
  resetSupport = jestFn(() => PhononEngine.resetSupport());
  initialize = jestFn(() => Promise.reject(new PhononUnsupportedError()));
  isReady = jestFn(() => Promise.resolve(false));
  synthesize = jestFn(() => Promise.resolve());
  getAvailableVoices = jestFn(() => Promise.resolve([]));
  getVoicesWithMetadata = jestFn(() => []);
  setChunkProgressCallback = jestFn();
  stop = jestFn(() => Promise.resolve());
  destroy = jestFn(() => Promise.resolve());
  release = jestFn(() =>
    Promise.resolve({success: true, partialRelease: false, errors: []}),
  );
}

module.exports = {
  __esModule: true,
  PHONON: 'phonon',
  PhononEngine,
  PhononError,
  PhononUnsupportedError,
};
