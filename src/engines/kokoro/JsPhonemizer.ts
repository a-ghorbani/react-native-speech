/**
 * JsPhonemizer - GPL-free phonemizer using hans00/phonemize (MIT)
 *
 * Wraps the pure-JS phonemize library and maps its standard IPA output
 * to Misaki's phoneme set (which Kokoro was trained on).
 *
 * Key differences between hans00/phonemize IPA and Misaki phonemes:
 * - Diphthongs: standard IPA (eɪ, aɪ, oʊ, aʊ, ɔɪ) → Misaki shorthands (A, I, O, W, Y)
 * - R-colored vowels: ɝ → ɜɹ
 * - Dark L: ɫ → l (Kokoro doesn't distinguish)
 * - Affricates: tʃ → ʧ, dʒ → ʤ
 */

import {
  type IPhonemizer,
  splitOnPunctuation,
  rejoinChunks,
  postProcessPhonemes,
} from './Phonemizer';
import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('Kokoro', 'JsPhonemizer');

// Lazy-loaded phonemize reference
let phonemizeLib: {
  toIPA: (text: string, options?: {stripStress?: boolean}) => string;
} | null = null;

function getPhonemizeLib(): {
  toIPA: (text: string, options?: {stripStress?: boolean}) => string;
} {
  if (!phonemizeLib) {
    try {
      phonemizeLib = require('phonemize');
    } catch (e) {
      const isBytecodeError =
        e instanceof SyntaxError &&
        String(e.message).includes('encoding bytecode');
      if (isBytecodeError) {
        throw new Error(
          'phonemize failed to load in Hermes debug mode (dictionary too large for on-the-fly bytecode compilation). ' +
            "Use phonemizerType: 'native' for debug builds, or test with a release build.",
        );
      }
      throw new Error(
        'phonemize package is required for JsPhonemizer.\n\n' +
          'Install it with:\n' +
          '  npm install phonemize\n' +
          '  # or\n' +
          '  yarn add phonemize',
      );
    }
  }
  return phonemizeLib!;
}

/**
 * Map standard IPA output from hans00/phonemize to Misaki phoneme set.
 *
 * Replacements are ordered longest-match-first to avoid partial matches
 * (e.g., 'aɪ' must be matched before 'a').
 */
export function ipaToMisaki(ipa: string, language: string): string {
  const isUS = language === 'en-us' || language === 'a';

  let result = ipa;

  // --- Hyphen cleanup ---
  // hans00/phonemize outputs trailing hyphens for compound words (e.g., "high-" in "high-performance")
  // Remove them so Kokoro doesn't see breaks in compound words
  result = result.replace(/- /g, '');

  // --- Diphthongs (must come before single-vowel mappings) ---
  result = result.replace(/eɪ/g, 'A'); // "take" eɪ → A
  result = result.replace(/aɪ/g, 'I'); // "bike" aɪ → I
  result = result.replace(/ɔɪ/g, 'Y'); // "boy"  ɔɪ → Y
  result = result.replace(/aʊ/g, 'W'); // "how"  aʊ → W

  if (isUS) {
    result = result.replace(/oʊ/g, 'O'); // "boat" oʊ → O (US)
  } else {
    result = result.replace(/əʊ/g, 'Q'); // "boat" əʊ → Q (GB)
  }

  // --- R-colored vowels ---
  // ɝ (stressed r-colored) → ɜɹ
  result = result.replace(/ɝ/g, 'ɜɹ');
  // ɚ (unstressed r-colored schwa) → əɹ
  result = result.replace(/ɚ/g, 'əɹ');

  // --- Consonant mappings ---
  // Dark L → regular L (Kokoro doesn't distinguish)
  result = result.replace(/ɫ/g, 'l');

  // Affricates: hans00 may output tʃ/dʒ; Misaki uses ʧ/ʤ
  result = result.replace(/tʃ/g, 'ʧ');
  result = result.replace(/dʒ/g, 'ʤ');

  // Glottal stop: ʔ → t (Misaki convention for US)
  if (isUS) {
    result = result.replace(/ʔ/g, 't');
  }

  return result;
}

/**
 * Pure JS phonemizer using hans00/phonemize (MIT license).
 * No native dependencies, no GPL code, cross-platform (iOS + Android).
 *
 * Follows the same pipeline as NativePhonemizer:
 * 1. Split on punctuation
 * 2. Phonemize non-punctuation chunks
 * 3. Rejoin
 * 4. Post-process for Kokoro compatibility
 */
export class JsPhonemizer implements IPhonemizer {
  async phonemize(text: string, language: string): Promise<string> {
    try {
      log.debug(
        `JS phonemization: lang=${language}, text="${text.substring(0, 50)}..."`,
      );

      const lib = getPhonemizeLib();

      // Split text on punctuation to preserve punctuation marks
      const chunks = splitOnPunctuation(text);
      log.debug(`Split into ${chunks.length} chunks`);

      // Phonemize each non-punctuation chunk
      for (const chunk of chunks) {
        if (!chunk.isPunctuation && chunk.text.trim()) {
          // Strip stress entirely — hans00/phonemize places stress marks at
          // word boundaries (ˈbɪlt) instead of before the vowel nucleus (bˈɪlt)
          // as Kokoro expects. Wrong stress sounds worse than no stress.
          const rawIpa = lib.toIPA(chunk.text, {stripStress: true});
          const misakiPhonemes = ipaToMisaki(rawIpa, language);
          (
            chunk as {isPunctuation: boolean; text: string; phoneme?: string}
          ).phoneme = misakiPhonemes;
        }
      }

      // Rejoin chunks (punctuation passes through unchanged)
      const rejoined = rejoinChunks(
        chunks as {isPunctuation: boolean; text: string; phoneme?: string}[],
      );

      // Post-process for Kokoro TTS compatibility
      const processed = postProcessPhonemes(rejoined, language);

      log.debug(`Phonemization complete: ${processed.length} chars`);
      return processed;
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
