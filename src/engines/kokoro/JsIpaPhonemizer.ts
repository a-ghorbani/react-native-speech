/**
 * JsIpaPhonemizer - GPL-free phonemizer outputting standard IPA
 *
 * Unlike JsPhonemizer (which maps to Misaki phonemes for Kokoro),
 * this outputs standard IPA suitable for engines trained on espeak-ng
 * output (e.g., Kitten/StyleTTS 2).
 *
 * Only applies minimal cleanup (hyphen handling, dark L normalization)
 * without Kokoro-specific transforms.
 */

import {type IPhonemizer, splitOnPunctuation, rejoinChunks} from './Phonemizer';
import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('TTS', 'JsIpaPhonemizer');

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
        'phonemize package is required for JsIpaPhonemizer.\n\n' +
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
 * Minimal IPA cleanup for hans00/phonemize output.
 * Only fixes formatting issues, does NOT remap to Misaki phoneme set.
 */
function cleanIpa(ipa: string): string {
  let result = ipa;

  // Hyphen cleanup: "high-" in "high-performance" → join compound words
  result = result.replace(/- /g, '');

  // Dark L → regular L (espeak-ng doesn't distinguish either)
  result = result.replace(/ɫ/g, 'l');

  return result;
}

/**
 * Standard IPA phonemizer using hans00/phonemize (MIT license).
 * Outputs standard IPA with stress marks — suitable for engines
 * trained on espeak-ng output (e.g., Kitten/StyleTTS 2).
 *
 * Pipeline:
 * 1. Split on punctuation
 * 2. Phonemize non-punctuation chunks (standard IPA with stress)
 * 3. Minimal cleanup (hyphens, dark L)
 * 4. Rejoin — no Kokoro-specific post-processing
 */
export class JsIpaPhonemizer implements IPhonemizer {
  async phonemize(text: string, language: string): Promise<string> {
    try {
      log.debug(
        `JS IPA phonemization: lang=${language}, text="${text.substring(0, 50)}..."`,
      );

      const lib = getPhonemizeLib();

      const chunks = splitOnPunctuation(text);

      for (const chunk of chunks) {
        if (!chunk.isPunctuation && chunk.text.trim()) {
          // Keep stress marks — Kitten's vocab includes ˈ and ˌ
          const rawIpa = lib.toIPA(chunk.text);
          (
            chunk as {isPunctuation: boolean; text: string; phoneme?: string}
          ).phoneme = cleanIpa(rawIpa);
        }
      }

      const rejoined = rejoinChunks(
        chunks as {isPunctuation: boolean; text: string; phoneme?: string}[],
      );

      const result = rejoined.trim();
      log.debug(`Phonemization complete: ${result.length} chars`);
      return result;
    } catch (error) {
      log.error(
        `JS IPA phonemization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error instanceof Error) {
        throw new Error(`JS IPA phonemization failed: ${error.message}`);
      }
      throw error;
    }
  }
}
