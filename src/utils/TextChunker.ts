/**
 * Text Chunker Utility for Neural TTS Engines
 *
 * Splits text into manageable chunks for sentence-level TTS processing.
 * Respects sentence boundaries to ensure natural speech output.
 *
 * Shared between Kokoro and Supertonic engines.
 */

import {UNSPACED_SENTENCE_ENDS} from './firstClause';

/**
 * Represents a chunk of text with position information in the original text
 */
export interface TextChunk {
  /** The text content of the chunk */
  text: string;
  /** Start position in the original text */
  startIndex: number;
  /** End position in the original text */
  endIndex: number;
}

/**
 * Text chunking utility for splitting long text into manageable pieces
 */
export class TextChunker {
  /**
   * Split text into chunks by sentences, respecting max size.
   * Sentences are grouped together until the max chunk size is reached.
   *
   * The algorithm:
   * 1. Split on sentence-ending punctuation (. ! ?) followed by whitespace
   * 2. Group sentences into chunks that fit within maxChunkSize
   * 3. Return chunks with their original text positions for highlighting
   *
   * @example
   * const chunks = TextChunker.chunkBySentences("Hello world. How are you?", 100);
   * // Returns: [{ text: "Hello world. How are you?", startIndex: 0, endIndex: 25 }]
   *
   * @param text - Input text to split
   * @param maxChunkSize - Maximum characters per chunk (default: 400)
   * @returns Array of text chunks with position information
   */
  static chunkBySentences(
    text: string,
    maxChunkSize: number = 400,
  ): TextChunk[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const chunks: TextChunk[] = [];

    // Split after sentence-ending punctuation (any script) and the
    // whitespace that follows it
    const sentenceRegex = new RegExp(
      `(?:[.!?]+|[${UNSPACED_SENTENCE_ENDS}]+)\\s*`,
      'g',
    );
    const sentences: {text: string; start: number; end: number}[] = [];

    let lastIndex = 0;
    let match;

    while ((match = sentenceRegex.exec(text)) !== null) {
      const sentenceEnd = match.index + match[0].length;
      const sentenceText = text.slice(lastIndex, sentenceEnd);

      if (sentenceText.trim()) {
        sentences.push({
          text: sentenceText,
          start: lastIndex,
          end: sentenceEnd,
        });
      }
      lastIndex = sentenceEnd;
    }

    // Add remaining text if any
    if (lastIndex < text.length) {
      const remaining = text.slice(lastIndex);
      if (remaining.trim()) {
        sentences.push({
          text: remaining,
          start: lastIndex,
          end: text.length,
        });
      }
    }

    // If no sentences found, return the entire text as one chunk
    if (sentences.length === 0) {
      return [
        {
          text: text.trim(),
          startIndex: 0,
          endIndex: text.length,
        },
      ];
    }

    // Group sentences into chunks respecting maxChunkSize. A chunk is the
    // original text from its first to its last sentence, without outer
    // whitespace, so the separators between grouped sentences are kept.
    let chunkStart = -1;
    let chunkEnd = 0;

    for (const sentence of sentences) {
      const start =
        sentence.start +
        sentence.text.length -
        sentence.text.trimStart().length;
      const end = sentence.start + sentence.text.trimEnd().length;
      if (chunkStart !== -1 && end - chunkStart > maxChunkSize) {
        chunks.push({
          text: text.slice(chunkStart, chunkEnd),
          startIndex: chunkStart,
          endIndex: chunkEnd,
        });
        chunkStart = -1;
      }
      if (chunkStart === -1) {
        chunkStart = start;
      }
      chunkEnd = end;
    }

    if (chunkStart !== -1) {
      chunks.push({
        text: text.slice(chunkStart, chunkEnd),
        startIndex: chunkStart,
        endIndex: chunkEnd,
      });
    }

    return chunks;
  }

