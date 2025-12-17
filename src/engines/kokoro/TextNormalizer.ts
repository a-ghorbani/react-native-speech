/**
 * Text Normalizer for TTS
 *
 * Normalizes text before phonemization to improve pronunciation:
 * - Expands abbreviations (Dr. -> Doctor)
 * - Converts numbers to words (2024 -> twenty twenty-four)
 * - Handles currency ($5.99 -> five dollars and ninety-nine cents)
 * - Normalizes punctuation and whitespace
 *
 * Based on: https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/phonemize.js
 */

export class TextNormalizer {
  /**
   * Split numbers into phonetic equivalents
   * Handles years, times, and decimal numbers
   */
  private splitNum(match: string): string {
    if (match.includes('.')) {
      return match;
    } else if (match.includes(':')) {
      const parts = match.split(':').map(Number);
      const h = parts[0];
      const m = parts[1];
      if (m === 0) {
        return `${h} o'clock`;
      } else if (m !== undefined && m < 10) {
        return `${h} oh ${m}`;
      }
      return `${h} ${m}`;
    }

    const year = parseInt(match.slice(0, 4), 10);
    if (year < 1100 || year % 1000 < 10) {
      return match;
    }

    const left = match.slice(0, 2);
    const right = parseInt(match.slice(2, 4), 10);
    const suffix = match.endsWith('s') ? 's' : '';

    if (year % 1000 >= 100 && year % 1000 <= 999) {
      if (right === 0) {
        return `${left} hundred${suffix}`;
      } else if (right < 10) {
        return `${left} oh ${right}${suffix}`;
      }
    }

    return `${left} ${right}${suffix}`;
  }

  /**
   * Format monetary values into spoken form
   */
  private flipMoney(match: string): string {
    const bill = match[0] === '$' ? 'dollar' : 'pound';

    if (isNaN(Number(match.slice(1)))) {
      return `${match.slice(1)} ${bill}s`;
    } else if (!match.includes('.')) {
      const suffix = match.slice(1) === '1' ? '' : 's';
      return `${match.slice(1)} ${bill}${suffix}`;
    }

    const parts = match.slice(1).split('.');
    const b = parts[0];
    const c = parts[1];
    if (!c) {
      return match;
    }
    const d = parseInt(c.padEnd(2, '0'), 10);
    const coins =
      match[0] === '$'
        ? d === 1
          ? 'cent'
          : 'cents'
        : d === 1
          ? 'penny'
          : 'pence';

    return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`;
  }

  /**
   * Process decimal numbers into spoken form
   */
  private pointNum(match: string): string {
    const parts = match.split('.');
    const a = parts[0];
    const b = parts[1];
    if (!b) {
      return match;
    }
    return `${a} point ${b.split('').join(' ')}`;
  }

  /**
   * Normalize text for TTS
   * Applies all preprocessing transformations from kokoro.js
   */
  normalize(text: string): string {
    let result = text;

    // 1. Handle quotes and brackets
    // Use Unicode escapes for reliability
    result = result
      .replace(/[\u2018\u2019]/g, "'") // Curly single quotes to straight
      .replace(/\u00ab/g, '"') // « to "
      .replace(/\u00bb/g, '"') // » to "
      .replace(/[\u201c\u201d]/g, '"') // Curly double quotes to straight
      .replace(/\(/g, '\u00ab') // ( to «
      .replace(/\)/g, '\u00bb'); // ) to »

    // 2. Replace uncommon punctuation marks (CJK etc.)
    result = result
      .replace(/、/g, ', ')
      .replace(/。/g, '. ')
      .replace(/！/g, '! ')
      .replace(/，/g, ', ')
      .replace(/：/g, ': ')
      .replace(/；/g, '; ')
      .replace(/？/g, '? ');

    // 3. Whitespace normalization
    result = result
      .replace(/[^\S \n]/g, ' ')
      .replace(/ {2,}/g, ' ')
      .replace(/(?<=\n) +(?=\n)/g, '');

    // 4. Abbreviations
    result = result
      .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
      .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
      .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
      .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
      .replace(/\betc\.(?! [A-Z])/gi, 'etc');

    // 5. Normalize casual words
    result = result.replace(/\b(y)eah?\b/gi, "$1e'a");

    // 6. Handle numbers and currencies
    // Years, times, and decade numbers
    result = result.replace(
      /\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g,
      m => this.splitNum(m),
    );

    // Remove commas from numbers
    result = result.replace(/(?<=\d),(?=\d)/g, '');

    // Currency handling
    result = result.replace(
      /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
      m => this.flipMoney(m),
    );

    // Decimal numbers (after currency to avoid conflicts)
    result = result.replace(/\d*\.\d+/g, m => this.pointNum(m));

    // Number ranges (10-20 -> 10 to 20)
    result = result.replace(/(?<=\d)-(?=\d)/g, ' to ');

    // Uppercase S after number (10S -> 10 S)
    result = result.replace(/(?<=\d)S/g, ' S');

    // 7. Handle possessives
    // result = result.replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S");
    // result = result.replace(/(?<=X')S\b/g, 's');
    // ALL-CAPS words (>=2 letters)
    result = result.replace(/(?<=\b[A-Z]{2,})'?s\b/g, "'S");
    // single-letter uppercase tokens (C's, B's)
    result = result.replace(/(?<=\b[A-Z])'?s\b/g, "'S");
    // X → /ɪz/ exception
    result = result.replace(/(?<=X')S\b/g, 's');

    // 8. Handle acronyms with periods (U.S.A. -> U-S-A-)
    result = result.replace(/(?:[A-Za-z]\.){2,} [a-z]/g, m =>
      m.replace(/\./g, '-'),
    );
    result = result.replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-');

    // 9. Strip leading and trailing whitespace
    return result.trim();
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
}
