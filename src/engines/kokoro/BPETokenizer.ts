/**
 * Byte-Pair Encoding (BPE) Tokenizer for Kokoro TTS
 *
 * Implements BPE algorithm to convert text into token IDs
 * that can be fed into the Kokoro ONNX model.
 */

import type {TokenizerConfig} from '../../types';

export class BPETokenizer {
  private vocab: Map<string, number> = new Map();
  private merges: Array<[string, number]> = [];
  private reverseVocab: Map<number, string> = new Map();

  private unkTokenId = 0;
  private bosTokenId = 1;
  private eosTokenId = 2;
  private padTokenId = 3;

  private isInitialized = false;

  /**
   * Load vocabulary and merges from JSON objects
   */
  async loadFromData(
    vocabData: Record<string, number>,
    mergesData: Array<string>,
  ): Promise<void> {
    // Load vocabulary
    for (const [token, id] of Object.entries(vocabData)) {
      this.vocab.set(token, id);
      this.reverseVocab.set(id, token);
    }

    // Find special tokens
    this.unkTokenId = this.vocab.get('<unk>') ?? 0;
    this.bosTokenId = this.vocab.get('<s>') ?? 1;
    this.eosTokenId = this.vocab.get('</s>') ?? 2;
    this.padTokenId = this.vocab.get('<pad>') ?? 3;

    // Load merges with priority index
    this.merges = mergesData.map((merge, index) => {
      return [merge, index] as [string, number];
    });

    this.isInitialized = true;
  }

  /**
   * Encode text into token IDs
   */
  encode(
    text: string,
    options?: {addBos?: boolean; addEos?: boolean},
  ): number[] {
    if (!this.isInitialized) {
      throw new Error('Tokenizer not initialized. Call loadFromData() first.');
    }

    const addBos = options?.addBos ?? false;
    const addEos = options?.addEos ?? false;

    // Normalize text
    const normalized = this.normalizeText(text);

    // Pre-tokenize into words
    const words = this.preTokenize(normalized);

    // Apply BPE to each word
    const allTokens: number[] = [];

    if (addBos) {
      allTokens.push(this.bosTokenId);
    }

    for (const word of words) {
      const wordTokens = this.bpeEncode(word);
      allTokens.push(...wordTokens);
    }

    if (addEos) {
      allTokens.push(this.eosTokenId);
    }

    return allTokens;
  }

  /**
   * Decode token IDs back to text
   */
  decode(tokenIds: number[]): string {
    if (!this.isInitialized) {
      throw new Error('Tokenizer not initialized');
    }

    const tokens = tokenIds
      .filter(id => {
        // Skip special tokens
        return (
          id !== this.bosTokenId &&
          id !== this.eosTokenId &&
          id !== this.padTokenId
        );
      })
      .map(id => this.reverseVocab.get(id) ?? '<unk>');

    return tokens.join('').replace(/▁/g, ' ').trim();
  }

  /**
   * Get tokenizer configuration
   */
  getConfig(): TokenizerConfig {
    return {
      vocab: this.vocab,
      merges: this.merges.map(
        ([merge]) => merge.split(' ') as [string, string],
      ),
      unkTokenId: this.unkTokenId,
      bosTokenId: this.bosTokenId,
      eosTokenId: this.eosTokenId,
      padTokenId: this.padTokenId,
    };
  }

  /**
   * Check if tokenizer is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.vocab.size > 0;
  }

  /**
   * Normalize text (basic normalization)
   */
  private normalizeText(text: string): string {
    return text
      .trim()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/[^\u0020-\u007F]/gu, match => {
        // Handle non-ASCII characters (preserve them for multilingual support)
        return match;
      });
  }

  /**
   * Pre-tokenize text into words
   */
  private preTokenize(text: string): string[] {
    // Split on whitespace and add special marker
    return text.split(/\s+/).map(word => '▁' + word);
  }

  /**
   * Apply BPE algorithm to a single word
   */
  private bpeEncode(word: string): number[] {
    // Split word into characters
    let tokens = word.split('');

    // Apply BPE merges iteratively
    while (tokens.length > 1) {
      const bestMerge = this.findBestMerge(tokens);
      if (!bestMerge) {
        break; // No more merges possible
      }

      tokens = this.applyMerge(tokens, bestMerge);
    }

    // Convert tokens to IDs
    return tokens.map(token => this.vocab.get(token) ?? this.unkTokenId);
  }

  /**
   * Find the best merge to apply (lowest merge index = highest priority)
   */
  private findBestMerge(tokens: string[]): string | null {
    let bestMerge: string | null = null;
    let bestPriority = Infinity;

    for (let i = 0; i < tokens.length - 1; i++) {
      const pair = `${tokens[i]} ${tokens[i + 1]}`;

      for (const [merge, priority] of this.merges) {
        if (merge === pair && priority < bestPriority) {
          bestPriority = priority;
          bestMerge = pair;
        }
      }
    }

    return bestMerge;
  }

  /**
   * Apply a specific merge to token array
   */
  private applyMerge(tokens: string[], mergeStr: string): string[] {
    const parts = mergeStr.split(' ');
    const first = parts[0];
    const second = parts[1];

    if (!first || !second) {
      return tokens; // Invalid merge string
    }

    const newTokens: string[] = [];

    let i = 0;
    while (i < tokens.length) {
      if (
        i < tokens.length - 1 &&
        tokens[i] === first &&
        tokens[i + 1] === second
      ) {
        // Merge these two tokens
        newTokens.push(first + second);
        i += 2;
      } else {
        newTokens.push(tokens[i]!);
        i += 1;
      }
    }

    return newTokens;
  }
}
