/**
 * Style Loader for Supertonic TTS
 *
 * Loads and manages voice style embeddings for Supertonic.
 * Supertonic voice styles are JSON files containing:
 * - style_dp: Style embedding for duration predictor
 * - style_ttl: Style embedding for text-to-latent
 */

import type {SupertonicVoice, SupertonicVoiceStyle} from '../../types';
import {loadAssetAsJSON} from './utils/AssetLoader';

/**
 * Official voice names and descriptions from Supertonic demo
 * https://huggingface.co/spaces/Supertone/supertonic-2
 */
const OFFICIAL_VOICE_DATA: Record<
  string,
  {name: string; description: string; gender: 'f' | 'm'}
> = {
  F1: {
    name: 'Sarah',
    description:
      'A calm female voice with a slightly low tone; steady and composed.',
    gender: 'f',
  },
  F2: {
    name: 'Lily',
    description:
      'A bright, cheerful female voice; lively, playful, and youthful.',
    gender: 'f',
  },
  F3: {
    name: 'Jessica',
    description:
      'A clear, professional announcer-style female voice; articulate and broadcast-ready.',
    gender: 'f',
  },
  F4: {
    name: 'Olivia',
    description:
      'A crisp, confident female voice; distinct and expressive with strong delivery.',
    gender: 'f',
  },
  F5: {
    name: 'Emily',
    description:
      'A kind, gentle female voice; soft-spoken, calm, and naturally soothing.',
    gender: 'f',
  },
  M1: {
    name: 'Alex',
    description:
      'A lively, upbeat male voice with confident energy and a standard, clear tone.',
    gender: 'm',
  },
  M2: {
    name: 'James',
    description:
      'A deep, robust male voice; calm, composed, and serious with a grounded presence.',
    gender: 'm',
  },
  M3: {
    name: 'Robert',
    description:
      'A polished, authoritative male voice; confident and trustworthy.',
    gender: 'm',
  },
  M4: {
    name: 'Sam',
    description:
      'A soft, neutral-toned male voice; gentle and approachable with a youthful quality.',
    gender: 'm',
  },
  M5: {
    name: 'Daniel',
    description:
      'A warm, soft-spoken male voice; calm and soothing with a natural storytelling quality.',
    gender: 'm',
  },
};

/**
 * Voice manifest structure for lazy loading
 */
interface VoiceManifest {
  /** Base URL for voice files */
  baseUrl: string;
  /** List of available voice IDs */
  voices: string[];
}

/**
 * Raw voice style data from JSON file
 * Supports:
 * - HuggingFace tensor format: {data: [[[...]]], dims: [...], type: "float32"}
 * - Flat array format: [...]
 * - Nested array format: [[...], [...]]
 */
interface RawVoiceStyleData {
  style_dp?: any; // Can be tensor object or array
  style_ttl?: any; // Can be tensor object or array
  metadata?: any;
}

/**
 * Recursively flatten a nested array of any depth to a flat number array
 */
function flattenDeep(arr: any): number[] {
  const result: number[] = [];
  const stack = [arr];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      // Push in reverse order to maintain order
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
 * Supports:
 * - Tensor format: {type/dtype, dims, data: [[[...]]]} (HuggingFace style with nested arrays)
 * - Nested array: [[...], [...]] (any depth)
 * - Flat array: [...]
 */
function toFloat32Array(data: any): Float32Array {
  // Check for tensor format (HuggingFace style with nested data array)
  // Keys can be: data, dims, type (or dtype)
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    'data' in data
  ) {
    const tensorLike = data as any;
    if (Array.isArray(tensorLike.data)) {
      // Flatten the nested data array (can be 3D like [[[...]]])
      const flattened = flattenDeep(tensorLike.data);
      console.log(
        `[toFloat32Array] Tensor format with nested data, flattened length: ${flattened.length}`,
      );
      return new Float32Array(flattened);
    }
  }

  // Check if it's a nested array (any depth)
  if (Array.isArray(data)) {
    // Check if first element is also an array (nested)
    if (Array.isArray(data[0])) {
      const flattened = flattenDeep(data);
      console.log(
        `[toFloat32Array] Nested array flattened, length: ${flattened.length}`,
      );
      return new Float32Array(flattened);
    }
    // Flat array of numbers
    console.log(`[toFloat32Array] Flat array, length: ${data.length}`);
    return new Float32Array(data as number[]);
  }

  console.log(`[toFloat32Array] Unknown format, returning empty array`);
  return new Float32Array(0);
}

