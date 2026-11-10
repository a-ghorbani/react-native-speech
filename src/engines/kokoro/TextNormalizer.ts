/**
 * Kokoro sentence chunking, plus `normalize` (the Kokoro text steps, now in
 * phonemization/engineTails).
 *
 * Based on: https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/phonemize.js
 */

import {kokoroTail} from '../../phonemization/engineTails';
import {isAbbreviationPeriod} from '../../utils/abbreviations';

export class TextNormalizer {
  /**
   * The Kokoro text steps (kokoro.js port), without the shared pipeline.
   * Engines call normalizeForEngine(text, 'kokoro'), which runs
   * normalizeForSpeech first.
   */
  normalize(text: string): string {
    return kokoroTail(text);
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
      if (isAbbreviationPeriod(text, match.index)) continue;
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
