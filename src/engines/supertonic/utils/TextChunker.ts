/**
 * Text Chunker Utility
 *
 * Splits text into manageable chunks for sentence-level TTS processing.
 * Respects sentence boundaries to ensure natural speech output.
 */

/**
 * Represents a chunk of text with position information
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
   * @example
   * const chunks = TextChunker.chunkBySentences("Hello world. How are you?", 100);
   * // Returns: [{ text: "Hello world. How are you?", startIndex: 0, endIndex: 25 }]
   *
   * @param text - Input text to split
   * @param maxChunkSize - Maximum characters per chunk
   * @returns Array of text chunks with position information
   */
  static chunkBySentences(text: string, maxChunkSize: number): TextChunk[] {
    const chunks: TextChunk[] = [];

    // Split by sentence-ending punctuation
    const sentenceRegex = /[.!?]+[\s]*/g;
    const sentences: {text: string; start: number; end: number}[] = [];

    let lastIndex = 0;
    let match;

    while ((match = sentenceRegex.exec(text)) !== null) {
      const sentenceEnd = match.index + match[0].length;
      sentences.push({
        text: text.slice(lastIndex, sentenceEnd),
        start: lastIndex,
        end: sentenceEnd,
      });
      lastIndex = sentenceEnd;
    }

    // Add remaining text if any
    if (lastIndex < text.length) {
      sentences.push({
        text: text.slice(lastIndex),
        start: lastIndex,
        end: text.length,
      });
    }

    // Group sentences into chunks respecting maxChunkSize
    let currentChunk = '';
    let chunkStart = 0;

    for (const sentence of sentences) {
      if (
        currentChunk.length + sentence.text.length > maxChunkSize &&
        currentChunk.length > 0
      ) {
        // Save current chunk
        chunks.push({
          text: currentChunk.trim(),
          startIndex: chunkStart,
          endIndex: chunkStart + currentChunk.length,
        });
        currentChunk = sentence.text;
        chunkStart = sentence.start;
      } else {
        if (currentChunk.length === 0) {
          chunkStart = sentence.start;
        }
        currentChunk += sentence.text;
      }
    }

    // Add final chunk
    if (currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        startIndex: chunkStart,
        endIndex: chunkStart + currentChunk.length,
      });
    }

    return chunks;
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
        currentOffset += paragraph.length + 2; // Account for \n\n
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

      currentOffset += paragraph.length + 2; // Account for \n\n separator
    }

    return chunks;
  }
}
