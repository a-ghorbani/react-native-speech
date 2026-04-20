/**
 * Interjection / acronym / model-name corpus — no-hans00 mode.
 *
 * Simulates the Hermes DEBUG environment: `phonemize` is mocked as an object
 * without `toIPA`, so `getHans00()` returns null and HansPhonemizer uses the
 * dict-only spellout fallback (Layer 5b). Matches what `yarn android --mode
 * debug` produces on a real device when Hermes can't bytecode-encode the
 * 4.3MB en-g2p bundle.
 *
 * The sister file `interjection-corpus.hans00.test.ts` exercises the same
 * corpus with REAL hans00 via a Node subprocess — that's the release path.
 * Shared assertions live in `./interjection-corpus.shared`; updating them
 * forces both modes to stay in lockstep.
 */

jest.mock('phonemize', () => ({}), {virtual: true});

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

describe('Interjection corpus — no-hans00 (Hermes debug simulation)', () => {
  let phon: HansPhonemizer;

  beforeAll(() => {
    phon = new HansPhonemizer({
      dict: new JsDictSource(dictSubset as Record<string, string>),
    });
  });

  describeCorpus('no-hans00', () => phon, corpus.cases);
});
