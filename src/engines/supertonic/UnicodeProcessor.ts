/**
 * Unicode Processor for Supertonic TTS
 *
 * Supertonic uses a character vocabulary mapping from unicode_indexer.json.
 * The indexer is an array where index = unicode code point, value = vocab index.
 * Characters not in the vocabulary are mapped to -1 and should use fallback.
 */

import {loadAssetAsJSON} from './utils/AssetLoader';

/**
 * Pad token ID used for sequence padding (usually 0 or a special token)
 */
const PAD_TOKEN_ID = 0;

/**
 * Unknown/OOV token ID for characters not in vocabulary
 */
const UNK_TOKEN_ID = 0; // Map unknown to space

/**
 * Available languages for Supertonic TTS v2 (multilingual)
 */
const AVAILABLE_LANGS = ['en', 'ko', 'es', 'pt', 'fr'];

/**
 * Advanced text normalization for Supertonic
 * Matches the official Python implementation preprocessing
 *
 * @param text - Input text to normalize
 * @param lang - Language code (default: 'en')
 * @param addLanguageTags - Whether to add language tags (v2 only, v1 doesn't support them)
 */
function normalizeText(
  text: string,
  lang: string = 'en',
  addLanguageTags: boolean = true,
): string {
  let normalized = text;

  // Normalize Unicode (NFKD equivalent)
  normalized = normalized.normalize('NFKD');

  // Remove emojis (simplified pattern for React Native compatibility)
  normalized = normalized.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    '',
  );

  // Replace various dashes and symbols
  const replacements: Record<string, string> = {
    '–': '-',
    '‑': '-',
    '—': '-',
    _: ' ',
    '\u201c': '"', // left double quote "
    '\u201d': '"', // right double quote "
    '\u2018': "'", // left single quote '
    '\u2019': "'", // right single quote '
    '´': "'",
    '`': "'",
    '[': ' ',
    ']': ' ',
    '|': ' ',
    '/': ' ',
    '#': ' ',
    '→': ' ',
    '←': ' ',
  };
  for (const [k, v] of Object.entries(replacements)) {
    normalized = normalized.split(k).join(v);
  }

  // Remove special symbols
  normalized = normalized.replace(/[♥☆♡©\\]/g, '');

  // Replace known expressions
  normalized = normalized.replace(/@/g, ' at ');
  normalized = normalized.replace(/e\.g\.,/g, 'for example, ');
  normalized = normalized.replace(/i\.e\.,/g, 'that is, ');

  // Fix spacing around punctuation
  normalized = normalized.replace(/ ,/g, ',');
  normalized = normalized.replace(/ \./g, '.');
  normalized = normalized.replace(/ !/g, '!');
  normalized = normalized.replace(/ \?/g, '?');
  normalized = normalized.replace(/ ;/g, ';');
  normalized = normalized.replace(/ :/g, ':');
  normalized = normalized.replace(/ '/g, "'");

  // Remove duplicate quotes
  while (normalized.includes('""')) {
    normalized = normalized.replace('""', '"');
  }
  while (normalized.includes("''")) {
    normalized = normalized.replace("''", "'");
  }
  while (normalized.includes('``')) {
    normalized = normalized.replace('``', '`');
  }

  // Remove extra spaces
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // If text doesn't end with punctuation, add a period
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(normalized)) {
    normalized += '.';
  }

  // Add language tags only for v2 models (multilingual)
  // v1 models don't have < and > in their vocabulary
  if (addLanguageTags) {
    const validLang = AVAILABLE_LANGS.includes(lang) ? lang : 'en';
    normalized = `<${validLang}>${normalized}</${validLang}>`;
  }

  return normalized;
}

/**
 * Create a text mask tensor (1 for valid tokens, 0 for padding)
 *
 * @param length - Sequence length
 * @returns Float32Array mask
 */
export function createTextMask(length: number): Float32Array {
  const mask = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    mask[i] = 1.0;
  }
  return mask;
}

/**
 * Create a latent mask tensor based on duration predictions
 *
 * @param totalDuration - Total predicted duration
 * @returns Float32Array mask
 */
export function createLatentMask(totalDuration: number): Float32Array {
  const mask = new Float32Array(totalDuration);
  for (let i = 0; i < totalDuration; i++) {
    mask[i] = 1.0;
  }
  return mask;
}

/**
 * Expand durations to create positional encoding for text to latent mapping
 * Given durations [2, 3, 1], this creates positions for each latent frame
 *
 * @param durations - Array of duration values for each text position
 * @returns Expanded position indices
 */
export function expandDurations(durations: Float32Array): number[] {
  const expanded: number[] = [];

  for (let i = 0; i < durations.length; i++) {
    const duration = Math.round(durations[i] as number);
    for (let j = 0; j < duration; j++) {
      expanded.push(i);
    }
  }

  return expanded;
}

/**
 * Calculate total duration from duration predictions
 *
 * @param durations - Duration values
 * @returns Total duration (sum of all durations, rounded)
 */
