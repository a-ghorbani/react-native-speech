/**
 * Voice Embedding Loader for Pocket TTS
 *
 * Loads and manages voice embeddings for Pocket TTS.
 * Voice embeddings are multi-frame tensors [1, N, dim] produced by mimi_encoder.
 * They are fed as text_embeddings during the voice conditioning pass of flow_lm_main.
 *
 * Follows the same pattern as supertonic/StyleLoader.ts.
 */

import type {PocketVoice, PocketVoiceEmbedding} from '../../types';
import {loadAssetAsJSON} from '../../utils/AssetLoader';
import {POCKET_CONSTANTS} from './constants';
import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('Pocket', 'VoiceLoader');

/**
 * Voice manifest structure for lazy loading
 */
export interface VoiceEmbeddingManifest {
  /** Base URL for voice files */
  baseUrl: string;
  /** List of available voice IDs */
  voices: string[];
}

/**
 * Raw voice embedding data from JSON file.
 * Supports:
 * - Multi-frame: {data: [...], dims: [1, N, dim]}
 * - Flat array: {embedding: [...]} (legacy 512-dim format)
 * - Tensor format: {data: [...], dims: [...]}
 */
export interface RawVoiceEmbeddingData {
  data?: unknown;
  dims?: number[];
  embedding?: unknown;
  metadata?: unknown;
}

/**
 * Recursively flatten a nested array to a flat number array
 */
function flattenDeep(arr: unknown): number[] {
  const result: number[] = [];
  const stack = [arr];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push(current[i]);
      }
    } else if (typeof current === 'number') {
      result.push(current);
    }
  }

  return result;
}

/**
 * Convert various formats to Float32Array
 */
function toFloat32Array(data: unknown): Float32Array {
  if (Array.isArray(data)) {
    if (Array.isArray(data[0])) {
      return new Float32Array(flattenDeep(data));
    }
    return new Float32Array(data as number[]);
  }

  return new Float32Array(0);
}

export class VoiceEmbeddingLoader {
  private embeddings: Map<string, PocketVoiceEmbedding> = new Map();
  private voiceMetadata: Map<string, PocketVoice> = new Map();
  private manifest: VoiceEmbeddingManifest | null = null;
  private basePath = '';
  private initialized = false;
  /** Track in-progress loading to prevent race conditions */
  private loadingPromises: Map<string, Promise<PocketVoiceEmbedding>> =
    new Map();

  /**
   * Load voices from a manifest file (lazy loading mode).
   */
  async loadFromManifest(
    manifest: VoiceEmbeddingManifest,
    manifestPath: string,
  ): Promise<void> {
    this.manifest = manifest;

    // Derive base path from manifest path
    const pathParts = manifestPath.split('/');
    pathParts.pop();
    this.basePath = pathParts.join('/');

    for (const voiceId of manifest.voices) {
      const metadata = this.createVoiceMetadata(voiceId);
      this.voiceMetadata.set(voiceId, metadata);
    }

    this.initialized = true;
    log.info(`Loaded manifest with ${manifest.voices.length} voices`);
  }

  /**
   * Load a voice embedding from parsed JSON data.
   * Supports both multi-frame format {data, dims} and legacy flat format {embedding}.
   */
  loadEmbeddingFromData(voiceId: string, raw: RawVoiceEmbeddingData): void {
    let float32Data: Float32Array;
    let dims: number[];

    if (raw.data && raw.dims) {
      // Multi-frame format: {data: [...], dims: [1, N, dim]}
      float32Data = toFloat32Array(raw.data);
      dims = raw.dims;
    } else if (raw.embedding) {
      // Legacy flat format: {embedding: [...]}
      float32Data = toFloat32Array(raw.embedding);
      // Assume single-frame: [1, 1, dim]
      dims = [1, 1, float32Data.length];
    } else {
      throw new Error(
        `Voice embedding ${voiceId} missing required field (data+dims or embedding)`,
      );
    }

    if (float32Data.length === 0) {
      throw new Error(`Voice embedding ${voiceId}: empty after conversion.`);
    }

    const voiceEmbedding: PocketVoiceEmbedding = {
      voiceId,
      data: float32Data,
      dims,
    };

    this.embeddings.set(voiceId, voiceEmbedding);

    if (!this.voiceMetadata.has(voiceId)) {
      this.voiceMetadata.set(voiceId, this.createVoiceMetadata(voiceId));
    }

    log.debug(
      `Loaded voice ${voiceId}: dims=[${dims.join(',')}], elements=${float32Data.length}`,
    );
  }

  /**
   * Get voice embedding for a given voice ID.
   * Loads on-demand if using lazy loading.
   */
  async getVoiceEmbedding(voiceId: string): Promise<PocketVoiceEmbedding> {
    const cached = this.embeddings.get(voiceId);
    if (cached) {
      return cached;
    }

    const existingPromise = this.loadingPromises.get(voiceId);
    if (existingPromise) {
      return existingPromise;
    }

    if (this.manifest) {
      if (!this.manifest.voices.includes(voiceId)) {
        throw new Error(`Voice '${voiceId}' not found in manifest`);
      }

      const loadPromise = this.loadVoiceFile(voiceId).then(() => {
        this.loadingPromises.delete(voiceId);
        const loaded = this.embeddings.get(voiceId);
        if (!loaded) {
          throw new Error(`Failed to load voice '${voiceId}'`);
        }
        return loaded;
      });

      this.loadingPromises.set(voiceId, loadPromise);
      return loadPromise;
    }

    throw new Error(`Voice '${voiceId}' not found`);
  }

  /**
   * Load a voice file from disk or network
   */
  private async loadVoiceFile(voiceId: string): Promise<void> {
    let voicePath: string;

    if (this.manifest?.baseUrl) {
      voicePath = `${this.manifest.baseUrl}/${voiceId}.json`;
    } else {
      voicePath = `${this.basePath}/${voiceId}.json`;
    }

    log.debug(`Loading voice from: ${voicePath}`);

    try {
      const data = await loadAssetAsJSON<RawVoiceEmbeddingData>(voicePath);
      this.loadEmbeddingFromData(voiceId, data);
    } catch (error) {
      throw new Error(
        `Failed to load voice '${voiceId}': ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get all available voice IDs
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
  getVoices(language?: string): PocketVoice[] {
    const voices = Array.from(this.voiceMetadata.values());

    if (language) {
      return voices.filter(v => v.language === language);
    }

    return voices;
  }

  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Create voice metadata from voice ID.
   */
  private createVoiceMetadata(voiceId: string): PocketVoice {
    const builtinData =
      POCKET_CONSTANTS.VOICE_DATA[
        voiceId as keyof typeof POCKET_CONSTANTS.VOICE_DATA
      ];

    if (builtinData) {
      return {
        id: voiceId,
        name: builtinData.name,
        language: 'en',
        gender: builtinData.gender,
        description: builtinData.description,
        isBuiltin: true,
      };
    }

    return {
      id: voiceId,
      name: voiceId,
      language: 'en',
      isBuiltin: false,
    };
  }

  clear(): void {
    this.embeddings.clear();
    this.voiceMetadata.clear();
    this.loadingPromises.clear();
    this.manifest = null;
    this.basePath = '';
    this.initialized = false;
  }
}
