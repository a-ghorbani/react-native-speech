/**
 * Supertonic Model Manager - Example Implementation
 *
 * Manages Supertonic TTS models (4 ONNX files) for the example app.
 * Handles downloading from HuggingFace and local storage.
 * Supports both v1 (English-only) and v2 (multilingual) models.
 *
 * Supertonic uses 4 models:
 * 1. duration_predictor.onnx - predicts phoneme durations
 * 2. text_encoder.onnx - encodes text into embeddings
 * 3. vector_estimator.onnx - diffusion model for mel-spectrogram
 * 4. vocoder.onnx - converts mel-spectrogram to audio
 */

import {Platform} from 'react-native';
import type {SupertonicConfig} from '@mhpdev/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';

// Model version types
export type SupertonicVersion = 'v1' | 'v2';

// Model information
export interface SupertonicModelInfo {
  version: string;
  variant?: SupertonicVersion;
  size: number;
  isInstalled: boolean;
  path?: string;
  languages?: string[];
  description?: string;
}

// Download progress callback
export interface ModelDownloadProgress {
  totalBytes: number;
  downloadedBytes: number;
  progress: number;
  currentFile?: string;
}

// Model variant configuration
interface ModelVariantConfig {
  repo: string;
  estimatedSize: number;
  voices: string[];
  languages: string[];
  description: string;
}

// HuggingFace model URLs
const MODEL_BASE_URL = 'https://huggingface.co';

// Model variants configuration
const MODEL_VARIANTS: Record<SupertonicVersion, ModelVariantConfig> = {
  v1: {
    repo: 'Supertone/supertonic',
    estimatedSize: 265 * 1024 * 1024, // ~265MB
    voices: ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'],
    languages: ['en'],
    description: 'English-only, original model',
  },
  v2: {
    repo: 'Supertone/supertonic-2',
    estimatedSize: 265 * 1024 * 1024, // ~265MB (OnnxSlim optimized)
    voices: ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'],
    languages: ['en', 'ko', 'es', 'pt', 'fr'],
    description: 'Multilingual (EN, KO, ES, PT, FR), OnnxSlim optimized',
  },
};

/**
 * Get model file URLs for a specific version
 */
function getModelUrls(version: SupertonicVersion) {
  const config = MODEL_VARIANTS[version];
  return {
    durationPredictor: `${MODEL_BASE_URL}/${config.repo}/resolve/main/onnx/duration_predictor.onnx`,
    textEncoder: `${MODEL_BASE_URL}/${config.repo}/resolve/main/onnx/text_encoder.onnx`,
    vectorEstimator: `${MODEL_BASE_URL}/${config.repo}/resolve/main/onnx/vector_estimator.onnx`,
    vocoder: `${MODEL_BASE_URL}/${config.repo}/resolve/main/onnx/vocoder.onnx`,
    unicodeIndexer: `${MODEL_BASE_URL}/${config.repo}/resolve/main/onnx/unicode_indexer.json`,
  };
}

/**
 * Get voices base URL for a specific version
 */
function getVoicesBaseUrl(version: SupertonicVersion): string {
  const config = MODEL_VARIANTS[version];
  return `${MODEL_BASE_URL}/${config.repo}/resolve/main/voice_styles`;
}

/**
 * Supertonic Model Manager
 *
 * Handles downloading and managing Supertonic TTS models.
 * Supports multiple model versions (v1, v2).
 */
export class SupertonicModelManager {
  private installedModels: Map<SupertonicVersion, SupertonicModelInfo> =
    new Map();
  private activeVersion: SupertonicVersion = 'v1';

  /**
   * Get path to models directory
   */
  getModelsDirectory(): string {
    return `${RNFS.DocumentDirectoryPath}/supertonic/models`;
  }

  /**
   * Get available model versions with their info
   */
  getAvailableVersions(): Array<{
    version: SupertonicVersion;
    languages: string[];
    description: string;
    estimatedSize: number;
    isInstalled: boolean;
  }> {
    return Object.entries(MODEL_VARIANTS).map(([version, config]) => ({
      version: version as SupertonicVersion,
      languages: config.languages,
      description: config.description,
      estimatedSize: config.estimatedSize,
      isInstalled: this.installedModels.has(version as SupertonicVersion),
    }));
  }

  /**
   * Set active model version
   */
  setActiveVersion(version: SupertonicVersion): void {
    this.activeVersion = version;
  }

  /**
   * Get active model version
   */
  getActiveVersion(): SupertonicVersion {
    return this.activeVersion;
  }

