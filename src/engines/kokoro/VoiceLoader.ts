/**
 * Voice Loader for Kokoro TTS
 *
 * Loads and manages voice embeddings from the voices.bin file
 */

import type {KokoroVoice} from '../../types';

export class VoiceLoader {
  private voiceEmbeddings: Map<string, Float32Array> = new Map();
  private availableVoices: KokoroVoice[] = [];
  private isInitialized = false;

  // Lazy loading support
  private manifestBaseUrl?: string;
  private manifestVoicesDir?: string;
  private lazyLoadingEnabled = false;

  /**
   * Load voice embeddings from binary data
   * Format: [voice_id_length(4bytes)][voice_id][embedding_dim(4bytes)][embedding_data(float32[])]...
   */
  async loadFromBinary(data: ArrayBuffer): Promise<void> {
    console.log(
      '[VoiceLoader] loadFromBinary called, data size:',
      data.byteLength,
    );
    const view = new DataView(data);
    let offset = 0;
    let voiceCount = 0;

    while (offset < data.byteLength) {
      try {
        // Read voice ID length
        const idLength = view.getUint32(offset, true);
        offset += 4;

        // Read voice ID
        const idBytes = new Uint8Array(data, offset, idLength);
        const voiceId = new TextDecoder().decode(idBytes);
        offset += idLength;

        // Read embedding dimension
        const embeddingDim = view.getUint32(offset, true);
        offset += 4;

        // Read embedding data
        const embedding = new Float32Array(data, offset, embeddingDim);
        offset += embeddingDim * 4; // 4 bytes per float32

        // Store embedding
        this.voiceEmbeddings.set(voiceId, new Float32Array(embedding));

        // Parse voice metadata from ID
        const voiceInfo = this.parseVoiceId(voiceId);
        this.availableVoices.push(voiceInfo);
        voiceCount++;
      } catch (error) {
        console.warn(
          `[VoiceLoader] Failed to load voice at offset ${offset}:`,
          error,
        );
        break;
      }
    }

    console.log('[VoiceLoader] Loaded', voiceCount, 'voices');
    console.log(
      '[VoiceLoader] Voice IDs:',
      Array.from(this.voiceEmbeddings.keys()),
    );
    this.isInitialized = true;
  }

  /**
   * Load voice embeddings from simplified JSON format (for testing/development)
   */
  async loadFromJSON(data: Record<string, number[]>): Promise<void> {
    for (const [voiceId, embeddingArray] of Object.entries(data)) {
      this.voiceEmbeddings.set(voiceId, new Float32Array(embeddingArray));

      const voiceInfo = this.parseVoiceId(voiceId);
      this.availableVoices.push(voiceInfo);
    }

    this.isInitialized = true;
  }

  /**
   * Load voice embeddings from manifest (lazy loading mode)
   * Voices will be downloaded on-demand when requested
   */
  async loadFromManifest(
    manifest: {baseUrl: string; voices: string[]},
    manifestPath: string,
  ): Promise<void> {
    console.log(
      '[VoiceLoader] Loading from manifest, voices:',
      manifest.voices.length,
    );

    this.manifestBaseUrl = manifest.baseUrl;
    this.lazyLoadingEnabled = true;

    // Extract voices directory from manifest path
    // e.g., "file:///path/to/models/kokoro/q8/voices-manifest.json" -> "file:///path/to/models/kokoro/q8/voices"
    const lastSlash = manifestPath.lastIndexOf('/');
    const baseDir = manifestPath.substring(0, lastSlash);
    this.manifestVoicesDir = `${baseDir}/voices`;

    console.log('[VoiceLoader] Voices directory:', this.manifestVoicesDir);

    // Create voice metadata for all available voices (without loading embeddings)
    for (const voiceId of manifest.voices) {
      const voiceInfo = this.parseVoiceId(voiceId);
      this.availableVoices.push(voiceInfo);
    }

    this.isInitialized = true;
    console.log(
      '[VoiceLoader] Lazy loading initialized with',
      this.availableVoices.length,
      'voices',
    );
  }

