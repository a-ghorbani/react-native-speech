/**
 * Engine visibility: Phonon is shown only for `supported: true`, for
 * every reason the native probe can report; other engines always show.
 */

const mockGetEngineSupport = jest.fn();

jest.mock('@pocketpalai/react-native-speech', () => ({
  __esModule: true,
  TTSEngine: {
    OS_NATIVE: 'os-native',
    KOKORO: 'kokoro',
    SUPERTONIC: 'supertonic',
    KITTEN: 'kitten',
    PHONON: 'phonon',
  },
  default: {
    getEngineSupport: (...args: unknown[]) => mockGetEngineSupport(...args),
  },
}));

import {TTSEngine} from '@pocketpalai/react-native-speech';
import {
  isEngineVisible,
  visibleEngines,
  probeEngineSupport,
  isEngineUnsupportedError,
  markUnsupported,
  engineInitFailure,
  errorCodeOf,
  resetHiddenLog,
  type EngineSupportMap,
} from '../engineSupport';

const ALL = [
  TTSEngine.KITTEN,
  TTSEngine.KOKORO,
  TTSEngine.SUPERTONIC,
  TTSEngine.PHONON,
  TTSEngine.OS_NATIVE,
];

/** Every reason PhononSupportInfo.reason can carry besides 'ok'. */
const UNSUPPORTED_REASONS = [
  'not-compiled',
  'unsupported-abi',
  'translated-abi',
  'missing-cpu-features',
  'library-missing',
  'symbols-missing',
  'load-failed',
  'os-too-old',
  'low-memory',
  'forced',
  'error',
];

let logSpy: jest.SpyInstance;