  /**
   * Get bundled model configuration
   * Use this if you've bundled Supertonic models with your app
   */
  getBundledModelConfig(version?: SupertonicVersion): SupertonicConfig {
    const basePath =
      Platform.OS === 'ios' ? RNFS.MainBundlePath : 'file:///android_asset';

    const modelVersion = version || this.activeVersion;
    const subfolder = modelVersion === 'v2' ? 'supertonic-2' : 'supertonic';

    return {
      durationPredictorPath: `${basePath}/${subfolder}/duration_predictor.onnx`,
      textEncoderPath: `${basePath}/${subfolder}/text_encoder.onnx`,
      vectorEstimatorPath: `${basePath}/${subfolder}/vector_estimator.onnx`,
      vocoderPath: `${basePath}/${subfolder}/vocoder.onnx`,
      voicesPath: `${basePath}/${subfolder}/voices-manifest.json`,
    };
  }

  /**
   * Download Supertonic models with progress tracking
   */
  async downloadModel(
    onProgress?: (progress: ModelDownloadProgress) => void,
    version?: SupertonicVersion,
  ): Promise<void> {
    const modelVersion = version || this.activeVersion;
    const config = MODEL_VARIANTS[modelVersion];
    const modelUrls = getModelUrls(modelVersion);

    const modelsDir = this.getModelsDirectory();
    const modelDir = `${modelsDir}/${modelVersion}`;

    // Create directories
    await RNFS.mkdir(modelDir, {NSURLIsExcludedFromBackupKey: true});

    // Define file paths
    const files = [
      {
        name: 'duration_predictor',
        url: modelUrls.durationPredictor,
        path: `${modelDir}/duration_predictor.onnx`,
      },
      {
        name: 'text_encoder',
        url: modelUrls.textEncoder,
        path: `${modelDir}/text_encoder.onnx`,
      },
      {
        name: 'vector_estimator',
        url: modelUrls.vectorEstimator,
        path: `${modelDir}/vector_estimator.onnx`,
      },
      {
        name: 'vocoder',
        url: modelUrls.vocoder,
        path: `${modelDir}/vocoder.onnx`,
      },
      {
        name: 'unicode_indexer',
        url: modelUrls.unicodeIndexer,
        path: `${modelDir}/unicode_indexer.json`,
      },
    ];

    const manifestPath = `${modelDir}/voices-manifest.json`;

    let totalDownloaded = 0;

    try {
      // Download each model file
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        console.log(
          `[SupertonicModelManager] Downloading ${file.name} (${modelVersion})...`,
        );

        const downloadResult = await RNFS.downloadFile({
          fromUrl: file.url,
          toFile: file.path,
          background: false,
          discretionary: false,
          cacheable: false,
          progressInterval: 500,
          begin: res => {
            console.log(
              `[SupertonicModelManager] ${file.name}: Begin download, size: ${res.contentLength}`,
            );
          },
          progress: res => {
            const fileProgress = res.bytesWritten / (res.contentLength || 1);
            const overallProgress = (i + fileProgress) / (files.length + 1); // +1 for manifest

            if (onProgress) {
              onProgress({
                totalBytes: config.estimatedSize,
                downloadedBytes: totalDownloaded + res.bytesWritten,
                progress: overallProgress,
                currentFile: file.name,
              });
            }
          },
        }).promise;

        if (downloadResult.statusCode !== 200) {
          throw new Error(
            `Failed to download ${file.name}: HTTP ${downloadResult.statusCode}`,
          );
        }

        const fileInfo = await RNFS.stat(file.path);
        totalDownloaded += fileInfo.size;

        console.log(`[SupertonicModelManager] ${file.name}: Download complete`);
      }

      // Create voices manifest
      const manifest = {
        baseUrl: getVoicesBaseUrl(modelVersion),
        voices: config.voices,
      };

      await RNFS.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      console.log('[SupertonicModelManager] Voices manifest created');

      // Final progress update
      if (onProgress) {
        onProgress({
          totalBytes: config.estimatedSize,
          downloadedBytes: totalDownloaded,
          progress: 1.0,
        });
      }

      // Mark model as installed
      const modelInfo: SupertonicModelInfo = {
        version: modelVersion,
        variant: modelVersion,
        size: totalDownloaded,
        isInstalled: true,
        path: modelDir,
        languages: config.languages,
        description: config.description,
      };

      this.installedModels.set(modelVersion, modelInfo);

      console.log(
        `[SupertonicModelManager] Model ${modelVersion} installed successfully`,
      );
    } catch (error) {
      // Clean up partial downloads
      await this.cleanupPartialDownload(modelDir);
      throw error;
    }
  }

  /**
   * Clean up partial downloads
   */
  private async cleanupPartialDownload(dir: string): Promise<void> {
    try {
      const exists = await RNFS.exists(dir);
      if (exists) {
        await RNFS.unlink(dir);
      }
    } catch (error) {
      console.warn(`[SupertonicModelManager] Failed to cleanup ${dir}:`, error);
    }
  }

  /**
   * Check if a specific model version is installed
   */
  async isModelInstalled(version?: SupertonicVersion): Promise<boolean> {
    const modelVersion = version || this.activeVersion;
    return this.installedModels.has(modelVersion);
  }

  /**
   * Get installed model info for active version
   */
  getInstalledModel(): SupertonicModelInfo | null {
    return this.installedModels.get(this.activeVersion) || null;
  }

  /**
   * Get all installed models
   */
  getAllInstalledModels(): SupertonicModelInfo[] {
    return Array.from(this.installedModels.values());
  }

  /**
   * Delete a specific model version
   */
  async deleteModel(version?: SupertonicVersion): Promise<void> {
    const modelVersion = version || this.activeVersion;
    const modelsDir = this.getModelsDirectory();
    const modelDir = `${modelsDir}/${modelVersion}`;

    try {
      const exists = await RNFS.exists(modelDir);
      if (exists) {
        await RNFS.unlink(modelDir);
      }
    } catch (error) {
      console.warn(`[SupertonicModelManager] Failed to delete model:`, error);
    }

    this.installedModels.delete(modelVersion);
  }

  /**
   * Get configuration for a downloaded model version
   */
  getDownloadedModelConfig(version?: SupertonicVersion): SupertonicConfig {
    const modelVersion = version || this.activeVersion;
    const modelsDir = this.getModelsDirectory();
    const modelDir = `${modelsDir}/${modelVersion}`;

    return {
      durationPredictorPath: `file://${modelDir}/duration_predictor.onnx`,
      textEncoderPath: `file://${modelDir}/text_encoder.onnx`,
      vectorEstimatorPath: `file://${modelDir}/vector_estimator.onnx`,
      vocoderPath: `file://${modelDir}/vocoder.onnx`,
      voicesPath: `file://${modelDir}/voices-manifest.json`,
      unicodeIndexerPath: `file://${modelDir}/unicode_indexer.json`,
    };
  }

  /**
   * Check if model files exist on disk for a specific version
   */
  async checkModelInstallation(version: SupertonicVersion): Promise<boolean> {
    const config = MODEL_VARIANTS[version];
    const modelsDir = this.getModelsDirectory();
    const modelDir = `${modelsDir}/${version}`;

    const requiredFiles = [
      'duration_predictor.onnx',
      'text_encoder.onnx',
      'vector_estimator.onnx',
      'vocoder.onnx',
      'voices-manifest.json',
      'unicode_indexer.json',
    ];

    try {
      for (const file of requiredFiles) {
        const filePath = `${modelDir}/${file}`;
        const exists = await RNFS.exists(filePath);
        if (!exists) {
          return false;
        }
      }

      // Calculate total size
      let totalSize = 0;
      for (const file of requiredFiles.slice(0, 4)) {
        // Skip manifest
        const filePath = `${modelDir}/${file}`;
        const fileInfo = await RNFS.stat(filePath);
        totalSize += fileInfo.size;
      }

      const modelInfo: SupertonicModelInfo = {
        version: version,
        variant: version,
        size: totalSize,
        isInstalled: true,
        path: modelDir,
        languages: config.languages,
        description: config.description,
      };

      this.installedModels.set(version, modelInfo);

      return true;
    } catch (error) {
      console.warn(
        `[SupertonicModelManager] Failed to check installation for ${version}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Scan for all installed models on startup
   */
  async scanInstalledModel(): Promise<void> {
    // Check both v1 and v2
    await Promise.all([
      this.checkModelInstallation('v1'),
      this.checkModelInstallation('v2'),
    ]);

    // Set active version to first installed, prefer v2
    if (this.installedModels.has('v2')) {
      this.activeVersion = 'v2';
    } else if (this.installedModels.has('v1')) {
      this.activeVersion = 'v1';
    }
  }

  /**
   * Get model version (legacy compatibility)
   */
  getModelVersion(): string {
    return this.activeVersion;
  }

  /**
   * Get estimated model size for UI display
   */
  getEstimatedModelSize(version?: SupertonicVersion): number {
    const modelVersion = version || this.activeVersion;
    return MODEL_VARIANTS[modelVersion].estimatedSize;
  }

  /**
   * Get languages supported by a model version
   */
  getSupportedLanguages(version?: SupertonicVersion): string[] {
    const modelVersion = version || this.activeVersion;
    return MODEL_VARIANTS[modelVersion].languages;
  }
}

// Singleton instance
export const supertonicModelManager = new SupertonicModelManager();