  /**
   * Split text into chunks with smarter sentence detection.
   * Avoids splitting on decimal numbers, abbreviations, etc.
   *
   * Uses a pattern that requires sentence-ending punctuation to be followed by:
   * - Whitespace and an uppercase letter (new sentence)
   * - End of string
   *
   * @param text - Input text to split
   * @param maxChunkSize - Maximum characters per chunk (default: 400)
   * @returns Array of text chunks with position information
   */
  static chunkBySentencesSmart(
    text: string,
    maxChunkSize: number = 400,
  ): TextChunk[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    // Smart sentence boundary detection
    // Requires punctuation followed by whitespace + uppercase or end of string
    const sentenceEndPattern = /[.!?]+(?:\s+(?=[A-Z])|$)/g;
    const sentences: {text: string; start: number; end: number}[] = [];

    let lastIndex = 0;
    let match;

    while ((match = sentenceEndPattern.exec(text)) !== null) {
      const endIndex = match.index + match[0].length;
      const sentenceText = text.slice(lastIndex, endIndex);

      if (sentenceText.trim()) {
        sentences.push({
          text: sentenceText,
          start: lastIndex,
          end: endIndex,
        });
      }
      lastIndex = endIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      const remaining = text.slice(lastIndex);
      if (remaining.trim()) {
        sentences.push({
          text: remaining,
          start: lastIndex,
          end: text.length,
        });
      }
    }

    // If no sentences found, return the entire text as one chunk
    if (sentences.length === 0) {
      return [
        {
          text: text.trim(),
          startIndex: 0,
          endIndex: text.length,
        },
      ];
    }

    // Group sentences into chunks
    const chunks: TextChunk[] = [];
    let currentChunk = '';
    let chunkStart = sentences[0]?.start ?? 0;
    let chunkEnd = chunkStart;

    for (const sentence of sentences) {
      const trimmedSentence = sentence.text.trim();
      if (!trimmedSentence) continue;

      if (
        currentChunk &&
        currentChunk.length + trimmedSentence.length + 1 > maxChunkSize
      ) {
        chunks.push({
          text: currentChunk.trim(),
          startIndex: chunkStart,
          endIndex: chunkEnd,
        });
        currentChunk = trimmedSentence;
        chunkStart = sentence.start;
        chunkEnd = sentence.end;
      } else {
        if (!currentChunk) {
          chunkStart = sentence.start;
        }
        currentChunk += (currentChunk ? ' ' : '') + trimmedSentence;
        chunkEnd = sentence.end;
      }
    }

    // Add final chunk
    if (currentChunk) {
      chunks.push({
        text: currentChunk.trim(),
        startIndex: chunkStart,
        endIndex: chunkEnd,
      });
    }

    return chunks.length > 0
      ? chunks
      : [{text: text.trim(), startIndex: 0, endIndex: text.length}];
  }

  /**
   * Split text by paragraphs (double newlines), respecting max size.
   * Useful for processing long documents.
   *
   * @param text - Input text to split
   * @param maxChunkSize - Maximum characters per chunk
   * @returns Array of text chunks with position information
   */
  static chunkByParagraphs(text: string, maxChunkSize: number): TextChunk[] {
    const chunks: TextChunk[] = [];
    // Paragraph spans between the real separators, whatever their length.
    const spans: Array<[number, number]> = [];
    let start = 0;
    for (const sep of text.matchAll(/\n\n+/g)) {
      spans.push([start, sep.index!]);
      start = sep.index! + sep[0].length;
    }
    spans.push([start, text.length]);

    for (const [spanStart, spanEnd] of spans) {
      const paragraph = text.slice(spanStart, spanEnd);
      if (paragraph.trim().length === 0) {
        continue;
      }

      // If paragraph is too long, split by sentences
      if (paragraph.length > maxChunkSize) {
        const sentenceChunks = this.chunkBySentences(paragraph, maxChunkSize);
        for (const chunk of sentenceChunks) {
          chunks.push({
            text: chunk.text,
            startIndex: spanStart + chunk.startIndex,
            endIndex: spanStart + chunk.endIndex,
          });
        }
      } else {
        const lead = paragraph.length - paragraph.trimStart().length;
        chunks.push({
          text: paragraph.trim(),
          startIndex: spanStart + lead,
          endIndex: spanStart + paragraph.trimEnd().length,
        });
      }
    }

    return chunks;
  }
}
