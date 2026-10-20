/**
 * NativePhonon: pass-through when the TurboModule has the phonon methods,
 * `not-compiled` fallbacks when it does not (new JS on old native).
 */

type NativePhononModule = typeof import('../NativePhonon');

function load(turbo: Record<string, unknown>): NativePhononModule {
  let mod: NativePhononModule | undefined;
  jest.isolateModules(() => {
    jest.doMock('../../../NativeSpeech', () => ({
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
    ['playBuffer', () => np.playBuffer(1, {sampleRate: 24000, channels: 1})],
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
      jest.doMock('../../../NativeSpeech', () => ({
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
    phononGetSupport: jest.fn(async () => support),
    phononNeedsCompile: jest.fn(async () => true),
    phononCreate: jest.fn(async () => ({handleId: 7})),
    phononAllocRequestId: jest.fn(() => 42),
    phononSynthesize: jest.fn(async () => ({requestId: 42, bufferId: 9})),
    phononCancel: jest.fn(() => true),
    phononCancelAll: jest.fn(() => true),
    phononPlayBuffer: jest.fn(async () => undefined),
    phononCopyBuffer: jest.fn(async () => 'AAAA'),
    phononReleaseBuffer: jest.fn(() => true),
    phononDestroy: jest.fn(async () => undefined),
    phononGetDiagnostics: jest.fn(async () => ({libraryLoaded: true})),
  };
  const np = load(turbo);

  it('forwards every call with its arguments', async () => {
    expect(np.isPresent()).toBe(true);
    await expect(np.getSupport()).resolves.toBe(support);
    await expect(np.needsCompile('/m')).resolves.toBe(true);
    expect(turbo.phononNeedsCompile).toHaveBeenCalledWith('/m');

    const opts = {language: 'en', numThreads: 4, computeUnit: 'cpu'};
    await expect(np.create('/m', opts)).resolves.toEqual({handleId: 7});
    expect(turbo.phononCreate).toHaveBeenCalledWith('/m', opts);

    expect(np.allocRequestId()).toBe(42);

    await np.synthesize(7, 42, 'Hello.', 'alba', 'en');
    expect(turbo.phononSynthesize).toHaveBeenCalledWith(
      7,
      42,
      'Hello.',
      'alba',
      'en',
    );

    expect(np.cancelUpTo(42)).toBe(true);
    expect(turbo.phononCancel).toHaveBeenCalledWith(42);
    expect(np.cancelAll()).toBe(true);

    const cfg = {sampleRate: 24000, channels: 1, volume: 0.5};
    await np.playBuffer(9, cfg);
    expect(turbo.phononPlayBuffer).toHaveBeenCalledWith(9, cfg);

    await expect(np.copyBuffer(9)).resolves.toBe('AAAA');
    expect(turbo.phononCopyBuffer).toHaveBeenCalledWith(9);
    expect(np.releaseBuffer(9)).toBe(true);
    expect(turbo.phononReleaseBuffer).toHaveBeenCalledWith(9);

    await np.destroy(7);
    expect(turbo.phononDestroy).toHaveBeenCalledWith(7);
    await expect(np.getDiagnostics()).resolves.toEqual({libraryLoaded: true});
  });

  it('propagates native rejections unchanged', async () => {
    const err = Object.assign(new Error('boom'), {code: 'PHONON_LOAD_FAILED'});
    turbo.phononCreate.mockRejectedValueOnce(err);
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
      ].sort(),
    );
  });
});