  /**
   * Get voice embedding by ID and token count
   * In lazy loading mode, downloads the voice file if not cached
   *
   * The voice files contain 510 style embeddings (one for each possible input length from 0 to 509 tokens).
   * Each embedding is 256 floats (STYLE_DIM).
   * Total: 510 × 256 = 130,560 floats (522,240 bytes)
   *
   * @param voiceId - The voice ID
   * @param numTokens - The number of tokens in the input (used to select the appropriate style embedding)
   */
  async getVoiceEmbedding(
    voiceId: string,
    numTokens: number = 0,
  ): Promise<Float32Array> {
    const STYLE_DIM = 256;
    const MAX_TOKENS = 509;

    if (!this.isInitialized) {
      throw new Error('VoiceLoader not initialized');
    }

    // Check if voice data is already loaded
    let fullVoiceData = this.voiceEmbeddings.get(voiceId);
    if (!fullVoiceData) {
      // If lazy loading is enabled, try to load the voice
      if (this.lazyLoadingEnabled) {
        console.log('[VoiceLoader] Lazy loading voice:', voiceId);
        fullVoiceData = await this.lazyLoadVoice(voiceId);
        if (!fullVoiceData) {
          throw new Error(`Voice not found: ${voiceId}`);
        }
      } else {
        throw new Error(`Voice not found: ${voiceId}`);
      }
    }

    // Clamp numTokens to valid range [0, 509]
    // Subtract 2 from token count (as per kokoro.js implementation)
    const adjustedTokens = Math.min(Math.max(numTokens - 2, 0), MAX_TOKENS);

    // Calculate offset based on number of tokens
    const offset = adjustedTokens * STYLE_DIM;

    // Extract the appropriate style embedding
    const embedding = fullVoiceData.slice(offset, offset + STYLE_DIM);

    console.log(
      '[VoiceLoader] Selected embedding for',
      voiceId,
      'with',
      numTokens,
      'tokens (adjusted:',
      adjustedTokens,
      '), offset:',
      offset,
    );

    return embedding;
  }

  /**
   * Lazy load a voice file from cache or download it
   */
  private async lazyLoadVoice(
    voiceId: string,
  ): Promise<Float32Array | undefined> {
    if (!this.manifestVoicesDir || !this.manifestBaseUrl) {
      return undefined;
    }

    try {
      const localPath = `${this.manifestVoicesDir}/${voiceId}.bin`;

      // Check if file exists locally
      const {loadAssetAsArrayBuffer} = require('./utils/AssetLoader');

      let voiceData: ArrayBuffer;

      try {
        // Try to load from local cache
        console.log('[VoiceLoader] Loading from cache:', localPath);
        voiceData = await loadAssetAsArrayBuffer(localPath);
      } catch (error) {
        // Not cached, download it
        console.log('[VoiceLoader] Downloading voice:', voiceId);
        const remoteUrl = `${this.manifestBaseUrl}/${voiceId}.bin`;

        const response = await fetch(remoteUrl);
        if (!response.ok) {
          throw new Error(`Failed to download voice: ${response.statusText}`);
        }

        voiceData = await response.arrayBuffer();

        // Cache it for next time (using React Native FS)
        // Note: This requires RNFS to be available in the library context
        // For now, we'll just keep it in memory
        console.log(
          '[VoiceLoader] Downloaded voice, size:',
          voiceData.byteLength,
        );
      }

      // Convert ArrayBuffer to Float32Array
      const fullArray = new Float32Array(voiceData);

      // The voice files contain 130560 floats (510 embeddings × 256 floats each)
      // We cache the full array and extract the appropriate embedding based on token count
      // Cache the full voice data in memory
      this.voiceEmbeddings.set(voiceId, fullArray);

      console.log(
        '[VoiceLoader] Voice loaded:',
        voiceId,
        'total embeddings:',
        fullArray.length / 256,
        'total floats:',
        fullArray.length,
      );
      return fullArray;
    } catch (error) {
      console.error('[VoiceLoader] Failed to lazy load voice:', voiceId, error);
      return undefined;
    }
  }

