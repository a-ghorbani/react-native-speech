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

  /**
   * Load voice embeddings from binary data
   * Format: [voice_id_length(4bytes)][voice_id][embedding_dim(4bytes)][embedding_data(float32[])]...
   */
  async loadFromBinary(data: ArrayBuffer): Promise<void> {
    const view = new DataView(data);
    let offset = 0;

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
      } catch (error) {
        console.warn(`Failed to load voice at offset ${offset}:`, error);
        break;
      }
    }

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
   * Get voice embedding by ID
   */
  getVoiceEmbedding(voiceId: string): Float32Array {
    if (!this.isInitialized) {
      throw new Error('VoiceLoader not initialized');
    }

    const embedding = this.voiceEmbeddings.get(voiceId);
    if (!embedding) {
      throw new Error(`Voice not found: ${voiceId}`);
    }

    return embedding;
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
  blendVoices(voiceIds: string[], weights: number[]): Float32Array {
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

    const firstEmbedding = this.getVoiceEmbedding(firstVoiceId);
    const embeddingDim = firstEmbedding.length;

    // Create blended embedding
    const blended = new Float32Array(embeddingDim);

    for (let i = 0; i < voiceIds.length; i++) {
      const voiceId = voiceIds[i];
      const weight = normalizedWeights[i];

      if (!voiceId || weight === undefined) {
        continue;
      }

      const embedding = this.getVoiceEmbedding(voiceId);

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
