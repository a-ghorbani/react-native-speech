/**
 * JsPhonemizer - GPL-free phonemizer using hans00/phonemize (MIT)
 *
 * Configurable for different TTS engines:
 * - Kokoro (Misaki mode): maps IPA → Misaki phoneme set, strips stress
 * - Kitten/others (IPA mode): outputs standard IPA with stress marks
 *
 * IPA → Misaki mapping (when enabled):
 * - Diphthongs: eɪ→A, aɪ→I, oʊ→O, aʊ→W, ɔɪ→Y, əʊ→Q (GB)
 * - R-colored vowels: ɝ→ɜɹ, ɚ→əɹ
 * - Dark L: ɫ→l
 * - Affricates: tʃ→ʧ, dʒ→ʤ
 */

import {
  type IPhonemizer,
  splitOnPunctuation,
  rejoinChunks,
  postProcessPhonemes,
} from './Phonemizer';
import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('TTS', 'JsPhonemizer');

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
  result = result.replace(/ɝ/g, 'ɜɹ'); // stressed r-colored → ɜɹ
  result = result.replace(/ɚ/g, 'əɹ'); // unstressed r-colored → əɹ

  // --- Consonant mappings ---
  result = result.replace(/ɫ/g, 'l'); // Dark L → regular L
  result = result.replace(/tʃ/g, 'ʧ'); // Affricates
  result = result.replace(/dʒ/g, 'ʤ');

  // Glottal stop: ʔ → t (Misaki convention for US)
  if (isUS) {
    result = result.replace(/ʔ/g, 't');
  }

  return result;
}

/**
 * Configuration for JsPhonemizer behavior.
 */
export interface JsPhonemizeOptions {
  /**
   * Map IPA output to Misaki phoneme set (diphthong shorthands, affricates, etc.)
   * Enable for Kokoro, disable for engines trained on standard IPA (e.g., Kitten).
   * Default: true
   */
  misakiMapping?: boolean;

  /**
   * Strip stress marks from output.
   * hans00/phonemize places stress at word boundaries (ˈbɪlt) instead of before
   * the vowel nucleus (bˈɪlt). For Kokoro, wrong stress sounds worse than no stress.
   * For Kitten, stress marks are in the vocab and may still be useful.
   * Default: true
   */
  stripStress?: boolean;

  /**
   * Apply Kokoro-specific post-processing (r→ɹ normalization, "kokoro" fix, etc.)
   * Disable for engines that don't need Kokoro-specific corrections.
   * Default: true
   */
  kokoroPostProcess?: boolean;
}

/**
 * GPL-free JS phonemizer using hans00/phonemize (MIT license).
 * No native dependencies, no GPL code, cross-platform (iOS + Android).
 *
 * Pipeline:
 * 1. Split on punctuation
 * 2. Phonemize non-punctuation chunks via hans00/phonemize
 * 3. Apply IPA cleanup (hyphen joining, dark L) and optionally Misaki mapping
 * 4. Rejoin and optionally apply Kokoro post-processing
 */
export class JsPhonemizer implements IPhonemizer {
  private readonly options: Required<JsPhonemizeOptions>;

  constructor(options?: JsPhonemizeOptions) {
    this.options = {
      misakiMapping: options?.misakiMapping ?? true,
      stripStress: options?.stripStress ?? true,
      kokoroPostProcess: options?.kokoroPostProcess ?? true,
    };
  }

  async phonemize(text: string, language: string): Promise<string> {
    try {
      log.debug(
        `JS phonemization: lang=${language}, text="${text.substring(0, 50)}..."`,
      );

      const lib = getPhonemizeLib();

      const chunks = splitOnPunctuation(text);

      for (const chunk of chunks) {
        if (!chunk.isPunctuation && chunk.text.trim()) {
          let ipa = lib.toIPA(chunk.text, {
            stripStress: this.options.stripStress,
          });

          // Hyphen cleanup — always applied
          ipa = ipa.replace(/- /g, '');
          // Dark L → regular L — always applied (espeak-ng doesn't distinguish either)
          ipa = ipa.replace(/ɫ/g, 'l');

          if (this.options.misakiMapping) {
            ipa = ipaToMisaki(ipa, language);
          }

          (
            chunk as {isPunctuation: boolean; text: string; phoneme?: string}
          ).phoneme = ipa;
        }
      }

      const rejoined = rejoinChunks(
        chunks as {isPunctuation: boolean; text: string; phoneme?: string}[],
      );

      if (this.options.kokoroPostProcess) {
        const processed = postProcessPhonemes(rejoined, language);
        log.debug(`Phonemization complete: ${processed.length} chars`);
        return processed;
      }

      const result = rejoined.trim();
      log.debug(`Phonemization complete: ${result.length} chars`);
      return result;
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
