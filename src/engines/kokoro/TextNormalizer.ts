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

import {splitCamelCase} from '../../phonemization/splitCamelCase';

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
   * Convert a non-negative integer (<= 999_999) to English words.
   * Used as a final-pass fallback after kokoro.js-style number handling.
   */
  private intToWords(n: number): string {
    if (n < 0 || n > 999999 || !Number.isInteger(n)) return String(n);
    if (n === 0) return 'zero';
    const ones = [
      '',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
      'eleven',
      'twelve',
      'thirteen',
      'fourteen',
      'fifteen',
      'sixteen',
      'seventeen',
      'eighteen',
      'nineteen',
    ];
    const tens = [
      '',
      '',
      'twenty',
      'thirty',
      'forty',
      'fifty',
      'sixty',
      'seventy',
      'eighty',
      'ninety',
    ];
    let result = '';
    if (n >= 1000) {
      result += this.intToWords(Math.floor(n / 1000)) + ' thousand';
      n %= 1000;
      if (n > 0) result += ' ';
    }
    if (n >= 100) {
      result += ones[Math.floor(n / 100)] + ' hundred';
      n %= 100;
      if (n > 0) result += ' ';
    }
    if (n >= 20) {
      result += tens[Math.floor(n / 10)];
      if (n % 10) result += ' ' + ones[n % 10];
    } else if (n > 0) {
      result += ones[n];
    }
    return result;
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

    // 9. Convert any remaining bare integers to words
    result = result.replace(/\b\d+\b/g, m => {
      const n = parseInt(m, 10);
      return n >= 0 && n <= 999999 ? this.intToWords(n) : m;
    });

    // 10. Split camelCase / PascalCase tokens so each part is phonemized
    // independently (e.g. "PrismML" → "Prism ML", "iOS's" → "i OS's").
    // Conservative — won't touch iPhone, McDonald, JavaScript, etc.
    result = splitCamelCase(result);

    // 11. Strip leading and trailing whitespace
    return result.trim();
  }

  /**
   * Split text into sentence-based chunks for streaming/processing
   * Preserves sentence boundaries for natural speech flow
   */
  chunkBySentences(text: string, maxChunkSize: number = 1000): string[] {
    return this.chunkBySentencesWithMetadata(text, maxChunkSize).map(
      chunk => chunk.text,
    );
  }

  /**
   * Split text into sentence-based chunks with metadata for progress tracking
   * Returns chunks with their original text positions
   *
   * @param text - The text to chunk
   * @param maxChunkSize - Maximum characters per chunk (default 500 to stay within token limits)
   * @returns Array of chunks with text and position metadata
   */
  chunkBySentencesWithMetadata(
    text: string,
    maxChunkSize: number = 500,
  ): TextChunk[] {
    // Split on sentence boundaries using a smarter approach
    // that handles decimal numbers, abbreviations, etc.
    const sentenceMatches: Array<{text: string; start: number; end: number}> =
      [];

    // Use a pattern that requires sentence-ending punctuation to be followed by:
    // - Whitespace and an uppercase letter (new sentence)
    // - End of string
    // This avoids splitting on decimal numbers like "0.76" or "3.14"
    const sentenceEndPattern = /[.!?]+(?:\s+(?=[A-Z])|$)/g;

    let lastIndex = 0;
    let match;
    while ((match = sentenceEndPattern.exec(text)) !== null) {
      const endIndex = match.index + match[0].length;
      const sentenceText = text.slice(lastIndex, endIndex);

      if (sentenceText.trim()) {
        sentenceMatches.push({
          text: sentenceText,
          start: lastIndex,
          end: endIndex,
        });
      }
      lastIndex = endIndex;
    }

    // Don't forget any remaining text after the last sentence boundary
    if (lastIndex < text.length) {
      const remaining = text.slice(lastIndex);
      if (remaining.trim()) {
        sentenceMatches.push({
          text: remaining,
          start: lastIndex,
          end: text.length,
        });
      }
    }

    // If no sentences found, return the entire text as one chunk
    if (sentenceMatches.length === 0) {
      return [
        {
          text: text.trim(),
          originalText: text,
          startIndex: 0,
          endIndex: text.length,
        },
      ];
    }

    // Group sentences into chunks that don't exceed maxChunkSize
    const chunks: TextChunk[] = [];
    let currentChunkText = '';
    let currentChunkStart = sentenceMatches[0]?.start ?? 0;
    let currentChunkEnd = currentChunkStart;

    for (const sentence of sentenceMatches) {
      const trimmedSentence = sentence.text.trim();
      if (!trimmedSentence) continue;

      // If adding this sentence would exceed maxChunkSize, start a new chunk
      if (
        currentChunkText &&
        currentChunkText.length + trimmedSentence.length + 1 > maxChunkSize
      ) {
        chunks.push({
          text: currentChunkText.trim(),
          originalText: text.slice(currentChunkStart, currentChunkEnd),
          startIndex: currentChunkStart,
          endIndex: currentChunkEnd,
        });
        currentChunkText = trimmedSentence;
        currentChunkStart = sentence.start;
        currentChunkEnd = sentence.end;
      } else {
        // Add to current chunk
        if (!currentChunkText) {
          currentChunkStart = sentence.start;
        }
        currentChunkText += (currentChunkText ? ' ' : '') + trimmedSentence;
        currentChunkEnd = sentence.end;
      }
    }

    // Don't forget the last chunk
    if (currentChunkText) {
      chunks.push({
        text: currentChunkText.trim(),
        originalText: text.slice(currentChunkStart, currentChunkEnd),
        startIndex: currentChunkStart,
        endIndex: currentChunkEnd,
      });
    }

    return chunks.length > 0
      ? chunks
      : [
          {
            text: text.trim(),
            originalText: text,
            startIndex: 0,
            endIndex: text.length,
          },
        ];
  }
}

/**
 * Represents a chunk of text with its position in the original text
 */
export interface TextChunk {
  /** The normalized/processed chunk text */
  text: string;
  /** The original text before normalization */
  originalText: string;
  /** Start index in the original text */
  startIndex: number;
  /** End index in the original text */
  endIndex: number;
}
