/**
 * Kokoro Model Manager - Example Implementation
 *
 * This is a reference implementation showing how apps can manage
 * Kokoro TTS models. Apps are free to implement their own model
 * management strategy based on their needs.
 *
 * This example demonstrates:
 * - Bundled models (shipped with the app)
 * - Downloaded models (on-demand download)
 * - Model metadata tracking
 * - Platform-specific path resolution
 */

import {Platform} from 'react-native';
import type {KokoroConfig} from '@mhpdev/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';

// Model variant types
export type ModelVariant = 'full' | 'fp16' | 'q8' | 'quantized';

// Model information
export interface ModelInfo {
  version: string;
  variant: ModelVariant;
  size: number;
  isInstalled: boolean;
  path?: string;
  languages: string[];
}

// Download progress callback
export interface ModelDownloadProgress {
  totalBytes: number;
  downloadedBytes: number;
  progress: number;
  speed?: number;
  estimatedTimeRemaining?: number;
}

// Model URLs (Hugging Face)
const MODEL_BASE_URL = 'https://huggingface.co';

const MODEL_URLS: Record<string, Record<ModelVariant, string>> = {
  // Version 1.0 (multi-language) - using onnx-community repo
  '1.0': {
    full: `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx`,
    fp16: `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_fp16.onnx`,
    q8: `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx`,
    quantized: `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx`,
  },
};

const VOCAB_URLS: Record<string, string> = {
  '1.0': `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/tokenizer.json`,
};

// Kokoro v1.0 uses individual voice files in the voices/ folder
// We create a manifest file that points to the HuggingFace repository
// Voices will be lazy-loaded on demand
const VOICES_BASE_URLS: Record<string, string> = {
  '1.0': `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices`,
};

// List of available voices for each version
const AVAILABLE_VOICES: Record<string, string[]> = {
  '1.0': [
    'af_heart',
    'af_alloy',
    'af_aoede',
    'af_bella',
    'af_jessica',
    'af_kore',
    'af_nicole',
    'af_nova',
    'af_river',
    'af_sarah',
    'af_sky',
    'am_adam',
    'am_echo',
    'am_eric',
    'am_fenrir',
    'am_liam',
    'am_michael',
    'am_onyx',
    'am_puck',
    'am_santa',
    'bf_emma',
    'bf_isabella',
    'bm_george',
    'bm_lewis',
    'bf_alice',
    'bf_lily',
    'bm_daniel',
    'bm_fable',
  ],
};

/**
 * Example Model Manager for Kokoro TTS
 *
 * This class demonstrates how to manage Kokoro models in your app.
 * You can customize this based on your app's requirements:
 * - Use different download libraries (react-native-fs, expo-file-system, etc.)
 * - Implement different storage strategies
 * - Add caching, versioning, or CDN support
 */
export class KokoroModelManager {
  private modelVersion = '1.0'; // Default to v1.0
  private installedModels: Map<string, ModelInfo> = new Map();

  /**
   * Get path to models directory
   * This is where downloaded models will be stored
   */
  getModelsDirectory(): string {
    // Use DocumentDirectoryPath for both iOS and Android
    return `${RNFS.DocumentDirectoryPath}/kokoro/models`;
  }

  /**
   * Get bundled model configuration
   *
   * This assumes you've bundled the Kokoro models with your app.
   * To bundle models:
   *
   * iOS:
   * 1. Add model files to Xcode project
   * 2. Ensure they're in "Copy Bundle Resources"
   * 3. Access via NSBundle.mainBundle
   *
   * Android:
   * 1. Place files in android/app/src/main/assets/
   * 2. Access via AssetManager
   */
  getBundledModelConfig(): KokoroConfig {
    const basePath =
      Platform.OS === 'ios'
        ? RNFS.MainBundlePath // iOS bundle path
        : 'file:///android_asset'; // Android assets path

    // Use HuggingFace tokenizer format (same as downloaded models)
    return {
      modelPath: `${basePath}/kokoro-v1.0-q8.onnx`,
      tokenizerPath: `${basePath}/tokenizer.json`,
      voicesPath: `${basePath}/voices-manifest.json`,
    };
  }

