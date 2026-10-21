/**
 * NativePhonon: pass-through when the RNSpeechPhonon TurboModule is linked,
 * `not-compiled` fallbacks when it is not (or lacks a method).
 */

type NativePhononModule = typeof import('../NativePhonon');

function load(turbo: Record<string, unknown>): NativePhononModule {
  let mod: NativePhononModule | undefined;
  jest.isolateModules(() => {
    jest.doMock('../NativeSpeechPhonon', () => ({
      __esModule: true,
      default: turbo,
    }));
    mod = require('../NativePhonon');
  });
  return mod!;
}

describe('NativePhonon guard (methods missing)', () => {
  const np = load({speak: jest.fn()});

  it('reports not present', () => {
    expect(np.isPresent()).toBe(false);
  });

  it('getSupport resolves not-compiled', async () => {
    const info = await np.getSupport();
    expect(info).toMatchObject({supported: false, reason: 'not-compiled'});
    // A fresh copy each time, so callers cannot mutate the shared default.
    expect(info).not.toBe(np.NOT_COMPILED_SUPPORT);
  });

  it.each([
    ['needsCompile', () => np.needsCompile('/m')],
    [
      'create',
      () =>
        np.create('/m', {language: 'en', numThreads: 0, computeUnit: 'cpu'}),
    ],
    ['synthesize', () => np.synthesize(1, 1, 'hi', '', 'en')],
    ['playBuffer', () => np.playBuffer(1, {sampleRate: 24000})],
    ['copyBuffer', () => np.copyBuffer(1)],
  ])('%s rejects PHONON_NOT_COMPILED', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({
      code: np.PHONON_NOT_COMPILED,
    });
  });

  it('sync methods return values without throwing', () => {
    expect(np.allocRequestId()).toBe(0);
    expect(np.cancelUpTo(3)).toBe(false);
    expect(np.cancelAll()).toBe(false);
    expect(np.releaseBuffer(1)).toBe(false);
  });

  it('destroy resolves and diagnostics report nothing loaded', async () => {
    await expect(np.destroy(1)).resolves.toBeUndefined();
    await expect(np.resetSupport()).resolves.toBe(false);
    await expect(np.getDiagnostics()).resolves.toMatchObject({
      libraryLoaded: false,
      handleOpen: false,
      liveBuffers: 0,
    });
  });
});

describe('NativePhonon guard (TurboModule itself missing)', () => {
  it('treats a null module as not compiled', async () => {
    let np: NativePhononModule | undefined;
    jest.isolateModules(() => {
      jest.doMock('../NativeSpeechPhonon', () => ({
        __esModule: true,
        default: null,
      }));
      np = require('../NativePhonon');
    });
    expect(np!.isPresent()).toBe(false);
    await expect(np!.getSupport()).resolves.toMatchObject({
      reason: 'not-compiled',
    });
    expect(np!.cancelAll()).toBe(false);
  });
});

describe('NativePhonon pass-through (methods present)', () => {
  const support = {
    supported: true,
    reason: 'ok',
    detail: '',
    abi: 'arm64-v8a',
    osVersion: '16',
    libraryVersion: '0.4.0-r1',
    isSimulator: false,
    pageSize: 4096,
  };
  const turbo = {
    getSupport: jest.fn(async () => support),
    needsCompile: jest.fn(async () => true),
    create: jest.fn(async () => ({handleId: 7})),
    allocRequestId: jest.fn(() => 42),
    synthesize: jest.fn(async () => ({requestId: 42, bufferId: 9})),
    cancel: jest.fn(() => true),
    cancelAll: jest.fn(() => true),
    playBuffer: jest.fn(async () => undefined),
    copyBuffer: jest.fn(async () => 'AAAA'),
    releaseBuffer: jest.fn(() => true),
    destroy: jest.fn(async () => undefined),
    getDiagnostics: jest.fn(async () => ({libraryLoaded: true})),
    resetSupport: jest.fn(async () => true),
  };
  const np = load(turbo);

  it('forwards every call with its arguments', async () => {
    expect(np.isPresent()).toBe(true);
    await expect(np.getSupport()).resolves.toBe(support);
    await expect(np.needsCompile('/m')).resolves.toBe(true);
    expect(turbo.needsCompile).toHaveBeenCalledWith('/m');

    const opts = {language: 'en', numThreads: 4, computeUnit: 'cpu'};
    await expect(np.create('/m', opts)).resolves.toEqual({handleId: 7});
    expect(turbo.create).toHaveBeenCalledWith('/m', opts);

    expect(np.allocRequestId()).toBe(42);

    await np.synthesize(7, 42, 'Hello.', 'alba', 'en');
    expect(turbo.synthesize).toHaveBeenCalledWith(
      7,
      42,
      'Hello.',
      'alba',
      'en',
    );

    expect(np.cancelUpTo(42)).toBe(true);
    expect(turbo.cancel).toHaveBeenCalledWith(42);
    expect(np.cancelAll()).toBe(true);

    const cfg = {sampleRate: 24000, volume: 0.5};
    await np.playBuffer(9, cfg);
    expect(turbo.playBuffer).toHaveBeenCalledWith(9, cfg);

    await expect(np.copyBuffer(9)).resolves.toBe('AAAA');
    expect(turbo.copyBuffer).toHaveBeenCalledWith(9);
    expect(np.releaseBuffer(9)).toBe(true);
    expect(turbo.releaseBuffer).toHaveBeenCalledWith(9);

    await np.destroy(7);
    expect(turbo.destroy).toHaveBeenCalledWith(7);
    await expect(np.getDiagnostics()).resolves.toEqual({libraryLoaded: true});
    await expect(np.resetSupport()).resolves.toBe(true);
    expect(turbo.resetSupport).toHaveBeenCalledTimes(1);
  });

  it('propagates native rejections unchanged', async () => {
    const err = Object.assign(new Error('boom'), {code: 'PHONON_LOAD_FAILED'});
    turbo.create.mockRejectedValueOnce(err);
    await expect(
      np.create('/m', {language: 'en', numThreads: 0, computeUnit: 'cpu'}),
    ).rejects.toBe(err);
  });

  it('default export exposes the same functions', () => {
    expect(Object.keys(np.default).sort()).toEqual(
      [
        'isPresent',
        'getSupport',
        'needsCompile',
        'create',
        'allocRequestId',
        'synthesize',
        'cancelUpTo',
        'cancelAll',
        'playBuffer',
        'copyBuffer',
        'releaseBuffer',
        'destroy',
        'getDiagnostics',
        'resetSupport',
      ].sort(),
    );
  });
});