  /**
   * Get list of available voices
   */
  getAvailableVoices(language?: string): KokoroVoice[] {
    if (!this.isInitialized) {
      return [];
    }

    if (language) {
      const lang = language.toLowerCase().slice(0, 2);
      return this.availableVoices.filter(v => v.language === lang);
    }

    return this.availableVoices;
  }

  /**
   * Blend multiple voices together
   */
  async blendVoices(
    voiceIds: string[],
    weights: number[],
    numTokens: number = 0,
  ): Promise<Float32Array> {
    if (voiceIds.length !== weights.length) {
      throw new Error('Voice IDs and weights must have same length');
    }

    if (voiceIds.length === 0) {
      throw new Error('Must provide at least one voice');
    }

    // Normalize weights
    const sum = weights.reduce((a, b) => a + b, 0);
    const normalizedWeights = weights.map(w => w / sum);

    // Get first voice to determine embedding dimension
    const firstVoiceId = voiceIds[0];
    if (!firstVoiceId) {
      throw new Error('Invalid voice ID at index 0');
    }

    const firstEmbedding = await this.getVoiceEmbedding(
      firstVoiceId,
      numTokens,
    );
    const embeddingDim = firstEmbedding.length;

    // Create blended embedding
    const blended = new Float32Array(embeddingDim);

    for (let i = 0; i < voiceIds.length; i++) {
      const voiceId = voiceIds[i];
      const weight = normalizedWeights[i];

      if (!voiceId || weight === undefined) {
        continue;
      }

      const embedding = await this.getVoiceEmbedding(voiceId, numTokens);

      for (let j = 0; j < embeddingDim; j++) {
        const embVal = embedding[j];
        const blendedVal = blended[j];
        if (embVal !== undefined && blendedVal !== undefined) {
          blended[j] = blendedVal + embVal * weight;
        }
      }
    }

    return blended;
  }

  /**
   * Check if voice loader is ready
   */
  isReady(): boolean {
    // In lazy loading mode, we're ready if initialized (even with no loaded voices)
    if (this.lazyLoadingEnabled) {
      return this.isInitialized && this.availableVoices.length > 0;
    }
    // In eager loading mode, we need at least one voice loaded
    return this.isInitialized && this.voiceEmbeddings.size > 0;
  }

  /**
   * Parse voice ID to extract metadata
   * Format examples:
   * - af_bella -> female, English, name: Bella
   * - am_michael -> male, English, name: Michael
   * - zh_f1 -> female, Chinese, ID: 1
   */
  private parseVoiceId(voiceId: string): KokoroVoice {
    const parts = voiceId.split('_');
    const firstPart = parts[0];

    // Determine gender
    let gender: 'male' | 'female' = 'female';
    if (firstPart === 'am' || firstPart?.endsWith('m')) {
      gender = 'male';
    } else if (firstPart === 'af' || firstPart?.endsWith('f')) {
      gender = 'female';
    }

    // Determine language
    let language: 'en' | 'zh' | 'ko' | 'ja' = 'en';
    if (firstPart === 'zh' || voiceId.startsWith('zh_')) {
      language = 'zh';
    } else if (firstPart === 'ko' || voiceId.startsWith('ko_')) {
      language = 'ko';
    } else if (firstPart === 'ja' || voiceId.startsWith('ja_')) {
      language = 'ja';
    }

    // Create human-readable name
    let name = voiceId;
    if (parts.length > 1 && parts[1]) {
      // Capitalize first letter
      name = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    }

    return {
      id: voiceId,
      name,
      gender,
      language,
      description: `${gender === 'male' ? 'Male' : 'Female'} ${this.getLanguageName(language)} voice`,
    };
  }

  /**
   * Get human-readable language name
   */
  private getLanguageName(code: string): string {
    const names: Record<string, string> = {
      en: 'English',
      zh: 'Chinese',
      ko: 'Korean',
      ja: 'Japanese',
    };
    return names[code] || code;
  }
}
