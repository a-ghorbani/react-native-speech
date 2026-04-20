/**
 * Interjection / acronym / model-name corpus — RELEASE mode (real hans00).
 *
 * Runs the same corpus as `interjection-corpus.no-hans00.test.ts` but with
 * the real `phonemize` G2P library loaded. Matches the production
 * environment on device: iOS/Android release builds where Hermes has
 * bytecode-compiled the bundle ahead of time and hans00 is available.
 *
 * ── Why a subprocess ──
 *
 * The `phonemize` package's bundled English G2P table declares a constant
 * called `jest` (for the dictionary word "jest"). Jest wraps every loaded
 * module in a function whose parameters include `jest`, which collides
 * with the bare identifier and raises:
 *     "Identifier 'jest' has already been declared"
 *
 * Spawning a clean Node process avoids the wrapper entirely. The same
 * technique is used by `camelCase.integration.test.ts` — we extend it here
 * to the full corpus. Results are cached per `(word, stripStress)` pair so
 * the suite stays fast despite the per-OOV-word fork cost (~100ms).
 *
 * ── Coverage mapping ──
 *
 * Assertions are shared with the no-hans00 file via
 * `./interjection-corpus.shared`. They test the *behavioral class*
 * (spelled vs pronounced), not exact IPA surface, which means both modes
 * must satisfy the same invariants even though their intermediate outputs
 * diverge (e.g. `himm` → "hɪm" in release, passthrough in debug).
 */

import {execFileSync} from 'node:child_process';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Prefixed with `mock` so jest.mock() can legally reference it — jest
// hoists factories above imports and disallows references to outer vars
// that don't start with `mock`.
const mockIpaCache = new Map<string, string>();

function mockRealToIPA(word: string, stripStress: boolean): string {
  const key = `${stripStress ? 'nostress' : 'stress'}:${word}`;
  const cached = mockIpaCache.get(key);
  if (cached !== undefined) return cached;

  const script = `
    const { toIPA } = require('phonemize');
    const w = process.argv[1];
    const opts = { stripStress: ${stripStress ? 'true' : 'false'} };
    process.stdout.write(toIPA(w, opts));
  `;
  const out = execFileSync(process.execPath, ['-e', script, word], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  mockIpaCache.set(key, out);
  return out;
}

jest.mock(
  'phonemize',
  () => ({
    toIPA: (w: string, opts?: {stripStress?: boolean}) =>
      mockRealToIPA(w, opts?.stripStress === true),
  }),
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

import {HansPhonemizer} from '../HansPhonemizer';
import {JsDictSource} from '../JsDictSource';
import corpus from './fixtures/interjection-acronym-corpus.json';
import dictSubset from './fixtures/dict-subset.json';
import {describeCorpus} from './interjection-corpus.shared';

describe('Interjection corpus — real hans00 (release build simulation)', () => {
  let phon: HansPhonemizer;

  beforeAll(() => {
    phon = new HansPhonemizer({
      dict: new JsDictSource(dictSubset as Record<string, string>),
    });
  });

  describeCorpus('hans00', () => phon, corpus.cases);
});
