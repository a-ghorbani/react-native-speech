/**
 * HansPhonemizer — GPL-free phonemizer using dict + hans00/phonemize.
 *
 * Layers (per word):
 *   1. REDUCED_FORMS — context-reduced overrides for function words
 *   2. Pre-generated IPA dictionary lookup (DictSource)
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
import type {DictSource} from './DictSource';

const log = createComponentLogger('TTS', 'HansPhonemizer');

// --- hans00/phonemize lazy loader ---

type Hans00 = {
  toIPA: (text: string, options?: {stripStress?: boolean}) => string;
};

// Tri-state: null = not attempted, false = attempted and failed (do not retry),
// Hans00 object = loaded and usable.
let hans00Lib: Hans00 | null | false = null;

/**
 * Lazy-load hans00/phonemize. Returns null if unavailable.
 *
 * Three failure modes are handled gracefully (warn + return null) so the
 * phonemizer can fall back to dict-only spelling instead of crashing
 * synthesis:
 *
 *   1. `require()` throws SyntaxError("Error encoding bytecode") — Hermes
 *      debug mode can't bytecode-encode the 4.3MB en-g2p dictionary.
 *      Subsequent requires sometimes return undefined silently in Metro,
 *      so we also handle (2).
 *   2. `require()` returns undefined or an object missing `toIPA` — same
 *      Hermes failure on the second-and-later call paths.
 *   3. `require()` throws because the package isn't installed.
 *
 * Use a release build for full G2P coverage; in debug, OOV words spell out
 * via dict letter lookup (see phonemizeWord layer 5b).
 */
