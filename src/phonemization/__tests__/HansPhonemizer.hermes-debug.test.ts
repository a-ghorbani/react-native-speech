/**
 * Hermes debug regression guard.
 *
 * In React Native debug builds on Hermes, requiring `phonemize` triggers a
 * Metro/ExceptionsManager redbox before our try/catch sees the failure. The
 * production code now skips that require entirely in this runtime.
 *
 * This test fails immediately if `phonemize` is ever required.
 */
// Marks the file as a module so its local type/const declarations
// (DictSource, DICT_WITH_LETTERS) don't leak to global scope and clash
// with HansPhonemizer.test.ts.
export {};

jest.mock(
  'phonemize',
  () => {
    throw new Error(
      'phonemize should not be required on Hermes debug runtimes',
    );
  },
  {virtual: true},
);

jest.mock('../../utils/logger', () => ({
  createComponentLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

type DictSource = {
  lookup: (w: string) => string | null;
  size?: () => number;
};

function makeDict(map: Record<string, string>): DictSource {
  return {
    lookup: (w: string) => map[w] ?? null,
    size: () => Object.keys(map).length,
  };
}

const DICT_WITH_LETTERS: Record<string, string> = {
  m: 'ɛm',
  l: 'ɛl',
};

describe('HansPhonemizer — Hermes debug guard', () => {
  const originalHermesInternal = (globalThis as {HermesInternal?: unknown})
    .HermesInternal;

  beforeEach(() => {
    jest.resetModules();
    (globalThis as {HermesInternal?: unknown}).HermesInternal = {};
  });

  afterEach(() => {
    if (originalHermesInternal === undefined) {
      delete (globalThis as {HermesInternal?: unknown}).HermesInternal;
    } else {
      (globalThis as {HermesInternal?: unknown}).HermesInternal =
        originalHermesInternal;
    }
  });

  test('does not require phonemize and still uses dict spellout fallback', async () => {
    const {HansPhonemizer} =
      require('../HansPhonemizer') as typeof import('../HansPhonemizer');
    const phon = new HansPhonemizer({
      dict: makeDict(DICT_WITH_LETTERS) as import('../DictSource').DictSource,
    });

    const out = await phon.phonemize('ml', 'en-us');
    expect(out).toContain('ɛm');
    expect(out).toContain('ɛl');
    expect(out).not.toMatch(/\bml\b/);
  });
});