  /**
   * Download a model with progress tracking
   */
  async downloadModel(
    variant: ModelVariant = 'q8',
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<void> {
    const modelUrl = MODEL_URLS[this.modelVersion]?.[variant];
    const voicesBaseUrl = VOICES_BASE_URLS[this.modelVersion];
    const vocabUrl = VOCAB_URLS[this.modelVersion];
    const availableVoices = AVAILABLE_VOICES[this.modelVersion];

    if (!modelUrl || !voicesBaseUrl || !vocabUrl || !availableVoices) {
      throw new Error(
        `Model ${this.modelVersion} variant ${variant} not found`,
      );
    }

    const modelsDir = this.getModelsDirectory();
    const modelKey = `${this.modelVersion}-${variant}`;

    // Create models directory if it doesn't exist
    await RNFS.mkdir(modelsDir, {NSURLIsExcludedFromBackupKey: true});

    // Define file paths
    const modelPath = `${modelsDir}/${modelKey}.onnx`;
    const vocabPath = `${modelsDir}/${this.modelVersion}-tokenizer.json`;
    const manifestPath = `${modelsDir}/${this.modelVersion}-voices-manifest.json`;

    try {
      // Download files with progress tracking (only model and tokenizer)
      let totalDownloaded = 0;
      const files = [
        {url: modelUrl, path: modelPath, name: 'model'},
        {url: vocabUrl, path: vocabPath, name: 'tokenizer'},
      ];

      // Get total size (approximate - we'll update as we download)
      let totalBytes = 0;

      for (const file of files) {
        console.log(`Downloading ${file.name} from ${file.url}...`);

        const downloadResult = await RNFS.downloadFile({
          fromUrl: file.url,
          toFile: file.path,
          background: false,
          discretionary: false,
          cacheable: false,
          progressInterval: 500,
          begin: res => {
            console.log(
              `${file.name}: Begin download, size: ${res.contentLength}`,
            );
            totalBytes += res.contentLength;
          },
          progress: res => {
            const fileProgress = res.bytesWritten / res.contentLength;
            const overallProgress =
              (totalDownloaded + res.bytesWritten) / totalBytes;

            if (onProgress) {
              onProgress({
                totalBytes,
                downloadedBytes: totalDownloaded + res.bytesWritten,
                progress: overallProgress,
              });
            }

            console.log(
              `${file.name}: ${(fileProgress * 100).toFixed(1)}% (${res.bytesWritten}/${res.contentLength})`,
            );
          },
        }).promise;

        if (downloadResult.statusCode !== 200) {
          throw new Error(
            `Failed to download ${file.name}: HTTP ${downloadResult.statusCode}`,
          );
        }

        // Update total downloaded
        const fileInfo = await RNFS.stat(file.path);
        totalDownloaded += fileInfo.size;

        console.log(`${file.name}: Download complete`);
      }

      // Create voices manifest file
      const manifest = {
        baseUrl: voicesBaseUrl,
        voices: availableVoices,
      };

      await RNFS.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      console.log('Voices manifest created:', manifestPath);

      // Mark model as installed
      this.installedModels.set(modelKey, {
        version: this.modelVersion,
        variant,
        size: totalDownloaded,
        isInstalled: true,
        path: modelPath,
        languages:
          this.modelVersion === '1.1-en' ? ['en'] : ['en', 'ja', 'zh', 'ko'],
      });

      console.log(`Model ${modelKey} downloaded successfully`);
    } catch (error) {
      // Clean up partial downloads
      await this.cleanupPartialDownload(modelPath, vocabPath, manifestPath);
      throw error;
    }
  }

  /**
   * Clean up partial downloads
   */
  private async cleanupPartialDownload(...paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        const exists = await RNFS.exists(path);
        if (exists) {
          await RNFS.unlink(path);
        }
      } catch (error) {
        console.warn(`Failed to cleanup ${path}:`, error);
      }
    }
  }

  /**
   * Check if a model is installed
   */
  async isModelInstalled(
    version: string,
    variant: ModelVariant,
  ): Promise<boolean> {
    const key = `${version}-${variant}`;
    return this.installedModels.has(key);
  }

  /**
   * Get installed models
   */
  getInstalledModels(): ModelInfo[] {
    return Array.from(this.installedModels.values());
  }

  /**
   * Delete a model
   */
  async deleteModel(version: string, variant: ModelVariant): Promise<void> {
    const key = `${version}-${variant}`;
    const modelsDir = this.getModelsDirectory();

    // Delete model files
    const modelPath = `${modelsDir}/${key}.onnx`;
    const manifestPath = `${modelsDir}/${version}-voices-manifest.json`;
    const tokenizerPath = `${modelsDir}/${version}-tokenizer.json`;

    try {
      if (await RNFS.exists(modelPath)) {
        await RNFS.unlink(modelPath);
      }
      // Only delete shared files if no other variants of this version exist
      const otherVariants = Array.from(this.installedModels.keys()).filter(
        k => k.startsWith(`${version}-`) && k !== key,
      );
      if (otherVariants.length === 0) {
        if (await RNFS.exists(manifestPath)) {
          await RNFS.unlink(manifestPath);
        }
        if (await RNFS.exists(tokenizerPath)) {
          await RNFS.unlink(tokenizerPath);
        }
      }
    } catch (error) {
      console.warn(`Failed to delete model files for ${key}:`, error);
    }

    this.installedModels.delete(key);
  }

  /**
   * Get model info
   */
  getModelInfo(version: string, variant: ModelVariant): ModelInfo | undefined {
    const key = `${version}-${variant}`;
    return this.installedModels.get(key);
  }

  /**
   * Set active model version
   */
  setModelVersion(version: string): void {
    if (!MODEL_URLS[version]) {
      throw new Error(`Model version ${version} not supported`);
    }
    this.modelVersion = version;
  }

  /**
   * Get active model version
   */
  getModelVersion(): string {
    return this.modelVersion;
  }

  /**
   * Get configuration for a downloaded model
   */
  getDownloadedModelConfig(
    version: string,
    variant: ModelVariant,
  ): KokoroConfig {
    const modelsDir = this.getModelsDirectory();
    const modelKey = `${version}-${variant}`;

    const config = {
      modelPath: `file://${modelsDir}/${modelKey}.onnx`,
      tokenizerPath: `file://${modelsDir}/${version}-tokenizer.json`,
      voicesPath: `file://${modelsDir}/${version}-voices-manifest.json`,
    };

    console.log('[ModelManager] Generated config:', config);
    return config;
  }

  /**
   * Get list of available models for download
   */
  getAvailableModels(): Array<{version: string; variants: ModelVariant[]}> {
    return Object.keys(MODEL_URLS).map(version => ({
      version,
      variants: Object.keys(MODEL_URLS[version]!) as ModelVariant[],
    }));
  }

  /**
   * Check if model files exist on disk
   */
  async checkModelInstallation(
    version: string,
    variant: ModelVariant,
  ): Promise<boolean> {
    const modelsDir = this.getModelsDirectory();
    const modelKey = `${version}-${variant}`;

    const modelPath = `${modelsDir}/${modelKey}.onnx`;
    const manifestPath = `${modelsDir}/${version}-voices-manifest.json`;
    const tokenizerPath = `${modelsDir}/${version}-tokenizer.json`;

    try {
      const [modelExists, manifestExists, tokenizerExists] = await Promise.all([
        RNFS.exists(modelPath),
        RNFS.exists(manifestPath),
        RNFS.exists(tokenizerPath),
      ]);

      const isInstalled = modelExists && manifestExists && tokenizerExists;

      // Update installed models map
      if (isInstalled && !this.installedModels.has(modelKey)) {
        const fileInfo = await RNFS.stat(modelPath);
        this.installedModels.set(modelKey, {
          version,
          variant,
          size: fileInfo.size,
          isInstalled: true,
          path: modelPath,
          languages: ['en', 'ja', 'zh', 'ko'], // v1.0 supports all languages
        });
      }

      return isInstalled;
    } catch (error) {
      console.warn(
        `Failed to check model installation for ${modelKey}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Scan models directory and update installed models list
   */
  async scanInstalledModels(): Promise<void> {
    const modelsDir = this.getModelsDirectory();

    try {
      const dirExists = await RNFS.exists(modelsDir);
      if (!dirExists) {
        return;
      }

      // Check all known model versions and variants
      for (const version of Object.keys(MODEL_URLS)) {
        for (const variant of Object.keys(
          MODEL_URLS[version]!,
        ) as ModelVariant[]) {
          await this.checkModelInstallation(version, variant);
        }
      }
    } catch (error) {
      console.warn('Failed to scan installed models:', error);
    }
  }
}

// Singleton instance for convenience
export const kokoroModelManager = new KokoroModelManager();
