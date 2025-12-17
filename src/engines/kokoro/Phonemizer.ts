/**
 * Phonemizer - Converts text to phonemes (G2P - Grapheme to Phoneme)
 *
 * This is a CRITICAL component for Kokoro TTS. The model is trained on phonemes,
 * not raw text. Without phonemization, the model receives the wrong input format
 * and quality will be significantly degraded.
 */

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
 * Remote phonemizer using the phonemization API server
 * Uses the existing endpoint at http://localhost:3000/api/phonemize
 */
export class RemotePhonemizer implements IPhonemizer {
  private serverUrl: string;

  constructor(serverUrl: string = 'http://192.168.0.82:3000') {
    this.serverUrl = serverUrl;
  }

  async phonemize(text: string, language: string): Promise<string> {
    try {
      console.log('[RemotePhonemizer] Using REMOTE phonemizer');
      console.log('[RemotePhonemizer] Server URL:', this.serverUrl);
      console.log('[RemotePhonemizer] Input text:', text);
      console.log('[RemotePhonemizer] Language:', language);

      const response = await fetch(`${this.serverUrl}/api/phonemize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          language,
        }),
      });
      console.log('[RemotePhonemizer] Response status:', response.status);

      if (!response.ok) {
        throw new Error(
          `Phonemization failed: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();
      console.log('[RemotePhonemizer] Response data:', data);

      // Handle different response formats
      let phonemes: string;
      if (typeof data === 'string') {
        phonemes = data;
      } else if (data.phonemes) {
        phonemes = data.phonemes;
      } else if (data.result) {
        phonemes = data.result;
      } else {
        throw new Error('Invalid response format from phonemization server');
      }

      console.log('[RemotePhonemizer] Phonemes output:', phonemes);
      return phonemes;
    } catch (error) {
      console.error('[RemotePhonemizer] Error:', error);
      if (error instanceof Error) {
        throw new Error(`Phonemization error: ${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * Pass-through phonemizer (no phonemization)
 * This maintains current behavior for backward compatibility
 */
export class NoOpPhonemizer implements IPhonemizer {
  async phonemize(text: string, _language: string): Promise<string> {
    console.log('[NoOpPhonemizer] WARNING: Using NO-OP phonemizer');
    console.log('[NoOpPhonemizer] Passing text directly without phonemization');
    console.log('[NoOpPhonemizer] Input text:', text);
    console.log('[NoOpPhonemizer] Output (same as input):', text);
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
      console.log('[NativePhonemizer] Using NATIVE espeak-ng phonemizer');
      console.log('[NativePhonemizer] Input text:', text);
      console.log('[NativePhonemizer] Language:', language);

      // Step 1: Split text on punctuation to preserve punctuation marks
      // espeak-ng strips punctuation, so we need to handle it separately
      const chunks = splitOnPunctuation(text);
      console.log('[NativePhonemizer] Split into', chunks.length, 'chunks');

      // Step 2: Phonemize each non-punctuation chunk via espeak-ng
      const TurboSpeech = require('../../NativeSpeech').default;
      for (const chunk of chunks) {
        if (!chunk.isPunctuation && chunk.text.trim()) {
          const rawPhoneme = await TurboSpeech.phonemize(chunk.text, language);
          (
            chunk as {isPunctuation: boolean; text: string; phoneme?: string}
          ).phoneme = rawPhoneme;
        }
      }

      // Step 3: Rejoin chunks (punctuation passes through unchanged)
      const rejoined = rejoinChunks(
        chunks as {isPunctuation: boolean; text: string; phoneme?: string}[],
      );
      console.log('[NativePhonemizer] Rejoined phonemes:', rejoined);

      // Step 4: Post-process for Kokoro TTS compatibility
      const processed = postProcessPhonemes(rejoined, language);

      console.log('[NativePhonemizer] Processed phonemes:', processed);
      return processed;
    } catch (error) {
      console.error('[NativePhonemizer] Error:', error);
      if (error instanceof Error) {
        throw new Error(`Native phonemization failed: ${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * Factory function to create the appropriate phonemizer
 */
export function createPhonemizer(
  type: 'remote' | 'native' | 'none',
  serverUrl?: string,
): IPhonemizer {
  console.log('[Phonemizer Factory] Creating phonemizer of type:', type);
  if (type === 'remote') {
    console.log('[Phonemizer Factory] Server URL:', serverUrl);
  }

  switch (type) {
    case 'remote':
      console.log('[Phonemizer Factory] Creating RemotePhonemizer');
      return new RemotePhonemizer(serverUrl);
    case 'native':
      console.log('[Phonemizer Factory] Creating NativePhonemizer');
      return new NativePhonemizer();
    case 'none':
      console.log('[Phonemizer Factory] Creating NoOpPhonemizer');
      return new NoOpPhonemizer();
    default:
      console.log(
        '[Phonemizer Factory] Unknown type, defaulting to NoOpPhonemizer',
      );
      return new NoOpPhonemizer();
  }
}