function getHans00(): Hans00 | null {
  if (hans00Lib === false) return null;
  if (hans00Lib) return hans00Lib;
  try {
    const required = require('phonemize');
    if (!required || typeof required.toIPA !== 'function') {
      log.warn(
        'phonemize package returned no toIPA — likely a Hermes bytecode ' +
          'encoding failure in debug mode (the en-g2p dictionary is too ' +
          'large for on-the-fly compilation). OOV short tokens will spell ' +
          'out via dict; longer OOV words will pass through. Use a release ' +
          'build for full G2P coverage.',
      );
      hans00Lib = false;
      return null;
    }
    hans00Lib = required as Hans00;
    return hans00Lib;
  } catch (e) {
    const isBytecodeError =
      e instanceof SyntaxError &&
      String(e.message).includes('encoding bytecode');
    if (isBytecodeError) {
      log.warn(
        'phonemize failed to load: Hermes bytecode encoding error in debug ' +
          'mode. OOV short tokens will spell out via dict; longer OOV words ' +
          'will pass through. Use a release build for full G2P coverage.',
      );
    } else {
      log.warn(
        'phonemize package is not installed or failed to load. OOV short ' +
          'tokens will spell out via dict; longer OOV words will pass ' +
          'through. Install with `npm install phonemize` for full G2P.',
      );
    }
    hans00Lib = false;
    return null;
  }
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

/**
 * Spell out a short token letter-by-letter. Tries dict first (most accurate
 * for the target voice), then hans00 with the uppercase letter. Falls back
 * to the literal letter only if both fail. Joins with spaces so each letter
 * becomes a separate IPA word.
 */
function spellOutLetters(
  clean: string,
  dict: DictSource,
  hans00: Hans00 | null,
): string {
  return clean
    .split('')
    .map(letter => {
      const fromDict = dict.lookup(letter);
      if (fromDict) return fromDict;
      if (hans00) {
        const fromHans = hans00.toIPA(letter.toUpperCase(), {
          stripStress: false,
        });
        if (fromHans && !/^[A-Za-z']+$/.test(fromHans)) return fromHans;
      }
      return letter;
    })
    .join(' ');
}

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

/**
 * Per-word phonemizer. `primaryHit` is the cached dict lookup for `clean`,
 * pre-computed by the caller so we never hit the dict twice for the same
 * word (precheck + lookup).
 */
function phonemizeWord(
  word: string,
  dict: DictSource,
  primaryHit: string | null,
  hans00: Hans00 | null,
): string {
  const clean = word.toLowerCase().replace(/[^a-z']/g, '');

  // 1. REDUCED_FORMS take priority
  const reduced = REDUCED_FORMS[clean];
  if (reduced) return reduced;

  // 2. Dict lookup (already done by caller)
  let ipa: string | null = primaryHit;

  // 3. Hyphen-split compounds
  if (!ipa && word.includes('-')) {
    const parts = word.split('-');
    const partIpas: (string | null)[] = parts.map(p => {
      const c = p.toLowerCase().replace(/[^a-z']/g, '');
      if (!c) return null;
      const pReduced = REDUCED_FORMS[c];
      if (pReduced) return pReduced;
      return dict.lookup(c);
    });
    if (partIpas.every(p => p !== null)) {
      return partIpas.join('');
    }
  }

  // 4. Possessive handling
  if (!ipa && clean.endsWith("'s")) {
    const base = clean.slice(0, -2);
    const baseIpa = dict.lookup(base);
    if (baseIpa) ipa = baseIpa + 'ɪz';
  }

  // 5. hans00 G2P fallback (full neural-style coverage when available)
  if (!ipa && hans00) {
    const h = hans00;
    let g2p = h.toIPA(word, {stripStress: false});
    g2p = g2p.replace(/- /g, '').replace(/ɫ/g, 'l');

    // Echo detection: if hans00 returned only ASCII letters (no IPA chars),
    // the token isn't in its corpus — common for lowercased acronyms like
    // "ml" or "xlm" produced by Kitten's preprocessor. Without this fallback
    // those tokens leak into the phoneme stream as literal letters and get
    // spoken as silence between letters by the audio model.
    const isEcho = g2p.length > 0 && /^[A-Za-z']+$/.test(g2p);
    if (isEcho && /^[a-z]{2,4}$/.test(clean)) {
      g2p = spellOutLetters(clean, dict, h);
      log.info(
        `acronym fallback (hans00 echo): ${JSON.stringify(word)} -> ${JSON.stringify(g2p)}`,
      );
    }

    ipa = relocateStress(g2p);
  }

  // 5b. Dict-only spellout fallback. Fires when hans00 isn't available at
  // all (Hermes debug bytecode failure) for short OOV tokens. Without this,
  // words like "ml" / "xlm" pass through as literal ASCII letters and get
  // spoken as garbage by the audio model.
  if (!ipa && /^[a-z]{2,4}$/.test(clean)) {
    const spelled = spellOutLetters(clean, dict, null);
    if (spelled && spelled !== clean) {
      ipa = spelled;
      log.info(
        `acronym fallback (no hans00): ${JSON.stringify(word)} -> ${JSON.stringify(ipa)}`,
      );
    }
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
  dict: DictSource;
  /** Optional post-processing (e.g. Kokoro IPA normalization) */
  postProcess?: (phonemes: string, language: string) => string;
}

export class HansPhonemizer implements IPhonemizer {
  private readonly dict: DictSource;
  private readonly postProcess?: (p: string, lang: string) => string;

  constructor(options: HansPhonemizerOptions) {
    this.dict = options.dict;
    this.postProcess = options.postProcess;
  }

  async phonemize(text: string, language: string): Promise<string> {
    try {
      const dict = this.dict;
      // Lazy hans00 load; only needed for OOV words. Returns null if
      // unavailable (Hermes debug bytecode failure or package not installed)
      // — phonemizeWord then falls back to dict-only spellout.
      let hans00: Hans00 | null = null;
      const getHans = (): Hans00 | null => {
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

            // Single dict probe per word; reused by both precheck and
            // phonemizeWord. Across the typical ~100 µs/word path this
            // halves dict.lookup() calls (which matter for native dict).
            const primaryHit: string | null = clean ? dict.lookup(clean) : null;

            const needsHans =
              !REDUCED_FORMS[clean] &&
              !primaryHit &&
              !(
                w.includes('-') &&
                w.split('-').every(p => {
                  const c = p.toLowerCase().replace(/[^a-z']/g, '');
                  return !c || REDUCED_FORMS[c] || dict.lookup(c) !== null;
                })
              ) &&
              !(
                clean.endsWith("'s") && dict.lookup(clean.slice(0, -2)) !== null
              );
            ipaWords.push(
              phonemizeWord(w, dict, primaryHit, needsHans ? getHans() : null),
            );
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
