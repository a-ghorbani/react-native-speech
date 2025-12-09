/**
 * Phonemizer - Converts text to phonemes (G2P - Grapheme to Phoneme)
 *
 * This is a CRITICAL component for Kokoro TTS. The model is trained on phonemes,
 * not raw text. Without phonemization, the model receives the wrong input format
 * and quality will be significantly degraded.
 */

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
 */
export class NativePhonemizer implements IPhonemizer {
  async phonemize(text: string, language: string): Promise<string> {
    try {
      console.log('[NativePhonemizer] Using NATIVE espeak-ng phonemizer');
      console.log('[NativePhonemizer] Input text:', text);
      console.log('[NativePhonemizer] Language:', language);

      const TurboSpeech = require('../../NativeSpeech').default;
      const phonemes = await TurboSpeech.phonemize(text, language);

      console.log('[NativePhonemizer] Phonemes output:', phonemes);
      return phonemes;
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