export class StyleLoader {
  private styles: Map<string, SupertonicVoiceStyle> = new Map();
  private voiceMetadata: Map<string, SupertonicVoice> = new Map();
  private manifest: VoiceManifest | null = null;
  private voicesBasePath: string = '';
  private isInitialized = false;
  /** Track in-progress loading to prevent race conditions */
  private loadingPromises: Map<string, Promise<SupertonicVoiceStyle>> =
    new Map();

  /**
   * Load voices from a manifest file (lazy loading mode)
   * Voices will be loaded on-demand when requested
   *
   * @param manifest - Voice manifest data
   * @param manifestPath - Path to the manifest file (used to derive base path)
   */
  async loadFromManifest(
    manifest: VoiceManifest,
    manifestPath: string,
  ): Promise<void> {
    this.manifest = manifest;

    // Derive base path from manifest path
    // If manifest is at /path/to/voices-manifest.json, base is /path/to/
    const pathParts = manifestPath.split('/');
    pathParts.pop(); // Remove filename
    this.voicesBasePath = pathParts.join('/');

    // Create metadata for all voices in manifest
    for (const voiceId of manifest.voices) {
      const metadata = this.createVoiceMetadata(voiceId);
      this.voiceMetadata.set(voiceId, metadata);
    }

    this.isInitialized = true;
    console.log(
      `[StyleLoader] Loaded manifest with ${manifest.voices.length} voices`,
    );
  }

  /**
   * Load voices from a directory path
   * Scans the directory for voice JSON files
   *
   * @param voicesPath - Path to voices directory
   */
  async loadFromDirectory(voicesPath: string): Promise<void> {
    this.voicesBasePath = voicesPath;

    // For directory mode, we'll need the manifest or voice list
    // Since we can't list directory contents in React Native easily,
    // we require a manifest file
    throw new Error(
      'Directory loading requires a manifest file. Use loadFromManifest() instead.',
    );
  }

  /**
   * Load a voice style from JSON data.
   * Validates that required fields exist and converted arrays are not empty.
   *
   * @param voiceId - Voice identifier
   * @param data - Raw voice style JSON data
   * @throws Error if required fields are missing or conversion fails
   */
  loadVoiceFromData(voiceId: string, data: RawVoiceStyleData): void {
    if (!data.style_dp || !data.style_ttl) {
      throw new Error(
        `Voice style ${voiceId} missing required fields (style_dp, style_ttl)`,
      );
    }

    // Debug: log what we received
    console.log(
      `[StyleLoader] Raw style_dp type: ${typeof data.style_dp}, keys: ${typeof data.style_dp === 'object' ? Object.keys(data.style_dp).join(',') : 'N/A'}`,
    );
    console.log(
      `[StyleLoader] Raw style_ttl type: ${typeof data.style_ttl}, keys: ${typeof data.style_ttl === 'object' ? Object.keys(data.style_ttl).join(',') : 'N/A'}`,
    );

    const styleDp = toFloat32Array(data.style_dp);
    const styleTtl = toFloat32Array(data.style_ttl);

    // Validate converted arrays are not empty
    if (styleDp.length === 0) {
      throw new Error(
        `Voice style ${voiceId}: style_dp is empty after conversion. ` +
          `Data format may be unsupported.`,
      );
    }
    if (styleTtl.length === 0) {
      throw new Error(
        `Voice style ${voiceId}: style_ttl is empty after conversion. ` +
          `Data format may be unsupported.`,
      );
    }

    console.log(
      `[StyleLoader] Converted styleDp length: ${styleDp.length}, styleTtl length: ${styleTtl.length}`,
    );

    const style: SupertonicVoiceStyle = {
      voiceId,
      styleDp,
      styleTtl,
    };

    this.styles.set(voiceId, style);

    // Add metadata if not already present
    if (!this.voiceMetadata.has(voiceId)) {
      this.voiceMetadata.set(voiceId, this.createVoiceMetadata(voiceId));
    }

    console.log(
      `[StyleLoader] Loaded voice ${voiceId}: styleDp=${style.styleDp.length}, styleTtl=${style.styleTtl.length}`,
    );
  }

