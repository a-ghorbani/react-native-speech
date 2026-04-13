/**
 * HansPhonemizer — GPL-free phonemizer using dict + hans00/phonemize.
 *
 * Layers (per word):
 *   1. REDUCED_FORMS — context-reduced overrides for function words
 *   2. Pre-generated IPA dictionary lookup
 *   3. Hyphen-split compound handling (per-part REDUCED_FORMS + dict)
 *   4. Possessive fallback ("X's" → dict[X] + "ɪz")
 *   5. hans00/phonemize G2P fallback for OOV, with stress relocation
 *   6. Per-word destress keyed by English spelling
 */

import {
  type IPhonemizer,
  splitOnPunctuation,
  rejoinChunks,
} from '../engines/kokoro/Phonemizer';
import {createComponentLogger} from '../utils/logger';

const log = createComponentLogger('TTS', 'HansPhonemizer');

// --- hans00/phonemize lazy loader ---

type Hans00 = {
  toIPA: (text: string, options?: {stripStress?: boolean}) => string;
};

let hans00Lib: Hans00 | null = null;

function getHans00(): Hans00 {
  if (!hans00Lib) {
    try {
      hans00Lib = require('phonemize');
    } catch (e) {
      const isBytecodeError =
        e instanceof SyntaxError &&
        String(e.message).includes('encoding bytecode');
      if (isBytecodeError) {
        throw new Error(
          'phonemize failed to load in Hermes debug mode (dictionary too large for on-the-fly bytecode compilation). ' +
            'Use a release build, or disable the JS phonemizer in debug.',
        );
      }
      throw new Error(
        'phonemize package is required for HansPhonemizer.\n\n' +
          'Install it with:\n' +
          '  npm install phonemize\n' +
          '  # or\n' +
          '  yarn add phonemize',
      );
    }
  }
  return hans00Lib!;
}

// --- Constants ---

const IPA_VOWELS = new Set('aeiouæɑɒɔəɛɜɝɞɪʊʌɚɨøɵœɶɤɯʏɐ'.split(''));

const REDUCED_FORMS: Record<string, string> = {
  a: 'ɐ',
  to: 'tə',
  has: 'hɐz',
};

const FULLY_UNSTRESSED = new Set([
  'he',
  'she',
  'it',
  'i',
  'we',
  'they',
  'you',
  'her',
  'the',
  'an',
  'a',
  'to',
  'of',
  'for',
  'in',
  'at',
  'by',
  'is',
  'was',
  'are',
  'were',
  'am',
  'be',
  'had',
  'have',
  'can',
  'could',
  'will',
  'would',
  'has',
  'and',
  'or',
  'if',
  'that',
  'this',
  'from',
  'with',
  'went',
  'got',
  "i've",
  "i'm",
  "he's",
  "she's",
  "we've",
  "they're",
]);

const SECONDARY_STRESSED = new Set([
  'but',
  'not',
  'how',
  'who',
  'what',
  'on',
  'been',
  'him',
  'me',
  'being',
  'having',
  'shall',
  'should',
  'might',
  'over',
  'into',
  'about',
]);

// --- Helpers ---

function relocateStress(ipa: string): string {
  return ipa
    .split(' ')
    .map(word => {
      if (word.length > 1 && (word[0] === 'ˈ' || word[0] === 'ˌ')) {
        const mark = word[0]!;
        const rest = word.slice(1);
        for (let i = 0; i < rest.length; i++) {
          if (IPA_VOWELS.has(rest[i]!)) {
            if (i === 0) return word;
            return rest.slice(0, i) + mark + rest.slice(i);
          }
        }
      }
      return word;
    })
    .join(' ');
}

function phonemizeWord(
  word: string,
  dict: Record<string, string>,
  hans00: Hans00 | null,
): string {
  const clean = word.toLowerCase().replace(/[^a-z']/g, '');

  // 1. REDUCED_FORMS take priority
  const reduced = REDUCED_FORMS[clean];
  if (reduced) return reduced;

  // 2. Dict lookup
  let ipa: string | null = clean ? (dict[clean] ?? null) : null;

  // 3. Hyphen-split compounds
  if (!ipa && word.includes('-')) {
    const parts = word.split('-');
    const partIpas: (string | null)[] = parts.map(p => {
      const c = p.toLowerCase().replace(/[^a-z']/g, '');
      if (!c) return null;
      const pReduced = REDUCED_FORMS[c];
      if (pReduced) return pReduced;
      return dict[c] ?? null;
    });
    if (partIpas.every(p => p !== null)) {
      return partIpas.join('');
    }
  }

  // 4. Possessive handling
  if (!ipa && clean.endsWith("'s")) {
    const base = clean.slice(0, -2);
    const baseIpa = dict[base];
    if (baseIpa) ipa = baseIpa + 'ɪz';
  }

  // 5. hans00 G2P fallback
  if (!ipa && hans00) {
    let g2p = hans00.toIPA(word, {stripStress: false});
    g2p = g2p.replace(/- /g, '').replace(/ɫ/g, 'l');
    ipa = relocateStress(g2p);
  }

  if (!ipa) return word;

  // 6. Per-word destress
  if (FULLY_UNSTRESSED.has(clean)) {
    ipa = ipa.replace(/[ˈˌ]/g, '');
  } else if (SECONDARY_STRESSED.has(clean)) {
    ipa = ipa.replace(/ˈ/g, 'ˌ');
  }

  return ipa;
}

// --- Public ---

export interface HansPhonemizerOptions {
  dict: Record<string, string>;
  /** Optional post-processing (e.g. Kokoro IPA normalization) */
  postProcess?: (phonemes: string, language: string) => string;
}

export class HansPhonemizer implements IPhonemizer {
  private readonly dict: Record<string, string>;
  private readonly postProcess?: (p: string, lang: string) => string;

  constructor(options: HansPhonemizerOptions) {
    this.dict = options.dict;
    this.postProcess = options.postProcess;
  }

  async phonemize(text: string, language: string): Promise<string> {
    try {
      const dict = this.dict;
      // Lazy hans00 load; only needed for OOV words
      let hans00: Hans00 | null = null;
      const getHans = (): Hans00 => {
        if (!hans00) hans00 = getHans00();
        return hans00;
      };

      const chunks = splitOnPunctuation(text) as {
        isPunctuation: boolean;
        text: string;
        phoneme?: string;
      }[];

      for (const chunk of chunks) {
        if (!chunk.isPunctuation && chunk.text.trim()) {
          const words = chunk.text.trim().split(/\s+/);
          const ipaWords: string[] = [];
          for (const w of words) {
            const clean = w.toLowerCase().replace(/[^a-z']/g, '');
            const needsHans =
              !REDUCED_FORMS[clean] &&
              !(clean && dict[clean]) &&
              !(
                w.includes('-') &&
                w.split('-').every(p => {
                  const c = p.toLowerCase().replace(/[^a-z']/g, '');
                  return !c || REDUCED_FORMS[c] || dict[c];
                })
              ) &&
              !(clean.endsWith("'s") && dict[clean.slice(0, -2)]);
            ipaWords.push(phonemizeWord(w, dict, needsHans ? getHans() : null));
          }
          chunk.phoneme = ipaWords.join(' ');
        }
      }

      let result = rejoinChunks(chunks);
      if (this.postProcess) {
        result = this.postProcess(result, language);
      }
      return result.trim();
    } catch (error) {
      log.error(
        `JS phonemization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error instanceof Error) {
        throw new Error(`JS phonemization failed: ${error.message}`);
      }
      throw error;
    }
  }
}
