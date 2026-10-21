// Jest mock: `module.exports = require('@pocketpalai/react-native-speech-phonon/jest');`
// The engine reports `not-compiled`, as in an app without the native module.
// Plain CommonJS, since apps do not transform this package; src/__tests__/phononSpec.test.ts
// keeps it in step with the real exports.
const {fn: jestFn} = require('jest-mock');

const PHONON = 'phonon';

const PHONON_CONSTANTS = Object.freeze({
  DEFAULT_MAX_CHUNK_SIZE: 250,
  SAMPLE_RATE: 24000,
  DEFAULT_LANGUAGE: 'en',
  DEFAULT_COMPUTE_UNIT: 'neuralEngine',
  WATCHDOG_MIN_MS: 10_000,
  WATCHDOG_FACTOR: 4,
  ESTIMATED_MS_PER_CHAR: 90,
  CREATE_WATCHDOG_MS: 120_000,
  CREATE_COMPILE_WATCHDOG_MS: 600_000,
});

const PHONON_LANGUAGES = Object.freeze(['en', 'fr', 'de', 'es', 'pt', 'none']);

const NOT_COMPILED = Object.freeze({
  supported: false,
  reason: 'not-compiled',
  detail: 'jest mock',
  abi: '',
  osVersion: '',
  libraryVersion: '',
  isSimulator: false,
  pageSize: 0,
});

const NOT_COMPILED_DIAGNOSTICS = Object.freeze({
  memKb: 0,
  peakMemKb: 0,
  threads: 0,
  libraryLoaded: false,
  handleOpen: false,
  liveBuffers: 0,
  orphanBuffers: 0,
  busy: 'idle',
  lastIssuedId: 0,
  cancelWatermark: 0,
});

const NATIVE_CODES = {
  PHONON_NOT_COMPILED: 'ERR_PHONON_UNSUPPORTED',
  PHONON_UNSUPPORTED: 'ERR_PHONON_UNSUPPORTED',
  PHONON_LOAD_FAILED: 'ERR_PHONON_LOAD',
  PHONON_INVALID_HANDLE: 'ERR_PHONON_NOT_INITIALIZED',
  PHONON_INVALID_BUFFER: 'ERR_PHONON_INTERNAL',
  PHONON_BUFFER_LIMIT: 'ERR_PHONON_BUFFER_LIMIT',
  PHONON_VOICE_NOT_FOUND: 'ERR_PHONON_VOICE',
  PHONON_LANGUAGE_UNSUPPORTED: 'ERR_PHONON_LANGUAGE',
  PHONON_SPEAK_FAILED: 'ERR_PHONON_SYNTH',
  PHONON_CALLBACK_FAILED: 'ERR_PHONON_SYNTH',
  PHONON_INTERNAL: 'ERR_PHONON_INTERNAL',
};

class PhononError extends Error {
  constructor(code, message, options) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'PhononError';
    this.code = code;
    this.nativeCode = options?.nativeCode;
    this.cause = options?.cause;
  }
}

class PhononUnsupportedError extends PhononError {
  constructor(reason = 'not-compiled', detail = '') {
    super(
      'ERR_PHONON_UNSUPPORTED',
      `Phonon is not supported here: ${reason}${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'PhononUnsupportedError';
    this.reason = reason;
    this.detail = detail;
  }
}

function toPhononError(e) {
  if (e instanceof PhononError) {
    return e;
  }
  const nativeCode =
    typeof e === 'object' && e !== null && typeof e.code === 'string'
      ? e.code
      : undefined;
  const message =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : 'Unknown Phonon error';
  const code =
    (nativeCode && NATIVE_CODES[nativeCode]) || 'ERR_PHONON_INTERNAL';
  return new PhononError(code, message, {nativeCode, cause: e});
}

function normalizePhononLanguage(language) {
  return (language.split(/[-_]/)[0] ?? '').trim().toLowerCase();
}

function parseVoicesJsonl(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && typeof obj.name === 'string' && obj.name.length > 0) {
      const str = k => (typeof obj[k] === 'string' ? obj[k] : undefined);
      out.push({
        name: obj.name,
        filename: str('filename'),
        voice_id: str('voice_id'),
        language: str('language'),
        description: str('description'),
        gender: str('gender'),
      });
    }
  }
  return out;
}

function foldVoiceName(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function buildVoices(ids, catalog, fallbackLanguage) {
  const byName = new Map();
  const byId = new Map();
  for (const entry of catalog) {
    byName.set(foldVoiceName(entry.name), entry);
    if (entry.voice_id) {
      byId.set(entry.voice_id, entry);
    }
  }
  return ids.map(id => {
    const entry = byName.get(foldVoiceName(id)) ?? byId.get(id);
    const voice = {id, name: entry?.name ?? id};
    const language = entry?.language ?? fallbackLanguage;
    if (language) {
      voice.language = language;
    }
    if (entry?.gender) {
      voice.gender = entry.gender;
    }
    if (entry?.description) {
      voice.description = entry.description;
    }
    return voice;
  });
}

class PhononEngine {
  name = PHONON;
  static getSupport = jestFn(() => Promise.resolve({...NOT_COMPILED}));
  static resetSupport = jestFn(() => Promise.resolve(true));
  static clearSupportCache = jestFn();
  static needsCompile = jestFn(() => Promise.resolve(false));
  static getDiagnostics = jestFn(() =>
    Promise.resolve({...NOT_COMPILED_DIAGNOSTICS}),
  );
  getSupport = jestFn(() => PhononEngine.getSupport());
  resetSupport = jestFn(() => PhononEngine.resetSupport());
  initialize = jestFn(() => Promise.reject(new PhononUnsupportedError()));
  isReady = jestFn(() => Promise.resolve(false));
  getLoadInfo = jestFn(() => null);
  getLastMetrics = jestFn(() => null);
  getStatus = jestFn(() => ({isReady: false, isLoading: false, error: null}));
  synthesize = jestFn(() => Promise.resolve());
  synthesizeStream = jestFn(() => ({
    append: jestFn(),
    finalize: jestFn(() => Promise.resolve()),
    cancel: jestFn(() => Promise.resolve()),
  }));
  getAvailableVoices = jestFn(() => Promise.resolve([]));
  getVoicesWithMetadata = jestFn(() => []);
  setChunkProgressCallback = jestFn();
  onChunkMetrics = jestFn(() => () => {});
  stop = jestFn(() => Promise.resolve());
  destroy = jestFn(() => Promise.resolve());
  release = jestFn(() =>
    Promise.resolve({success: true, partialRelease: false, errors: []}),
  );
}

module.exports = {
  __esModule: true,
  PHONON,
  PHONON_CONSTANTS,
  PHONON_LANGUAGES,
  PhononEngine,
  PhononError,
  PhononUnsupportedError,
  toPhononError,
  normalizePhononLanguage,
  parseVoicesJsonl,
  buildVoices,
};