export function calculateTotalDuration(durations: Float32Array): number {
  let total = 0;
  for (let i = 0; i < durations.length; i++) {
    total += Math.round(durations[i] as number);
  }
  return total;
}

/**
 * Pad a BigInt64Array to a target length
 *
 * @param arr - Input array
 * @param targetLength - Target length to pad to
 * @param padValue - Value to use for padding (default: PAD_TOKEN_ID)
 * @returns Padded BigInt64Array
 */
export function padBigIntArray(
  arr: BigInt64Array,
  targetLength: number,
  padValue: bigint = BigInt(PAD_TOKEN_ID),
): BigInt64Array {
  if (arr.length >= targetLength) {
    return arr;
  }

  const padded = new BigInt64Array(targetLength);
  padded.set(arr);
  for (let i = arr.length; i < targetLength; i++) {
    padded[i] = padValue;
  }
  return padded;
}

/**
 * Pad a Float32Array to a target length
 *
 * @param arr - Input array
 * @param targetLength - Target length to pad to
 * @param padValue - Value to use for padding (default: 0)
 * @returns Padded Float32Array
 */
export function padFloat32Array(
  arr: Float32Array,
  targetLength: number,
  padValue: number = 0,
): Float32Array {
  if (arr.length >= targetLength) {
    return arr;
  }

  const padded = new Float32Array(targetLength);
  padded.set(arr);
  for (let i = arr.length; i < targetLength; i++) {
    padded[i] = padValue;
  }
  return padded;
}

export class UnicodeProcessor {
  private indexer: number[] | null = null;
  private isInitialized = false;
  private supportsLanguageTags = false; // v2 models support language tags, v1 doesn't

  /**
   * Initialize the Unicode processor by loading the indexer from JSON
   *
   * @param unicodeIndexerPath - Path to unicode_indexer.json file (optional)
   */
  async initialize(unicodeIndexerPath?: string): Promise<void> {
    if (unicodeIndexerPath) {
      try {
        console.log(
          '[UnicodeProcessor] Loading unicode indexer from:',
          unicodeIndexerPath,
        );
        const indexerData = await loadAssetAsJSON(unicodeIndexerPath);
        this.indexer = indexerData as number[];
        this.isInitialized = true;

        // Check if this indexer supports language tags (< and > characters)
        // v2 models have < at index 60 with vocab_idx 27, v1 has -1
        const lessThanIdx = this.indexer[60]; // '<' character
        const greaterThanIdx = this.indexer[62]; // '>' character
        this.supportsLanguageTags =
          lessThanIdx !== undefined &&
          lessThanIdx >= 0 &&
          greaterThanIdx !== undefined &&
          greaterThanIdx >= 0;

        console.log(
          `[UnicodeProcessor] Loaded indexer with ${this.indexer.length} entries, language tags: ${this.supportsLanguageTags ? 'supported' : 'not supported'}`,
        );
        return;
      } catch (error) {
        console.warn(
          '[UnicodeProcessor] Failed to load unicode indexer, using default:',
          error,
        );
        // Fall through to use default indexer
      }
    }

    // Use default indexer as fallback (v1 compatible, no language tags)
    console.log('[UnicodeProcessor] Using default hardcoded indexer (v1 mode)');
    this.indexer = this.buildDefaultIndexerArray();
    this.isInitialized = true;
    this.supportsLanguageTags = false; // Default indexer is v1 compatible
    console.log(
      `[UnicodeProcessor] Default indexer ready with ${this.indexer.length} entries, language tags: not supported`,
    );
  }

  /**
   * Build default indexer as an array (matching unicode_indexer.json format)
   * This provides backward compatibility when no JSON file is available
   */
  private buildDefaultIndexerArray(): number[] {
    // Build array-based indexer where index = code point, value = vocab index
    // Maximum code point we need to support (basic ASCII + some extended)
    const maxCodePoint = 256;
    const indexer = new Array(maxCodePoint).fill(-1);

    indexer[32] = 0; // space
    indexer[33] = 1; // !
    indexer[34] = 2; // "
    indexer[36] = 3; // $
    indexer[37] = 4; // %
    indexer[38] = 5; // &
    indexer[39] = 6; // '
    indexer[40] = 7; // (
    indexer[41] = 8; // )
    indexer[42] = 9; // *
    indexer[43] = 10; // +
    indexer[44] = 11; // ,
    indexer[45] = 12; // -
    indexer[46] = 13; // .
    indexer[48] = 14; // 0
    indexer[49] = 15; // 1
    indexer[50] = 16; // 2
    indexer[51] = 17; // 3
    indexer[52] = 18; // 4
    indexer[53] = 19; // 5
    indexer[54] = 20; // 6
    indexer[55] = 21; // 7
    indexer[56] = 22; // 8
    indexer[57] = 23; // 9
    indexer[58] = 24; // :
    indexer[59] = 25; // ;
    indexer[63] = 26; // ?

    // A-Z: 27-52
    for (let i = 0; i < 26; i++) {
      indexer[65 + i] = 27 + i;
    }

    // a-z: 53-78
    for (let i = 0; i < 26; i++) {
      indexer[97 + i] = 53 + i;
    }

    return indexer;
  }

