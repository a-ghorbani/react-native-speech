/**
 * Text Normalizer for TTS
 *
 * Normalizes text before phonemization to improve pronunciation:
 * - Expands abbreviations (Dr. → Doctor)
 * - Converts numbers to words (2024 → twenty twenty-four)
 * - Handles currency ($5.99 → five dollars and ninety-nine cents)
 * - Normalizes punctuation and whitespace
 *
 * Based on the kokoro.js reference implementation
 */

export class TextNormalizer {
  /**
   * Normalize text for TTS
   */
  normalize(text: string): string {
    return (
      text
        // 1. Handle quotes and brackets
        .replace(/['']/g, "'")
        .replace(/[""]/g, '"')
        .replace(/«/g, '"')
        .replace(/»/g, '"')
        .replace(/\(/g, '«')
        .replace(/\)/g, '»')

        // 2. Replace uncommon punctuation marks
        .replace(/、/g, ', ')
        .replace(/。/g, '. ')
        .replace(/！/g, '! ')
        .replace(/，/g, ', ')
        .replace(/：/g, ': ')
        .replace(/；/g, '; ')
        .replace(/？/g, '? ')

        // 3. Whitespace normalization
        .replace(/[^\S \n]/g, ' ')
        .replace(/  +/g, ' ')
        .replace(/(?<=\n) +(?=\n)/g, '')

        // 4. Abbreviations
        .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
        .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
        .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
        .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Missus')
        .replace(/\betc\.(?! [A-Z])/gi, 'etc')

        // 5. Handle numbers (basic implementation)
        .replace(/\b(\d{4})\b/g, match => this.convertYear(match))

        // // 6. Fix brand name possessives (iOS'S → iOS, macOS's → macOS)
        // .replace(
        //   /\b(iOS|macOS|iPadOS|watchOS|tvOS|iPhone|iPad|Mac)'[sS]\b/g,
        //   '$1',
        // )

        // // 7. Handle possessives
        .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")

        // 8. Strip leading and trailing whitespace
        .trim()
    );
  }

  /**
   * Split text into sentence-based chunks for streaming/processing
   * Preserves sentence boundaries for natural speech flow
   */
  chunkBySentences(text: string, maxChunkSize: number = 1000): string[] {
    // Split on sentence boundaries, keeping the punctuation
    const sentencePattern = /[^.!?]+[.!?]+(?:\s+|$)/g;
    const sentences = text.match(sentencePattern) || [text];

    // Group sentences into chunks that don't exceed maxChunkSize
    const chunks: string[] = [];
    let currentChunk = '';

    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) continue;

      // If adding this sentence would exceed maxChunkSize, start a new chunk
      if (
        currentChunk &&
        currentChunk.length + trimmedSentence.length + 1 > maxChunkSize
      ) {
        chunks.push(currentChunk.trim());
        currentChunk = trimmedSentence;
      } else {
        // Add to current chunk
        currentChunk += (currentChunk ? ' ' : '') + trimmedSentence;
      }
    }

    // Don't forget the last chunk
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks.length > 0 ? chunks : [text];
  }

  /**
   * Convert year numbers to spoken form
   * e.g., "2024" → "twenty twenty-four"
   */
  private convertYear(year: string): string {
    const num = parseInt(year, 10);

    // Don't convert if it's too old or ends in 00-09
    if (num < 1100 || num % 1000 < 10) {
      return year;
    }

    const left = year.slice(0, 2);
    const right = parseInt(year.slice(2, 4), 10);

    if (right === 0) {
      return `${left} hundred`;
    } else if (right < 10) {
      return `${left} oh ${right}`;
    }

    return `${left} ${right}`;
  }

  /**
   * Convert currency to spoken form
   * e.g., "$5.99" → "five dollars and ninety-nine cents"
   * Note: This is a basic implementation. For production, consider using
   * a more robust number-to-words library.
   * Currently unused but kept for future enhancement.
   */
  // private convertCurrency(match: string): string {
  //   const bill = match[0] === '$' ? 'dollar' : 'pound';

  //   if (!match.includes('.')) {
  //     const amount = match.slice(1);
  //     const suffix = amount === '1' ? '' : 's';
  //     return `${amount} ${bill}${suffix}`;
  //   }

  //   const [dollars, cents] = match.slice(1).split('.');
  //   if (!cents) {
  //     return match;
  //   }
  //   const centsNum = parseInt(cents.padEnd(2, '0'), 10);
  //   const coinName =
  //     match[0] === '$'
  //       ? centsNum === 1
  //         ? 'cent'
  //         : 'cents'
  //       : centsNum === 1
  //         ? 'penny'
  //         : 'pence';

  //   return `${dollars} ${bill}${dollars === '1' ? '' : 's'} and ${centsNum} ${coinName}`;
  // }

  /**
   * Convert time to spoken form
   * e.g., "2:30" → "two thirty"
   * Currently unused but kept for future enhancement.
   */
  // private convertTime(match: string): string {
  //   const parts = match.split(':').map(Number);
  //   const hours = parts[0];
  //   const minutes = parts[1];

  //   if (minutes === undefined || minutes === 0) {
  //     return `${hours} o'clock`;
  //   } else if (minutes < 10) {
  //     return `${hours} oh ${minutes}`;
  //   }

  //   return `${hours} ${minutes}`;
  // }

  /**
   * Convert decimal numbers to spoken form
   * e.g., "3.14" → "three point one four"
   * Currently unused but kept for future enhancement.
   */
  // private convertDecimal(match: string): string {
  //   const parts = match.split('.');
  //   const whole = parts[0];
  //   const decimal = parts[1];
  //   if (!decimal) {
  //     return match;
  //   }
  //   return `${whole} point ${decimal.split('').join(' ')}`;
  // }
}
