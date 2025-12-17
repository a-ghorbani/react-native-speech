/**
 * Character-level Tokenizer for Kokoro TTS
 *
 * Kokoro uses a simple character-level tokenization (no BPE merging).
 * Each valid IPA character maps directly to a token ID.
 * The sequence is wrapped with '$' (token 0) at start and end.
 */

import type {TokenizerConfig} from '../../types';

export class BPETokenizer {
  private vocab: Map<string, number> = new Map();
  private reverseVocab: Map<number, string> = new Map();
  private validChars: Set<string> = new Set();

  // Special token - '$' is used as boundary marker (both BOS and EOS)
  private boundaryTokenId = 0;

  private isInitialized = false;

  /**
   * Load vocabulary from JSON objects
   * Note: Kokoro doesn't use BPE merges - it's character-level tokenization
   */
  async loadFromData(
    vocabData: Record<string, number>,
    _mergesData: Array<string>, // Ignored - Kokoro doesn't use merges
  ): Promise<void> {
    // Load vocabulary
    for (const [token, id] of Object.entries(vocabData)) {
      this.vocab.set(token, id);
      this.reverseVocab.set(id, token);
      this.validChars.add(token);
    }

    // Boundary token is '$' with ID 0
    this.boundaryTokenId = this.vocab.get('$') ?? 0;

    this.isInitialized = true;
  }

  /**
   * Encode phonemes into token IDs
   * Kokoro tokenization:
   * 1. Remove characters not in vocab (normalizer)
   * 2. Split into individual characters (pre-tokenizer with empty regex)
   * 3. Map each character to token ID
   * 4. Wrap with '$' token at start and end (post-processor)
   */
  encode(
    text: string,
    _options?: {addBos?: boolean; addEos?: boolean},
  ): number[] {
    if (!this.isInitialized) {
      throw new Error('Tokenizer not initialized. Call loadFromData() first.');
    }

    // Step 1: Normalize - remove characters not in vocab
    const normalized = this.normalize(text);

    // Step 2 & 3: Split into characters and map to token IDs
    const tokens: number[] = [];

    // Add boundary token at start (post-processor template)
    tokens.push(this.boundaryTokenId);

    // Tokenize each character
    for (const char of normalized) {
      const tokenId = this.vocab.get(char);
      if (tokenId !== undefined) {
        tokens.push(tokenId);
      }
      // Characters not in vocab are silently dropped (per normalizer behavior)
    }

    // Add boundary token at end (post-processor template)
    tokens.push(this.boundaryTokenId);

    return tokens;
  }

  /**
   * Decode token IDs back to text
   */
  decode(tokenIds: number[]): string {
    if (!this.isInitialized) {
      throw new Error('Tokenizer not initialized');
    }

    const chars = tokenIds
      .filter(id => id !== this.boundaryTokenId) // Skip boundary tokens
      .map(id => this.reverseVocab.get(id) ?? '')
      .filter(char => char !== '');

    return chars.join('');
  }

  /**
   * Get tokenizer configuration
   */
  getConfig(): TokenizerConfig {
    return {
      vocab: this.vocab,
      merges: [], // Kokoro doesn't use merges
      unkTokenId: this.boundaryTokenId, // No UNK - invalid chars are dropped
      bosTokenId: this.boundaryTokenId,
      eosTokenId: this.boundaryTokenId,
      padTokenId: this.boundaryTokenId,
    };
  }

  /**
   * Check if tokenizer is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.vocab.size > 0;
  }

  /**
   * Normalize text by removing characters not in vocab
   * This matches the tokenizer.json normalizer which uses a regex
   * to keep only valid IPA characters
   */
  private normalize(text: string): string {
    let result = '';
    for (const char of text) {
      if (this.validChars.has(char)) {
        result += char;
      }
      // Invalid characters are silently dropped
    }
    return result;
  }
}
