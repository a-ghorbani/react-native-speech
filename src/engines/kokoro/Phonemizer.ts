/**
 * Phonemizer - Converts text to phonemes (G2P - Grapheme to Phoneme)
 *
 * This is a CRITICAL component for Kokoro TTS. The model is trained on phonemes,
 * not raw text. Without phonemization, the model receives the wrong input format
 * and quality will be significantly degraded.
 */

import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('Kokoro', 'Phonemizer');

/**
 * Escapes regular expression special characters from a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Punctuation characters that are preserved during phonemization
 */
const PUNCTUATION = ';:,.!?¡¿—…"«»""(){}[]';
export const PUNCTUATION_PATTERN = new RegExp(
  `(\\s*[${escapeRegExp(PUNCTUATION)}]+\\s*)+`,
  'g',
);

/**
 * Split text on punctuation pattern, preserving the delimiters
 * Based on: https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/phonemize.js#L10
 */
export function splitOnPunctuation(
  text: string,
): {isPunctuation: boolean; text: string}[] {
  const result: {isPunctuation: boolean; text: string}[] = [];
  let prev = 0;

  for (const match of text.matchAll(PUNCTUATION_PATTERN)) {
    const fullMatch = match[0];
    const index = match.index!;

    if (prev < index) {
      result.push({isPunctuation: false, text: text.slice(prev, index)});
    }
    if (fullMatch.length > 0) {
      result.push({isPunctuation: true, text: fullMatch});
    }
    prev = index + fullMatch.length;
  }

  if (prev < text.length) {
    result.push({isPunctuation: false, text: text.slice(prev)});
  }

  return result;
}

/**
 * Rejoin phonemized chunks into a single string
 * Punctuation chunks are kept as-is, phoneme chunks are joined
 */
export function rejoinChunks(
  chunks: {isPunctuation: boolean; text: string; phoneme?: string}[],
): string {
  return chunks
    .map(chunk => (chunk.isPunctuation ? chunk.text : chunk.phoneme || ''))
    .join('');
}

/**
 * Post-process phonemes for Kokoro TTS compatibility
 * Exported separately for testing and reuse
 * Based on: https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/phonemize.js#L174
 */
export function postProcessPhonemes(
  phonemes: string,
  language: string,
): string {
  let processed = phonemes
    // Fix kokoro pronunciation (Japanese word)
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    // Normalize phoneme symbols for Kokoro
    // ʲ (palatalization) - remove entirely (espeak version difference)
    // kokoro.js converts ʲ→j but their espeak doesn't output ʲ in these positions
    // Our espeak outputs ʲ in places like "libraryʲ", "ɹɪʲækt" where it shouldn't be
    .replace(/ʲ/g, '')
    .replace(/r/g, 'ɹ') // Normalize r-sounds
    .replace(/x/g, 'k') // Normalize velar fricative
    .replace(/ɬ/g, 'l') // Normalize lateral fricative
    // Add space before "hundred" when preceded by vowel/r
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    // Fix trailing z before punctuation
    .replace(/ z(?=[;:,.!?¡¿—…"«»"" ]|$)/g, 'z');

  // Additional post-processing for American English
  if (language === 'en-us' || language === 'a') {
    processed = processed
      // ninety -> nindi
      .replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di')
      // fˈɔːɹ -> fˈoːɹ (four)
      .replace(/fˈɔːɹ/g, 'fˈoːɹ');
  }

  return processed.trim();
}

/**
 * Interface for phonemization implementations
 */
export interface IPhonemizer {
  /**
   * Convert text to phonemes
   * @param text The input text
   * @param language Language code (e.g., 'en-us', 'en-gb')
   * @returns Phoneme string in IPA format
   */
  phonemize(text: string, language: string): Promise<string>;
}

/**
 * Pass-through phonemizer (no phonemization)
 * Used when raw text input is desired (not recommended for Kokoro)
 */
export class NoOpPhonemizer implements IPhonemizer {
  async phonemize(text: string, _language: string): Promise<string> {
    log.warn(
      'Using NO-OP phonemizer - text passed through without phonemization',
    );
    return text;
  }
}

/**
 * Native phonemizer using espeak-ng
 * Uses Turbo Module for native G2P conversion
 *
 * Features:
 * - Direct phonemization via espeak-ng
 * - Loop-based clause handling (concatenates all clauses)
 * - Post-processing for Kokoro TTS compatibility
 * - Thread-safe native implementation
 *
 * Note: Text normalization should be done BEFORE calling phonemize()
 * (e.g., in KokoroEngine using TextNormalizer)
 */
export class NativePhonemizer implements IPhonemizer {
  async phonemize(text: string, language: string): Promise<string> {
    try {
      log.debug(
        `Native phonemization: lang=${language}, text="${text.substring(0, 50)}..."`,
      );

      // Split text on punctuation to preserve punctuation marks
      // espeak-ng strips punctuation, so we need to handle it separately
      const chunks = splitOnPunctuation(text);
      log.debug(`Split into ${chunks.length} chunks`);

      // Phonemize each non-punctuation chunk via espeak-ng
      const TurboSpeech = require('../../NativeSpeech').default;
      for (const chunk of chunks) {
        if (!chunk.isPunctuation && chunk.text.trim()) {
          const rawPhoneme = await TurboSpeech.phonemize(chunk.text, language);
          (
            chunk as {isPunctuation: boolean; text: string; phoneme?: string}
          ).phoneme = rawPhoneme;
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
        `Native phonemization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error instanceof Error) {
        throw new Error(`Native phonemization failed: ${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * Phonemizer type options
 */
export type PhonemizerType = 'js' | 'js-ipa' | 'native' | 'none';

/**
 * Factory function to create the appropriate phonemizer
 *
 * @param type - Phonemizer type: 'native' for espeak-ng, 'none' for pass-through
 * @returns Configured phonemizer instance
 */
export function createPhonemizer(type: PhonemizerType): IPhonemizer {
  log.debug(`Creating phonemizer: type=${type}`);

  switch (type) {
    case 'js': {
      const {JsPhonemizer} = require('./JsPhonemizer');
      return new JsPhonemizer();
    }
    case 'js-ipa': {
      const {JsPhonemizer} = require('./JsPhonemizer');
      return new JsPhonemizer({
        misakiMapping: false,
        stripStress: false,
        relocateStress: true,
        kokoroPostProcess: false,
      });
    }
    case 'native':
      return new NativePhonemizer();
    case 'none':
      return new NoOpPhonemizer();
    default:
      log.warn(
        `Unknown phonemizer type "${type}", defaulting to NoOpPhonemizer`,
      );
      return new NoOpPhonemizer();
  }
}