  /**
   * Get voice style for a given voice ID
   * Loads the voice on-demand if using lazy loading.
   * Uses promise caching to prevent race conditions when multiple
   * concurrent calls request the same voice.
   *
   * @param voiceId - Voice identifier
   * @returns Voice style data
   */
  async getVoiceStyle(voiceId: string): Promise<SupertonicVoiceStyle> {
    // Check if already loaded
    const cached = this.styles.get(voiceId);
    if (cached) {
      return cached;
    }

    // Check if already loading (prevents race condition)
    const existingPromise = this.loadingPromises.get(voiceId);
    if (existingPromise) {
      return existingPromise;
    }

    // Try lazy loading from manifest
    if (this.manifest) {
      if (!this.manifest.voices.includes(voiceId)) {
        throw new Error(`Voice '${voiceId}' not found in manifest`);
      }

      // Create loading promise and cache it
      const loadPromise = this.loadVoiceFile(voiceId).then(() => {
        // Clean up loading promise after completion
        this.loadingPromises.delete(voiceId);
        const loaded = this.styles.get(voiceId);
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
   *
   * @param voiceId - Voice identifier
   */
  private async loadVoiceFile(voiceId: string): Promise<void> {
    let voicePath: string;

    if (this.manifest?.baseUrl) {
      // Remote loading from HuggingFace or similar
      voicePath = `${this.manifest.baseUrl}/${voiceId}.json`;
    } else {
      // Local file loading
      voicePath = `${this.voicesBasePath}/${voiceId}.json`;
    }

    console.log(`[StyleLoader] Loading voice from: ${voicePath}`);

    try {
      const data = await loadAssetAsJSON(voicePath);
      this.loadVoiceFromData(voiceId, data);
    } catch (error) {
      throw new Error(
        `Failed to load voice '${voiceId}': ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get all available voice IDs
   *
   * @param language - Optional language filter (currently only 'en' supported)
   * @returns Array of voice IDs
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
   *
   * @param language - Optional language filter
   * @returns Array of voice objects with metadata
   */
  getVoices(language?: string): SupertonicVoice[] {
    const voices = Array.from(this.voiceMetadata.values());

    if (language) {
      return voices.filter(v => v.language === language);
    }

    return voices;
  }

  /**
   * Check if the style loader is ready
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Check if a voice is already loaded (cached)
   *
   * @param voiceId - Voice identifier
   * @returns True if voice is loaded
   */
  isVoiceLoaded(voiceId: string): boolean {
    return this.styles.has(voiceId);
  }

  /**
   * Preload a specific voice
   *
   * @param voiceId - Voice identifier to preload
   */
  async preloadVoice(voiceId: string): Promise<void> {
    if (!this.styles.has(voiceId)) {
      await this.getVoiceStyle(voiceId);
    }
  }

  /**
   * Preload all voices (for offline use)
   */
  async preloadAllVoices(): Promise<void> {
    const voiceIds = this.getVoiceIds();
    for (const voiceId of voiceIds) {
      await this.preloadVoice(voiceId);
    }
    console.log(`[StyleLoader] Preloaded ${voiceIds.length} voices`);
  }

  /**
   * Create voice metadata from voice ID
   *
   * Uses official voice names and descriptions from Supertonic demo.
   * Supertonic voice IDs follow format: {gender}{number}
   * - F1, F2, F3... = Female voices
   * - M1, M2, M3... = Male voices
   */
  private createVoiceMetadata(voiceId: string): SupertonicVoice {
    // Check for official Supertonic voice data
    const officialData = OFFICIAL_VOICE_DATA[voiceId];
    if (officialData) {
      return {
        id: voiceId,
        name: officialData.name,
        language: 'en',
        gender: officialData.gender,
        description: officialData.description,
      };
    }

    // Fallback for unknown voice IDs
    let name = voiceId;
    let gender: 'f' | 'm' = 'f';

    // Check for Supertonic format: F1, F2, M1, M2, etc.
    const supertonicMatch = voiceId.match(/^([FM])(\d+)$/);
    if (supertonicMatch) {
      const [, genderCode, voiceNumber] = supertonicMatch;
      gender = genderCode === 'M' ? 'm' : 'f';
      const genderName = gender === 'f' ? 'Female' : 'Male';
      name = `${genderName} ${voiceNumber}`;

      return {
        id: voiceId,
        name,
        language: 'en',
        gender,
        description: `Supertonic ${genderName.toLowerCase()} voice ${voiceNumber}`,
      };
    }

    return {
      id: voiceId,
      name,
      language: 'en',
      gender,
      description: `Supertonic ${gender === 'f' ? 'female' : 'male'} voice`,
    };
  }

  /**
   * Clear all cached voices and pending loads
   */
  clear(): void {
    this.styles.clear();
    this.voiceMetadata.clear();
    this.loadingPromises.clear();
    this.manifest = null;
    this.voicesBasePath = '';
    this.isInitialized = false;
  }
}