  /**
   * Check if the processor is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.indexer !== null;
  }

  /**
   * Convert text to vocabulary indices for Supertonic
   * Each character is mapped to its vocabulary index using the unicode_indexer
   * NOTE: Text should already be normalized (with language tags) before calling this
   *
   * @param text - Input text to convert (should be already normalized)
   * @returns BigInt64Array of vocabulary indices
   */
  textToUnicodeIds(text: string): BigInt64Array {
    if (!this.indexer) {
      throw new Error('UnicodeProcessor not initialized');
    }

    // Text should already be normalized with language tags
    // We just convert characters to vocabulary indices
    const ids = new BigInt64Array(text.length);

    for (let i = 0; i < text.length; i++) {
      const codePoint = text.codePointAt(i) ?? 0;

      // Look up the vocabulary index from the indexer array
      // indexer[codePoint] gives the vocab index, or -1 if unmapped
      let vocabIdx = -1;
      if (codePoint < this.indexer.length) {
        vocabIdx = this.indexer[codePoint] ?? -1;
      }

      if (vocabIdx >= 0) {
        ids[i] = BigInt(vocabIdx);
      } else {
        // Unknown character - map to space (0)
        ids[i] = BigInt(UNK_TOKEN_ID);
      }
    }

    return ids;
  }

  /**
   * Process text for Supertonic input
   * Returns all tensors needed for the duration predictor and text encoder
   *
   * @param text - Input text to process
   * @returns Object containing text_ids and text_mask tensors
   */
  process(text: string): {
    textIds: BigInt64Array;
    textMask: Float32Array;
    sequenceLength: number;
  } {
    const textIds = this.textToUnicodeIds(text);
    const textMask = createTextMask(textIds.length);

    return {
      textIds,
      textMask,
      sequenceLength: textIds.length,
    };
  }

  /**
   * Normalize text before processing
   *
   * @param text - Input text
   * @param lang - Language code (default: 'en')
   * @returns Normalized text (with language tags for v2 models)
   */
  normalize(text: string, lang: string = 'en'): string {
    return normalizeText(text, lang, this.supportsLanguageTags);
  }

  /**
   * Check if this processor supports language tags (v2 models)
   */
  hasLanguageTagSupport(): boolean {
    return this.supportsLanguageTags;
  }
}

/**
 * Legacy function for backward compatibility
 * Uses default hardcoded indexer - prefer UnicodeProcessor.textToUnicodeIds() instead
 * @deprecated Use UnicodeProcessor class instead
 */
export function textToUnicodeIds(
  text: string,
  lang: string = 'en',
): BigInt64Array {
  // Default hardcoded indexer for backward compatibility
  const defaultIndexer = buildDefaultIndexer();
  const normalized = normalizeText(text, lang);
  const ids = new BigInt64Array(normalized.length);

  for (let i = 0; i < normalized.length; i++) {
    const codePoint = normalized.codePointAt(i) ?? 0;
    const vocabIdx = defaultIndexer.get(codePoint);
    if (vocabIdx !== undefined) {
      ids[i] = BigInt(vocabIdx);
    } else {
      ids[i] = BigInt(UNK_TOKEN_ID);
    }
  }

  return ids;
}

/**
 * Build default unicode indexer for backward compatibility
 * This is the basic ASCII mapping - the actual model may have a different indexer
 */
function buildDefaultIndexer(): Map<number, number> {
  const indexer = new Map<number, number>();

  indexer.set(32, 0); // space
  indexer.set(33, 1); // !
  indexer.set(34, 2); // "
  indexer.set(36, 3); // $
  indexer.set(37, 4); // %
  indexer.set(38, 5); // &
  indexer.set(39, 6); // '
  indexer.set(40, 7); // (
  indexer.set(41, 8); // )
  indexer.set(42, 9); // *
  indexer.set(43, 10); // +
  indexer.set(44, 11); // ,
  indexer.set(45, 12); // -
  indexer.set(46, 13); // .
  indexer.set(48, 14); // 0
  indexer.set(49, 15); // 1
  indexer.set(50, 16); // 2
  indexer.set(51, 17); // 3
  indexer.set(52, 18); // 4
  indexer.set(53, 19); // 5
  indexer.set(54, 20); // 6
  indexer.set(55, 21); // 7
  indexer.set(56, 22); // 8
  indexer.set(57, 23); // 9
  indexer.set(58, 24); // :
  indexer.set(59, 25); // ;
  indexer.set(63, 26); // ?

  // A-Z: 27-52
  for (let i = 0; i < 26; i++) {
    indexer.set(65 + i, 27 + i);
  }

  // a-z: 53-78
  for (let i = 0; i < 26; i++) {
    indexer.set(97 + i, 53 + i);
  }

  return indexer;
}
