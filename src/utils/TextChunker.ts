/**
 * Text Chunker Utility for Neural TTS Engines
 *
 * Splits text into manageable chunks for sentence-level TTS processing.
 * Respects sentence boundaries to ensure natural speech output.
 *
 * Shared between Kokoro and Supertonic engines.
 */

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

    // Split by sentence-ending punctuation followed by whitespace
    const sentenceRegex = /[.!?]+[\s]*/g;
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

    // Group sentences into chunks respecting maxChunkSize
    let currentChunk = '';
    let chunkStart = 0;
    let chunkEnd = 0;

    for (const sentence of sentences) {
      const trimmedText = sentence.text.trimEnd();

      if (
        currentChunk.length + trimmedText.length > maxChunkSize &&
        currentChunk.length > 0
      ) {
        // Save current chunk and start a new one
        chunks.push({
          text: currentChunk.trim(),
          startIndex: chunkStart,
          endIndex: chunkEnd,
        });
        currentChunk = trimmedText;
        chunkStart = sentence.start;
        chunkEnd = sentence.end;
      } else {
        // Add to current chunk
        if (currentChunk.length === 0) {
          chunkStart = sentence.start;
        }
        currentChunk += trimmedText;
        chunkEnd = sentence.end;
      }
    }

    // Add final chunk
    if (currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.trim(),
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
    const paragraphs = text.split(/\n\n+/);

    let currentOffset = 0;

    for (const paragraph of paragraphs) {
      if (paragraph.trim().length === 0) {
        currentOffset += paragraph.length + 2;
        continue;
      }

      // If paragraph is too long, split by sentences
      if (paragraph.length > maxChunkSize) {
        const sentenceChunks = this.chunkBySentences(paragraph, maxChunkSize);
        for (const chunk of sentenceChunks) {
          chunks.push({
            text: chunk.text,
            startIndex: currentOffset + chunk.startIndex,
            endIndex: currentOffset + chunk.endIndex,
          });
        }
      } else {
        chunks.push({
          text: paragraph.trim(),
          startIndex: currentOffset,
          endIndex: currentOffset + paragraph.length,
        });
      }

      currentOffset += paragraph.length + 2;
    }

    return chunks;
  }
}
