import {
  PhononError,
  PhononUnsupportedError,
  nativeCodeOf,
  toPhononError,
} from '../errors';

describe('toPhononError', () => {
  it.each([
    ['PHONON_NOT_COMPILED', 'ERR_PHONON_UNSUPPORTED'],
    ['PHONON_UNSUPPORTED', 'ERR_PHONON_UNSUPPORTED'],
    ['PHONON_LOAD_FAILED', 'ERR_PHONON_LOAD'],
    ['PHONON_INVALID_HANDLE', 'ERR_PHONON_NOT_INITIALIZED'],
    ['PHONON_INVALID_BUFFER', 'ERR_PHONON_INTERNAL'],
    ['PHONON_BUFFER_LIMIT', 'ERR_PHONON_BUFFER_LIMIT'],
    ['PHONON_VOICE_NOT_FOUND', 'ERR_PHONON_VOICE'],
    ['PHONON_LANGUAGE_UNSUPPORTED', 'ERR_PHONON_LANGUAGE'],
    ['PHONON_SPEAK_FAILED', 'ERR_PHONON_SYNTH'],
    ['PHONON_CALLBACK_FAILED', 'ERR_PHONON_SYNTH'],
    ['PHONON_INTERNAL', 'ERR_PHONON_INTERNAL'],
    ['SOMETHING_ELSE', 'ERR_PHONON_INTERNAL'],
  ])('%s -> %s', (nativeCode, code) => {
    const native = Object.assign(new Error('upstream says no'), {
      code: nativeCode,
    });
    const err = toPhononError(native);
    expect(err).toBeInstanceOf(PhononError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.nativeCode).toBe(nativeCode);
    expect(err.message).toBe('upstream says no');
    expect(err.cause).toBe(native);
  });

  it('passes PhononErrors through unchanged', () => {
    const err = new PhononError('ERR_PHONON_TIMEOUT', 'slow');
    expect(toPhononError(err)).toBe(err);
  });

  it('wraps strings, plain errors and unknown values', () => {
    expect(toPhononError('boom')).toMatchObject({
      code: 'ERR_PHONON_INTERNAL',
      message: 'boom',
    });
    expect(toPhononError(new Error('plain'))).toMatchObject({
      code: 'ERR_PHONON_INTERNAL',
      message: 'plain',
      nativeCode: undefined,
    });
    expect(toPhononError(42).message).toBe('Unknown Phonon error');
    expect(toPhononError({code: 7}).nativeCode).toBeUndefined();
  });
});

describe('nativeCodeOf', () => {
  it('reads only string codes', () => {
    expect(nativeCodeOf({code: 'X'})).toBe('X');
    expect(nativeCodeOf({code: 1})).toBeUndefined();
    expect(nativeCodeOf(null)).toBeUndefined();
    expect(nativeCodeOf('X')).toBeUndefined();
  });
});

describe('PhononUnsupportedError', () => {
  it('carries reason and detail', () => {
    const err = new PhononUnsupportedError('missing-cpu-features', 'asimddp');
    expect(err).toBeInstanceOf(PhononError);
    expect(err.code).toBe('ERR_PHONON_UNSUPPORTED');
    expect(err.name).toBe('PhononUnsupportedError');
    expect(err.reason).toBe('missing-cpu-features');
    expect(err.detail).toBe('asimddp');
    expect(err.message).toContain('missing-cpu-features (asimddp)');
    expect(new PhononUnsupportedError('not-compiled').message).not.toContain(
      '(',
    );
  });
});
