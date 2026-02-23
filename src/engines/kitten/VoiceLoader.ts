/**
 * Voice Loader for Kitten TTS
 *
 * Loads and manages voice style embeddings for Kitten synthesis.
 * Kitten uses length-dependent voice styling: the embedding selected
 * depends on the raw text length, capped at the voice array's max index.
 *
 * Formula: ref_id = min(len(text), voices[voice].shape[0] - 1)
 *
 * Supports:
 * - Pre-converted JSON voice data (from NPZ via convert script)
 * - Manifest-based lazy loading
 */

import * as RNFS from '@dr.pogodin/react-native-fs';
import type {KittenVoice} from '../../types/Kitten';
import {KITTEN_BUILTIN_VOICES} from './constants';
import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('Kitten', 'VoiceLoader');

/**
 * Voice data structure after NPZ-to-JSON conversion.
 * Each voice entry contains a flat array of embeddings and shape metadata.
 */
interface VoiceData {
  /** Flattened embedding data (shape[0] * shape[1] floats) */
  data: Float32Array;
  /** Original shape [numEmbeddings, embeddingDim] */
  shape: [number, number];
}

export class VoiceLoader {
  private voices: Map<string, VoiceData> = new Map();
  private availableVoices: KittenVoice[] = [];
  private isInitialized = false;

  // Lazy loading support
  private manifestBaseUrl?: string;
  private manifestVoicesDir?: string;
  private lazyLoadingEnabled = false;
  private pendingLoads: Map<string, Promise<VoiceData | undefined>> = new Map();

  /**
   * Load voice data from pre-converted JSON.
   * Expected format (output of convert-kitten-voices.py):
   * {
   *   "Bella": { "embeddings": [[...], [...], ...], "shape": [N, D] },
   *   "Jasper": { "embeddings": [[...], [...], ...], "shape": [N, D] },
   *   ...
   * }
   */
  async loadFromJSON(
    data: Record<string, {embeddings: number[][]; shape: number[]}>,
  ): Promise<void> {
    for (const [voiceId, voiceEntry] of Object.entries(data)) {
      const shape: [number, number] = [
        voiceEntry.shape[0]!,
        voiceEntry.shape[1]!,
      ];

      // Flatten the 2D embeddings array into a 1D Float32Array
      const totalFloats = shape[0] * shape[1];
      const flatData = new Float32Array(totalFloats);
      let offset = 0;
      for (const row of voiceEntry.embeddings) {
        for (const val of row) {
          flatData[offset++] = val;
        }
      }

      this.voices.set(voiceId, {data: flatData, shape});

      // Add voice metadata from builtins or create from ID
      const builtin = KITTEN_BUILTIN_VOICES.find(v => v.id === voiceId);
      if (builtin) {
        this.availableVoices.push(builtin);
      } else {
        this.availableVoices.push({
          id: voiceId,
          name: voiceId,
          gender: 'female',
          language: 'en',
        });
      }
    }

    this.isInitialized = true;
    log.info(`Loaded ${this.voices.size} voices from JSON`);
  }