beforeEach(() => {
  mockGetEngineSupport.mockReset();
  resetHiddenLog();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('visibleEngines', () => {
  it('hides Phonon until a probe says supported', () => {
    expect(visibleEngines(ALL, {})).toEqual([
      TTSEngine.KITTEN,
      TTSEngine.KOKORO,
      TTSEngine.SUPERTONIC,
      TTSEngine.OS_NATIVE,
    ]);
  });

  it('shows Phonon when supported', () => {
    const map: EngineSupportMap = {
      [TTSEngine.PHONON]: {supported: true, reason: 'ok'},
    };
    expect(visibleEngines(ALL, map)).toEqual(ALL);
    expect(isEngineVisible(TTSEngine.PHONON, map)).toBe(true);
  });

  it.each(UNSUPPORTED_REASONS)('hides Phonon for reason %s', reason => {
    const map: EngineSupportMap = {
      [TTSEngine.PHONON]: {supported: false, reason},
    };
    expect(isEngineVisible(TTSEngine.PHONON, map)).toBe(false);
    expect(visibleEngines(ALL, map)).not.toContain(TTSEngine.PHONON);
  });

  it('never hides the always-available engines', () => {
    const map: EngineSupportMap = {
      [TTSEngine.KITTEN]: {supported: false, reason: 'error'},
    };
    expect(isEngineVisible(TTSEngine.KITTEN, map)).toBe(true);
  });

  it('filters items that carry an engine field', () => {
    const items = ALL.map(engine => ({engine, label: engine}));
    expect(visibleEngines(items, {}).map(i => i.engine)).not.toContain(
      TTSEngine.PHONON,
    );
  });
});

describe('probeEngineSupport', () => {
  it('reports supported without logging', async () => {
    mockGetEngineSupport.mockResolvedValue({supported: true, reason: 'ok'});
    const map = await probeEngineSupport();
    expect(mockGetEngineSupport).toHaveBeenCalledWith(TTSEngine.PHONON);
    expect(map[TTSEngine.PHONON]).toEqual({
      supported: true,
      reason: 'ok',
      detail: undefined,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it.each(UNSUPPORTED_REASONS)(
    'reason %s: hidden with one info line',
    async reason => {
      mockGetEngineSupport.mockResolvedValue({
        supported: false,
        reason,
        detail: 'd',
      });
      const map = await probeEngineSupport();
      await probeEngineSupport();
      expect(isEngineVisible(TTSEngine.PHONON, map)).toBe(false);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(`[Phonon] hidden: ${reason} (d)`);
    },
  );

  it('treats a throwing probe as unsupported (never throws)', async () => {
    mockGetEngineSupport.mockRejectedValue(new Error('boom'));
    const map = await probeEngineSupport();
    expect(map[TTSEngine.PHONON]).toEqual({
      supported: false,
      reason: 'error',
      detail: 'boom',
    });
  });

  it('treats a truthy non-boolean supported as unsupported', async () => {
    mockGetEngineSupport.mockResolvedValue({supported: 'yes', reason: 'ok'});
    const map = await probeEngineSupport();
    expect(isEngineVisible(TTSEngine.PHONON, map)).toBe(false);
  });
});

describe('init failure handling', () => {
  it('recognizes the unsupported rejection', () => {
    const err = Object.assign(new Error('x'), {code: 'ERR_PHONON_UNSUPPORTED'});
    expect(isEngineUnsupportedError(err)).toBe(true);
    expect(
      isEngineUnsupportedError(
        Object.assign(new Error('x'), {code: 'ERR_PHONON_LOAD'}),
      ),
    ).toBe(false);
    expect(isEngineUnsupportedError(null)).toBe(false);
    expect(isEngineUnsupportedError('ERR_PHONON_UNSUPPORTED')).toBe(false);
  });

  it('markUnsupported hides the engine and logs once', () => {
    const map = markUnsupported(
      {[TTSEngine.PHONON]: {supported: true, reason: 'ok'}},
      TTSEngine.PHONON,
      'load-failed',
    );
    expect(isEngineVisible(TTSEngine.PHONON, map)).toBe(false);
    expect(logSpy).toHaveBeenCalledWith('[Phonon] hidden: load-failed');
  });
});

describe('engineInitFailure (RootView init catch)', () => {
  const SUPPORTED: EngineSupportMap = {
    [TTSEngine.PHONON]: {supported: true, reason: 'ok'},
  };
  const unsupported = Object.assign(new Error('nope'), {
    code: 'ERR_PHONON_UNSUPPORTED',
  });

  it('hides Phonon and falls back on ERR_PHONON_UNSUPPORTED', () => {
    expect(
      engineInitFailure(
        TTSEngine.PHONON,
        unsupported,
        {
          [TTSEngine.PHONON]: {
            supported: false,
            reason: 'missing-cpu-features',
          },
        },
        TTSEngine.KOKORO,
      ),
    ).toEqual({
      action: 'hide',
      reason: 'missing-cpu-features',
      fallbackTo: TTSEngine.KOKORO,
    });
    // Even when the re-probe still says supported.
    expect(
      engineInitFailure(
        TTSEngine.PHONON,
        unsupported,
        SUPPORTED,
        TTSEngine.KITTEN,
      ),
    ).toEqual({
      action: 'hide',
      reason: 'unsupported',
      fallbackTo: TTSEngine.KITTEN,
    });
  });

  it('hides Phonon when the re-probe turned negative (load failure recorded)', () => {
    const out = engineInitFailure(
      TTSEngine.PHONON,
      Object.assign(new Error('dlopen'), {code: 'ERR_PHONON_LOAD'}),
      {[TTSEngine.PHONON]: {supported: false, reason: 'load-failed'}},
      TTSEngine.SUPERTONIC,
    );
    expect(out).toEqual({
      action: 'hide',
      reason: 'load-failed',
      fallbackTo: TTSEngine.SUPERTONIC,
    });
  });

  it('hides Phonon when no probe result is available', () => {
    expect(
      engineInitFailure(
        TTSEngine.PHONON,
        new Error('x'),
        null,
        TTSEngine.KITTEN,
      ).action,
    ).toBe('hide');
  });

  it('never falls back to Phonon itself', () => {
    const out = engineInitFailure(
      TTSEngine.PHONON,
      unsupported,
      null,
      TTSEngine.PHONON,
    );
    expect(out).toMatchObject({action: 'hide', fallbackTo: TTSEngine.KITTEN});
  });

  it('sends other Phonon errors to the diag line, never a dialog', () => {
    const out = engineInitFailure(
      TTSEngine.PHONON,
      Object.assign(new Error('bad model'), {code: 'ERR_PHONON_MODEL'}),
      SUPPORTED,
      TTSEngine.KITTEN,
    );
    expect(out).toEqual({
      action: 'diag',
      message: 'ERR_PHONON_MODEL: bad model',
    });
    expect(
      engineInitFailure(TTSEngine.PHONON, 'boom', SUPPORTED, TTSEngine.KITTEN),
    ).toEqual({action: 'diag', message: 'ERR: boom'});
  });

  it('keeps the generic dialog for engines that are always available', () => {
    expect(
      engineInitFailure(
        TTSEngine.KITTEN,
        new Error('no dict'),
        null,
        TTSEngine.KITTEN,
      ),
    ).toEqual({action: 'alert', message: 'no dict'});
  });

  it('errorCodeOf reads string codes only', () => {
    expect(errorCodeOf({code: 'ERR_X'})).toBe('ERR_X');
    expect(errorCodeOf({code: 3})).toBe('ERR');
    expect(errorCodeOf(null)).toBe('ERR');
  });
});
