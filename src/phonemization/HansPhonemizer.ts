/**
 * HansPhonemizer — GPL-free phonemizer using dict + hans00/phonemize.
 *
 * Layers (per word):
 *   0. Hyphenated letter sequences ("U-S-") spelled letter by letter
 *   1. REDUCED_FORMS — context-reduced overrides for function words
 *   2. Pre-generated IPA dictionary lookup (DictSource)
 *   3. Hyphen-split compound handling (per-part REDUCED_FORMS + dict)
 *   4. Dict-derived OOV forms: possessives, contractions, acronym plurals,
 *      plurals, elongations
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
const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : true;

// --- hans00/phonemize lazy loader ---

type Hans00 = {
  toIPA: (text: string, options?: {stripStress?: boolean}) => string;
};

// Module-level cache. `hans00Loaded` is set true after the first attempt,
// so both successful loads and known failures are sticky for the process
// lifetime — we never retry the require.
let hans00Lib: Hans00 | null = null;
let hans00Loaded = false;

/**
 * Lazy-load hans00/phonemize. Returns null if unavailable.
 *
 * Four failure modes are handled gracefully (warn + return null) so the
 * phonemizer can fall back to dict-only spelling instead of crashing
 * synthesis:
 *
 *   0. Hermes debug runtime: skip the load proactively. Even though the
 *      `require()` is wrapped in try/catch, Metro reports the module load
 *      error to ExceptionsManager before control returns here, which causes
 *      a redbox. We avoid the require entirely in this runtime.
 *   1. `require()` throws SyntaxError("Error encoding bytecode") — Hermes
 *      debug mode can't bytecode-encode the 4.3MB en-g2p dictionary.
 *      Subsequent requires return undefined silently in Metro, so (2) also
 *      handles it.
 *   2. `require()` returns undefined or an object missing `toIPA` — same
 *      Hermes failure on the second-and-later call paths.
 *   3. `require()` throws because the package isn't installed.
 *
 * Use a release build for full G2P coverage; in debug, short OOV words spell
 * out via dict letter lookup (see phonemizeWord layer 5b).
 */
function getHans00(): Hans00 | null {
  if (hans00Loaded) return hans00Lib;
  hans00Loaded = true;
  const isHermesDebug =
    isDev &&
    typeof globalThis !== 'undefined' &&
    (globalThis as {HermesInternal?: unknown}).HermesInternal != null;
  if (isHermesDebug) {
    log.warn(
      'Skipping phonemize load on Hermes debug: Metro reports the known ' +
        'en-g2p bytecode-encoding failure to ExceptionsManager before our ' +
        'try/catch can absorb it. OOV short tokens will spell out via dict; ' +
        'longer OOV words will pass through. Use a release build for full ' +
        'G2P coverage.',
    );
    return null;
  }
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
      return null;
    }
    hans00Lib = required;
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

/**
 * Dict overrides — transient bugfix hatch, NOT a pronunciation store.
 *
 * Consulted before the dict lookup so an entry here takes priority. Use
 * only when we need to correct a specific known-wrong dict entry while
 * the upstream fix is in flight; each entry should carry a TODO pointing
 * at the upstream fix that will let us remove it.
 *
 * Pronunciations belong in the dict (palshub/phonemizer-dicts), not here.
 * Adding general-purpose entries to this map is architectural drift —
 * over time it becomes a parallel pronunciation source that silently
 * diverges from the dict. Resist the temptation.
 *
 * Currently empty: the 48-entry dict update on 2026-04-20 absorbed the
 * former interjection overlay (hmm, mhm, shh, mmm, pfft, brr, psst, ew).
 */
const DICT_OVERRIDES: Record<string, string> = {};

// --- Helpers ---

/**
 * Phonotactic "unpronounceable" check. A word is unpronounceable (and
 * should be spelled letter-by-letter) when its first vowel appears past
 * the typical maximum consonant onset for English (~3 — per the Maximal
 * Onset Principle, English syllable onsets can be at most 3 consonants,
 * e.g. "spl-", "str-", "scr-"), so any pronounceable word must have a
 * vowel within the first 4 characters.
 *
 * Standard phonotactic reasoning, independently implemented here; the same
 * principle appears across TTS systems (Festival, Flite, espeak-ng).
 *
 * Replaces the length-based SHORT_ACRONYM heuristic, which misfired on
 * interjections (hmm, shh) and short real words / model names (himm, Qwen,
 * Phi). Case is irrelevant — `ml`, `ML`, `Ml` all spell out equally.
 *
 *   "ml"    → no vowel → unpronounceable → spell out ✓
 *   "xlm"   → no vowel → unpronounceable → spell out ✓
 *   "hmm"   → no vowel → unpronounceable (but dict has it as 'həm') ✓
 *   "himm"  → 'i' at pos 2 → pronounceable → G2P or passthrough ✓
 *   "qwen"  → 'e' at pos 3 → pronounceable ✓
 *   "phi"   → 'i' at pos 3 → pronounceable ✓
 *
 * Treats 'y' as a vowel — standard treatment for English phonotactic
 * classification where y functions as a secondary vowel. Keeps "yi"
 * pronounceable.
 */
