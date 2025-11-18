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
  // Version 1.0 (multi-language)
  '1.0': {
    full: `${MODEL_BASE_URL}/hexgrad/Kokoro-82M/resolve/main/kokoro-v1.0.onnx`,
    fp16: `${MODEL_BASE_URL}/hexgrad/Kokoro-82M/resolve/main/kokoro-v1.0-fp16.onnx`,
    q8: `${MODEL_BASE_URL}/hexgrad/Kokoro-82M/resolve/main/kokoro-v1.0-q8.onnx`,
    quantized: `${MODEL_BASE_URL}/hexgrad/Kokoro-82M/resolve/main/kokoro-v1.0-quantized.onnx`,
  },
  // Version 1.1 English
  '1.1-en': {
    full: `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.1-en-ONNX/resolve/main/model.onnx`,
    fp16: `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.1-en-ONNX/resolve/main/model_fp16.onnx`,
    q8: `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.1-en-ONNX/resolve/main/model_q8.onnx`,
    quantized: `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.1-en-ONNX/resolve/main/model_q8.onnx`,
  },
};

const VOICES_URLS: Record<string, string> = {
  '1.0': `${MODEL_BASE_URL}/hexgrad/Kokoro-82M/resolve/main/voices-v1.0.bin`,
  '1.1-en': `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.1-en-ONNX/resolve/main/voices.bin`,
};

const VOCAB_URLS: Record<string, string> = {
  '1.0': `${MODEL_BASE_URL}/hexgrad/Kokoro-82M/resolve/main/vocab.json`,
  '1.1-en': `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.1-en-ONNX/resolve/main/vocab.json`,
};

const MERGES_URLS: Record<string, string> = {
  '1.0': `${MODEL_BASE_URL}/hexgrad/Kokoro-82M/resolve/main/merges.txt`,
  '1.1-en': `${MODEL_BASE_URL}/onnx-community/Kokoro-82M-v1.1-en-ONNX/resolve/main/merges.txt`,
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
    // Platform-specific paths
    // In a real app, you might use react-native-fs or expo-file-system
    if (Platform.OS === 'ios') {
      // iOS: Use Documents directory
      return 'file://Documents/kokoro/models';
    } else {
      // Android: Use app's files directory
      return 'file:///data/data/com.yourapp/files/kokoro/models';
    }
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
        ? 'file://Assets' // iOS bundle path
        : 'file:///android_asset'; // Android assets path

    return {
      modelPath: `${basePath}/kokoro-v1.0-q8.onnx`,
      vocabPath: `${basePath}/vocab.json`,
      mergesPath: `${basePath}/merges.txt`,
      voicesPath: `${basePath}/voices-v1.0.bin`,
    };
  }

  /**
   * Download a model
   *
   * This is a placeholder implementation. In a real app, you would:
   * 1. Use a download library (react-native-fs, expo-file-system, etc.)
   * 2. Implement progress tracking
   * 3. Handle errors and retries
   * 4. Verify downloaded files
   */
  async downloadModel(variant: ModelVariant = 'q8'): Promise<void> {
    const modelUrl = MODEL_URLS[this.modelVersion]?.[variant];
    const voicesUrl = VOICES_URLS[this.modelVersion];
    const vocabUrl = VOCAB_URLS[this.modelVersion];
    const mergesUrl = MERGES_URLS[this.modelVersion];

    if (!modelUrl || !voicesUrl || !vocabUrl || !mergesUrl) {
      throw new Error(
        `Model ${this.modelVersion} variant ${variant} not found`,
      );
    }

    // TODO: Implement actual download logic
    // Example using fetch (basic, not recommended for large files):
    /*
    const modelsDir = this.getModelsDirectory();

    // Download model file
    const modelResponse = await fetch(modelUrl);
    const modelBlob = await modelResponse.blob();
    // Save to filesystem using react-native-fs or similar

    // Download supporting files
    const voicesResponse = await fetch(voicesUrl);
    const vocabResponse = await fetch(vocabUrl);
    const mergesResponse = await fetch(mergesUrl);

    // Track progress
    if (onProgress) {
      onProgress({
        totalBytes: modelBlob.size,
        downloadedBytes: modelBlob.size,
        progress: 1.0,
      });
    }
    */

    throw new Error(
      'Model download not implemented. Please implement using your preferred download library (react-native-fs, expo-file-system, etc.)',
    );
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
    this.installedModels.delete(key);

    // TODO: Delete files from filesystem
    // Example using react-native-fs:
    // await RNFS.unlink(modelPath);
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

    return {
      modelPath: `${modelsDir}/${modelKey}.onnx`,
      vocabPath: `${modelsDir}/${version}-vocab.json`,
      mergesPath: `${modelsDir}/${version}-merges.txt`,
      voicesPath: `${modelsDir}/${version}-voices.bin`,
    };
  }
}

// Singleton instance for convenience
export const kokoroModelManager = new KokoroModelManager();
