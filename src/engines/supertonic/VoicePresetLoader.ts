/**
 * Voice Preset Loader for Supertonic
 *
 * Loads and manages voice presets (embeddings) for Supertonic TTS
 */

import type {SupertonicVoice} from '../../types';
import {loadAssetAsArrayBuffer} from './utils/AssetLoader';

export class VoicePresetLoader {
  private voicePresets: Map<string, Float32Array> = new Map();
  private voiceMetadata: Map<string, SupertonicVoice> = new Map();
  private loaded = false;

  /**
   * Load voice presets from binary file
   */
  async loadVoices(voicesPath: string): Promise<void> {
    try {
      const buffer = await loadAssetAsArrayBuffer(voicesPath);

      // Parse voice presets from binary file
      // Format: [num_voices (4 bytes)] followed by voice entries
      // Each entry: [voice_id_length (4 bytes)][voice_id (utf-8)][embedding_size (4 bytes)][embedding (float32)]

      const dataView = new DataView(buffer);
      let offset = 0;

      // Read number of voices
      const numVoices = dataView.getInt32(offset, true);
      offset += 4;

      for (let i = 0; i < numVoices; i++) {
        // Read voice ID length
        const idLength = dataView.getInt32(offset, true);
        offset += 4;

        // Read voice ID
        const idBytes = new Uint8Array(buffer, offset, idLength);
        const voiceId = new TextDecoder().decode(idBytes);
        offset += idLength;

        // Read embedding size
        const embeddingSize = dataView.getInt32(offset, true);
        offset += 4;

        // Read embedding
        const embedding = new Float32Array(buffer, offset, embeddingSize);
        offset += embeddingSize * 4; // 4 bytes per float32

        // Store voice preset
        this.voicePresets.set(voiceId, embedding);

        // Create metadata
        const metadata: SupertonicVoice = {
          id: voiceId,
          name: this.formatVoiceName(voiceId),
          language: 'en',
          description: `Supertonic voice preset ${voiceId}`,
        };
        this.voiceMetadata.set(voiceId, metadata);
      }

      this.loaded = true;
    } catch (error) {
      throw new Error(
        `Failed to load voice presets: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get voice preset embedding
   */
  getVoicePreset(voiceId: string): Float32Array {
    const preset = this.voicePresets.get(voiceId);
    if (!preset) {
      throw new Error(`Voice preset '${voiceId}' not found`);
    }
    return preset;
  }

  /**
   * Get all voice IDs
   */
  getVoiceIds(language?: string): string[] {
    const voices = Array.from(this.voiceMetadata.values());

    if (language) {
      return voices.filter(v => v.language === language).map(v => v.id);
    }

    return voices.map(v => v.id);
  }

  /**
   * Get all voices with metadata
   */
  getVoices(language?: string): SupertonicVoice[] {
    const voices = Array.from(this.voiceMetadata.values());

    if (language) {
      return voices.filter(v => v.language === language);
    }

    return voices;
  }

  /**
   * Check if voices are loaded
   */
  isReady(): boolean {
    return this.loaded && this.voicePresets.size > 0;
  }

  /**
   * Format voice ID to human-readable name
   */
  private formatVoiceName(voiceId: string): string {
    // Convert 'preset_1' to 'Preset 1'
    return voiceId
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