  /**
   * Load voices from a manifest file (lazy loading mode).
   * Voices are downloaded on-demand when first requested.
   */
  async loadFromManifest(
    manifest: {baseUrl?: string; voices: string[]},
    manifestPath: string,
  ): Promise<void> {
    this.manifestBaseUrl = manifest.baseUrl;
    this.lazyLoadingEnabled = true;

    // Extract directory from manifest path (strip file:// prefix for local FS ops)
    const cleanPath = manifestPath.replace(/^file:\/\//, '');
    const lastSlash = cleanPath.lastIndexOf('/');
    const baseDir = cleanPath.substring(0, lastSlash);
    this.manifestVoicesDir = `${baseDir}/voices`;

    // Register available voices without loading data
    for (const voiceId of manifest.voices) {
      const builtin = KITTEN_BUILTIN_VOICES.find(v => v.id === voiceId);
      if (builtin) {
        this.availableVoices.push(builtin);
      } else {
        this.availableVoices.push({
          id: voiceId,
          name: voiceId,
          gender: 'female',
          language: 'en',
        });
      }
    }

    this.isInitialized = true;
    log.info(
      `Manifest loaded: ${manifest.voices.length} voices available (lazy loading)`,
    );
  }

  /**
   * Get the style embedding for a voice, selected by raw text length.
   *
   * Kitten uses length-dependent voice styling:
   *   ref_id = min(len(text), N - 1)
   *   style = voices[voice][ref_id]
   *
   * @param voiceId - Voice name (e.g., 'Bella')
   * @param textLength - Length of the raw input text (before phonemization)
   * @returns Float32Array of shape [D] — the style embedding
   */
  async getStyleEmbedding(
    voiceId: string,
    textLength: number,
  ): Promise<Float32Array> {
    if (!this.isInitialized) {
      throw new Error('VoiceLoader not initialized');
    }

    let voiceData = this.voices.get(voiceId);

    if (!voiceData) {
      if (this.lazyLoadingEnabled) {
        voiceData = await this.lazyLoadVoice(voiceId);
        if (!voiceData) {
          throw new Error(`Voice not found: ${voiceId}`);
        }
      } else {
        throw new Error(`Voice not found: ${voiceId}`);
      }
    }

    const [numEmbeddings, embeddingDim] = voiceData.shape;

    // Length-dependent indexing: ref_id = min(textLength, N - 1)
    const refId = Math.min(Math.max(textLength, 0), numEmbeddings - 1);

    // Extract the embedding at refId
    const offset = refId * embeddingDim;
    return voiceData.data.slice(offset, offset + embeddingDim);
  }

  /**
   * Get list of available voices
   */
  getAvailableVoices(): KittenVoice[] {
    return this.availableVoices;
  }

  /**
   * Check if voice loader is ready
   */
  isReady(): boolean {
    if (this.lazyLoadingEnabled) {
      return this.isInitialized && this.availableVoices.length > 0;
    }
    return this.isInitialized && this.voices.size > 0;
  }

  /**
   * Clear all voice data and reset.
   */
  clear(): void {
    this.voices.clear();
    this.availableVoices = [];
    this.pendingLoads.clear();
    this.manifestBaseUrl = undefined;
    this.manifestVoicesDir = undefined;
    this.lazyLoadingEnabled = false;
    this.isInitialized = false;
  }

  /**
   * Lazy load a voice from cache or download.
   * Race-condition safe via pendingLoads map.
   */
  private async lazyLoadVoice(voiceId: string): Promise<VoiceData | undefined> {
    const pending = this.pendingLoads.get(voiceId);
    if (pending) {
      log.debug(`Waiting for pending load: ${voiceId}`);
      return pending;
    }

    const loadPromise = this.doLazyLoadVoice(voiceId);
    this.pendingLoads.set(voiceId, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.pendingLoads.delete(voiceId);
    }
  }

  private async doLazyLoadVoice(
    voiceId: string,
  ): Promise<VoiceData | undefined> {
    try {
      const localPath = `${this.manifestVoicesDir}/${voiceId}.json`;
      const {loadAssetAsJSON} = require('../../utils/AssetLoader');

      let voiceJSON: {embeddings: number[][]; shape: number[]};

      try {
        log.debug(`Loading voice from cache: ${voiceId}`);
        voiceJSON = await loadAssetAsJSON(`file://${localPath}`);
      } catch {
        if (!this.manifestBaseUrl) {
          log.error(`No base URL for downloading voice: ${voiceId}`);
          return undefined;
        }

        log.debug(`Downloading voice: ${voiceId}`);
        const remoteUrl = `${this.manifestBaseUrl}/${voiceId}.json`;
        const response = await fetch(remoteUrl);
        if (!response.ok) {
          throw new Error(`Failed to download: ${response.statusText}`);
        }
        const jsonText = await response.text();
        voiceJSON = JSON.parse(jsonText);

        // Cache to disk for future sessions
        try {
          await RNFS.mkdir(this.manifestVoicesDir!);
          await RNFS.writeFile(localPath, jsonText, 'utf8');
          log.debug(`Cached voice to disk: ${localPath}`);
        } catch (cacheErr) {
          log.warn(
            `Failed to cache voice ${voiceId}: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
          );
        }
      }

      const shape: [number, number] = [
        voiceJSON.shape[0]!,
        voiceJSON.shape[1]!,
      ];
      const totalFloats = shape[0] * shape[1];
      const flatData = new Float32Array(totalFloats);
      let offset = 0;
      for (const row of voiceJSON.embeddings) {
        for (const val of row) {
          flatData[offset++] = val;
        }
      }

      const voiceData: VoiceData = {data: flatData, shape};
      this.voices.set(voiceId, voiceData);

      log.debug(`Voice loaded: ${voiceId}, shape: [${shape[0]}, ${shape[1]}]`);
      return voiceData;
    } catch (error) {
      log.error(
        `Failed to lazy load voice ${voiceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}
