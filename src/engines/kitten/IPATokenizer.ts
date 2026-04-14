/**
 * Character-level IPA Tokenizer for Kitten TTS
 *
 * Kitten uses a simple character-level tokenization where each valid
 * IPA character maps directly to a token ID. The sequence is wrapped
 * with '$' (token 0) at start and end — same boundary pattern as Kokoro.
 *
 * If no external vocab is provided, uses the built-in symbol table
 * from the Kitten TTS TextCleaner.
 */

import {buildDefaultVocab} from './constants';

export class IPATokenizer {
  private vocab: Map<string, number> = new Map();
  private reverseVocab: Map<number, string> = new Map();
  private validChars: Set<string> = new Set();

  // Boundary/pad token ('$' = ID 0)
  private boundaryTokenId = 0;
  // End-of-sequence token (ID 10, the '"' character)
  private eosTokenId = 10;

  private isInitialized = false;

  /**
   * Load vocabulary from a JSON mapping { char: id }
   */
  async loadFromData(vocabData: Record<string, number>): Promise<void> {
    this.vocab.clear();
    this.reverseVocab.clear();
    this.validChars.clear();

    for (const [token, id] of Object.entries(vocabData)) {
      this.vocab.set(token, id);
      this.reverseVocab.set(id, token);
      this.validChars.add(token);
    }

    this.boundaryTokenId = this.vocab.get('$') ?? 0;
    this.isInitialized = true;
  }

  /**
   * Load the built-in Kitten symbol table (no external file needed)
   */
  loadBuiltinVocab(): void {
    const vocab = buildDefaultVocab();
    // Synchronous version — no await needed
    this.vocab.clear();
    this.reverseVocab.clear();
    this.validChars.clear();

    for (const [token, id] of Object.entries(vocab)) {
      this.vocab.set(token, id);
      this.reverseVocab.set(id, token);
      this.validChars.add(token);
    }

    this.boundaryTokenId = this.vocab.get('$') ?? 0;
    this.isInitialized = true;
  }

  /**
   * Encode phonemes into token IDs.
   *
   * Steps:
   * 1. Apply basic_english_tokenize regex (split into words/punct, rejoin with spaces)
   * 2. Remove characters not in vocab
   * 3. Map each character to its token ID
   * 4. Frame as: [pad=0, ...tokens..., eos=10, pad=0]
   *
   * Reference: KittenTTS onnx_model.py _prepare_inputs()
   */
  encode(text: string): number[] {
    if (!this.isInitialized) {
      throw new Error(
        'Tokenizer not initialized. Call loadFromData() or loadBuiltinVocab() first.',
      );
    }

    // Apply basic_english_tokenize: split into word/punctuation tokens, rejoin with spaces
    // This normalizes whitespace in the phoneme string
    const regexTokenized = this.basicEnglishTokenize(text);

    const normalized = this.normalize(regexTokenized);

    const tokens: number[] = [];
    tokens.push(this.boundaryTokenId); // pad at start

    for (const char of normalized) {
      const tokenId = this.vocab.get(char);
      if (tokenId !== undefined) {
        tokens.push(tokenId);
      }
    }

    tokens.push(this.eosTokenId); // EOS (index 10)
    tokens.push(this.boundaryTokenId); // pad at end

    return tokens;
  }

  /**
   * Equivalent of Python's basic_english_tokenize: r"\w+|[^\w\s]"
   * Splits text into word tokens and single punctuation chars, then joins with spaces.
   *
   * Note: Python's \w matches Unicode letters (including IPA chars like ð, ɪ, ɑ),
   * but JS \w only matches [a-zA-Z0-9_]. We use \p{L} (Unicode Letter) to match
   * the Python behavior for IPA phoneme text.
   */
  private basicEnglishTokenize(text: string): string {
    const matches = text.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu);
    return matches ? matches.join(' ') : text;
  }

  /**
   * Decode token IDs back to text
   */
  decode(tokenIds: number[]): string {
    if (!this.isInitialized) {
      throw new Error('Tokenizer not initialized');
    }

    return tokenIds
      .filter(id => id !== this.boundaryTokenId)
      .map(id => this.reverseVocab.get(id) ?? '')
      .filter(char => char !== '')
      .join('');
  }

  /**
   * Check if tokenizer is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.vocab.size > 0;
  }

  /**
   * Clear all tokenizer data and reset to uninitialized state.
   */
  clear(): void {
    this.vocab.clear();
    this.reverseVocab.clear();
    this.validChars.clear();
    this.boundaryTokenId = 0;
    this.isInitialized = false;
  }

  /**
   * Normalize text by removing characters not in vocab.
   */
  private normalize(text: string): string {
    let result = '';
    for (const char of text) {
      if (this.validChars.has(char)) {
        result += char;
      }
    }
    return result;
  }
}