const MAX_CONSONANT_ONSET = 3;
function isUnpronounceable(clean: string): boolean {
  if (clean.length < 2) return false;
  const firstVowel = clean.search(/[aeiouy]/);
  return firstVowel === -1 || firstVowel >= MAX_CONSONANT_ONSET + 1;
}

/**
 * Returns true if `s` looks like raw ASCII (letters + apostrophes only) —
 * i.e. no IPA-distinct characters. Used to detect when hans00 returned a
 * non-IPA string (echo of input, or G2P gibberish like "ksm" for "xlm")
 * instead of a real phoneme transcription.
 */
function looksLikeAscii(s: string): boolean {
  return s.length > 0 && /^[A-Za-z']+$/.test(s);
}

/**
 * Spell out a short token letter-by-letter. Tries dict first (most accurate
 * for the target voice), then hans00 with the uppercase letter. Returns
 * `null` if any letter can't be resolved to IPA — caller can then decide
 * whether to fall through to passthrough rather than emit a half-spelled
 * mess like "ɛm q" for "mq" with q missing.
 */
function spellOutLetters(
  clean: string,
  dict: DictSource,
  hans00: Hans00 | null,
): string | null {
  const out: string[] = [];
  for (const letter of clean) {
    const fromDict = dict.lookup(letter);
    if (fromDict) {
      out.push(fromDict);
      continue;
    }
    if (hans00) {
      const fromHans = hans00.toIPA(letter.toUpperCase(), {stripStress: false});
      if (fromHans && !looksLikeAscii(fromHans)) {
        out.push(fromHans);
        continue;
      }
    }
    return null;
  }
  return out.join(' ');
}

/**
 * Hyphen-joined single letters ("U-S-", "a-m-", "A-B") — the form the text
 * normalizers give dotted acronyms. Spelled before the dict lookup, since
 * the joined letters often collide with a real word ("us", "am").
 */
const LETTER_SEQUENCE = /^(?:[A-Za-z]-)+[A-Za-z]?-?$/;

/**
 * Contraction suffixes for apostrophe words the dict doesn't know
 * ("should've", "Claude'll"): dict base + suffix IPA.
 */
const CONTRACTION_SUFFIXES: [string, string][] = [
  ["n't", 'ənt'],
  ["'ve", 'v'],
  ["'re", 'ɚ'],
  ["'ll", 'l'],
  ["'d", 'd'],
  ["'m", 'm'],
];

/** Contractions whose base isn't a word ("shan't" ← "shall not"). */
const IRREGULAR_CONTRACTIONS: Record<string, string> = {"shan't": 'ʃˈænt'};

/** English -s allomorph after a base pronunciation: ɪz / s / z. */
function sSuffix(baseIpa: string): string {
  const last = baseIpa.replace(/[ˈˌː]/g, '').slice(-2);
  if (/(?:s|z|ʃ|ʒ|tʃ|dʒ)$/.test(last)) return 'ɪz';
  if (/[ptkfθ]$/.test(last)) return 's';
  return 'z';
}

/** hans00 often marks every syllable primary; keep only the first. */
function singlePrimaryStress(ipa: string): string {
  return ipa
    .split(' ')
    .map(word => {
      const first = word.indexOf('ˈ');
      if (first === -1) return word;
      return (
        word.slice(0, first + 1) + word.slice(first + 1).replace(/ˈ/g, 'ˌ')
      );
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

  // 0. Letter sequences ("U-S-") spell out, ahead of the dict.
  if (clean.length >= 2 && LETTER_SEQUENCE.test(word)) {
    const spelled = spellOutLetters(clean, dict, hans00);
    if (spelled !== null) return spelled;
  }

  // 1. REDUCED_FORMS take priority
  const reduced = REDUCED_FORMS[clean];
  if (reduced) return reduced;

  // 1b. DICT_OVERRIDES — runs before dict lookup so we can patch a
  // known-wrong upstream entry in-code while the dict fix ships.
  // Empty by default; see the constant's docstring.
  const override = DICT_OVERRIDES[clean];
  if (override) return override;

  // 2. Dict lookup (already done by caller)
  let ipa: string | null = primaryHit;

  // 3. Hyphen-split compounds
  if (!ipa && word.includes('-')) {
    const parts = word.split('-').filter(Boolean);
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
    if (baseIpa) ipa = baseIpa + sSuffix(baseIpa);
  }

  // 4a. Plural possessive ("teammates'") sounds like the plural.
  if (!ipa && clean.length > 1 && clean.endsWith("'")) {
    ipa = dict.lookup(clean.slice(0, -1));
  }

  // 4b. Other contractions: dict base + suffix ("should've" → should + v).
  if (!ipa && IRREGULAR_CONTRACTIONS[clean])
    ipa = IRREGULAR_CONTRACTIONS[clean]!;
  if (!ipa && clean.includes("'")) {
    const match = CONTRACTION_SUFFIXES.find(([sfx]) => clean.endsWith(sfx));
    const baseIpa = match && dict.lookup(clean.slice(0, -match[0].length));
    if (match && baseIpa) ipa = baseIpa + match[1];
  }

  // 4c. Acronym plurals ("GPUs", "LLMs"): spell the letters, add z.
  // Kokoro's normalizer rewrites these as "GPU'S".
  if (!ipa && /^[A-Z]{2,5}(?:'?s|'S)$/.test(word)) {
    const spelled = spellOutLetters(clean.replace(/'?s$/, ''), dict, hans00);
    if (spelled !== null) ipa = spelled + 'z';
  }

  // 4d. Regular plural of a dict word ("embeddings").
  if (!ipa && clean.length > 3 && /[^s']s$/.test(clean)) {
    const baseIpa = dict.lookup(clean.slice(0, -1));
    if (baseIpa) ipa = baseIpa + sSuffix(baseIpa);
  }

  // Two spellout triggers, each independent:
  //
  //   forceSpellOut — word was typed as short all-caps ("GPU", "NSA",
  //     "AWS"). A strong user signal that they mean the acronym, not a
  //     word. Overrides hans00 even when hans00 produced IPA-looking
  //     output (hans00 transcribes AWS → "ɔz" like "awes", which is
  //     rarely what the user wanted).
  //
  //   fallbackSpellOut — hans00 echoed ASCII (failed G2P) AND the word
  //     is phonotactically unpronounceable. Catches lowercase vowelless
  //     inputs ("ml", "xlm") when they reach hans00 without being caught
  //     by the overlay.
  const forceSpellOut = /^[A-Z]{2,4}$/.test(word);

  // 4e. Elongated words ("noooo", "sooo", "whyyy"): collapse letter runs
  // of 3+ and retry the dict.
  if (!ipa && /([a-z])\1\1/.test(clean) && !/^(.)\1+$/.test(clean)) {
    for (const rep of ['$1', '$1$1']) {
      const collapsed = clean.replace(/([a-z])\1{2,}/g, rep);
      if (collapsed.length > 1) ipa = dict.lookup(collapsed);
      if (ipa) break;
    }
  }

  // 5. hans00 G2P fallback (full neural-style coverage when available).
  // Lowercased unless it's the short all-caps acronym case: hans00 spells
  // any all-caps input letter by letter ("COVID" → C-O-V-I-D).
  if (!ipa && hans00) {
    let g2p = hans00.toIPA(forceSpellOut ? word : word.toLowerCase(), {
      stripStress: false,
    });
    g2p = g2p.replace(/- /g, '').replace(/ɫ/g, 'l');

    // Vowelless tokens ("gpt", "npm", "sql") are acronyms even when hans00
    // returns IPA-looking output for them ("gpt" → "ɡt").
    // Drawn-out interjections ("shhh", "grrr", "zzz") are not acronyms.
    const fallbackSpellOut =
      (looksLikeAscii(g2p) && isUnpronounceable(clean)) ||
      (clean.length >= 2 &&
        !/[aeiouy]/.test(clean) &&
        !/([^w])\1\1/.test(clean) &&
        clean !== 'sh');
    if (forceSpellOut || fallbackSpellOut) {
      const spelled = spellOutLetters(clean, dict, hans00);
      if (spelled !== null) {
        g2p = spelled;
        log.debug(
          `acronym fallback (${forceSpellOut ? 'all-caps' : 'hans00 non-IPA'}): ${JSON.stringify(word)} -> ${JSON.stringify(g2p)}`,
        );
      }
    }

    ipa = singlePrimaryStress(relocateStress(g2p));
  }

  // 5b. Dict-only spellout when hans00 isn't available (Hermes debug
  // bytecode failure). Without this, "ml"/"xlm" pass through as literal
  // ASCII letters and the audio model emits silence. Uses the phonotactic
  // check plus the all-caps typographic signal — "GPU" (all-caps) spells
  // out, while "himm"/"Qwen" pass through for the phonemizer. Vowelless
  // interjections (hmm, shh) normally hit the dict at Layer 2 before
  // reaching this point.
  if (!ipa && (forceSpellOut || isUnpronounceable(clean))) {
    const spelled = spellOutLetters(clean, dict, null);
    if (spelled !== null) {
      ipa = spelled;
      log.debug(
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
              !DICT_OVERRIDES[clean] &&
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
            // getHans00() is module-cached (idempotent after first call)
            // and returns null if unavailable — no per-call wrapper needed.
            ipaWords.push(
              phonemizeWord(
                w,
                dict,
                primaryHit,
                needsHans ? getHans00() : null,
              ),
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
