/**
 * Kitten TTS Model Manager - Multi-Variant Support
 *
 * Manages multiple Kitten TTS model variants from HuggingFace.
 * Each variant is fully self-contained: its own ONNX model + voices-manifest.
 *
 * Variants:
 * - micro: ~41MB, smallest/fastest
 * - nano-int8: ~24MB, quantized nano
 * - nano-fp32: ~57MB, full-precision nano
 * - mini: ~78MB, largest/highest quality
 */

import type {KittenConfig} from '@pocketpalai/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';

// Model variant keys
export type KittenVersion = 'micro' | 'nano-int8' | 'nano-fp32' | 'mini';

export interface KittenModelInfo {
  version: string;
  variant: KittenVersion;
  size: number;
  isInstalled: boolean;
  path?: string;
  languages: string[];
  description: string;
}

export interface ModelDownloadProgress {
  totalBytes: number;
  downloadedBytes: number;
  progress: number;
  currentFile?: string;
}

interface ModelVariantConfig {
  repo: string;
  onnxFilename: string;
  estimatedSize: number;
  description: string;
  quantization: string;
}

const HF_BASE_URL = 'https://huggingface.co';

const MODEL_VARIANTS: Record<KittenVersion, ModelVariantConfig> = {
  micro: {
    repo: 'palshub/kitten-tts-micro-0.8',
    onnxFilename: 'kitten_tts_micro_v0_8.onnx',
    estimatedSize: 41 * 1024 * 1024,
    description: 'Micro 0.8 — smallest, fastest',
    quantization: 'FP32',
  },
  'nano-int8': {
    repo: 'palshub/kitten-tts-nano-0.8-int8',
    onnxFilename: 'kitten_tts_nano_v0_8.onnx',
    estimatedSize: 24 * 1024 * 1024,
    description: 'Nano 0.8 — quantized INT8',
    quantization: 'INT8',
  },
  'nano-fp32': {
    repo: 'palshub/kitten-tts-nano-0.8-fp32',
    onnxFilename: 'kitten_tts_nano_v0_8.onnx',
    estimatedSize: 57 * 1024 * 1024,
    description: 'Nano 0.8 — full precision',
    quantization: 'FP32',
  },
  mini: {
    repo: 'palshub/kitten-tts-mini-0.8',
    onnxFilename: 'kitten_tts_mini_v0_8.onnx',
    estimatedSize: 78 * 1024 * 1024,
    description: 'Mini 0.8 — highest quality',
    quantization: 'FP32',
  },
};

// Files to download per variant
const VARIANT_FILES = (config: ModelVariantConfig) => [
  {
    name: 'kitten.onnx',
    url: `${HF_BASE_URL}/${config.repo}/resolve/main/${config.onnxFilename}`,
  },
  {
    name: 'voices-manifest.json',
    url: `${HF_BASE_URL}/${config.repo}/resolve/main/voices-manifest.json`,
  },
];

export class KittenModelManager {
  private installedModels: Map<KittenVersion, KittenModelInfo> = new Map();
  private activeVersion: KittenVersion = 'nano-fp32';

  getModelsDirectory(): string {
    return `${RNFS.DocumentDirectoryPath}/kitten/models`;
  }

  private getVariantDirectory(version: KittenVersion): string {
    return `${this.getModelsDirectory()}/${version}`;
  }

  /**
   * Get available model versions with their info
   */
  getAvailableVersions(): Array<{
    version: KittenVersion;
    description: string;
    quantization: string;
    estimatedSize: number;
    isInstalled: boolean;
  }> {
    return (Object.keys(MODEL_VARIANTS) as KittenVersion[]).map(version => {
      const config = MODEL_VARIANTS[version];
      return {
        version,
        description: config.description,
        quantization: config.quantization,
        estimatedSize: config.estimatedSize,
        isInstalled: this.installedModels.has(version),
      };
    });
  }

  setActiveVersion(version: KittenVersion): void {
    this.activeVersion = version;
  }

  getActiveVersion(): KittenVersion {
    return this.activeVersion;
  }

  /**
   * Download a specific Kitten model variant.
   * Downloads both ONNX model and voices-manifest from the variant's own repo.
   */
  async downloadModel(
    onProgress?: (progress: ModelDownloadProgress) => void,
    version?: KittenVersion,
  ): Promise<void> {
    const modelVersion = version || this.activeVersion;
    const config = MODEL_VARIANTS[modelVersion];
    const variantDir = this.getVariantDirectory(modelVersion);
    const files = VARIANT_FILES(config);

    await RNFS.mkdir(variantDir);

    let totalDownloaded = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const destPath = `${variantDir}/${file.name}`;

        // Skip if already exists
        const exists = await RNFS.exists(destPath);
        if (exists) {
          const stat = await RNFS.stat(destPath);
          totalDownloaded += Number(stat.size);
          onProgress?.({
            totalBytes: config.estimatedSize,
            downloadedBytes: totalDownloaded,
            progress: totalDownloaded / config.estimatedSize,
            currentFile: file.name,
          });
          continue;
        }

        console.log(
          `[KittenModelManager] Downloading ${file.name} (${modelVersion})...`,
        );

        const result = RNFS.downloadFile({
          fromUrl: file.url,
          toFile: destPath,
          background: false,
          discretionary: false,
          cacheable: false,
          progressInterval: 500,
          progress: res => {
            const current = totalDownloaded + res.bytesWritten;
            onProgress?.({
              totalBytes: config.estimatedSize,
              downloadedBytes: current,
              progress: Math.min(current / config.estimatedSize, 0.99),
              currentFile: file.name,
            });
          },
        });

        const response = await result.promise;
        if (response.statusCode !== 200) {
          throw new Error(
            `Failed to download ${file.name}: HTTP ${response.statusCode}`,
          );
        }

        const stat = await RNFS.stat(destPath);
        totalDownloaded += Number(stat.size);
        console.log(`[KittenModelManager] ${file.name} download complete`);
      }

      // Final progress
      onProgress?.({
        totalBytes: config.estimatedSize,
        downloadedBytes: totalDownloaded,
        progress: 1.0,
      });

      // Mark as installed
      this.installedModels.set(modelVersion, {
        version: modelVersion,
        variant: modelVersion,
        size: totalDownloaded,
        isInstalled: true,
        path: variantDir,
        languages: ['en'],
        description: config.description,
      });

      console.log(
        `[KittenModelManager] Model ${modelVersion} installed successfully`,
      );
    } catch (error) {
      await this.cleanupPartialDownload(variantDir);
      throw error;
    }
  }

  private async cleanupPartialDownload(dir: string): Promise<void> {
    try {
      const exists = await RNFS.exists(dir);
      if (exists) {
        await RNFS.unlink(dir);
      }
    } catch (error) {
      console.warn(`[KittenModelManager] Failed to cleanup ${dir}:`, error);
    }
  }

  /**
   * Get KittenConfig for the active (or specified) version.
   * Each variant has its own ONNX model and voices-manifest.
   */
  getDownloadedModelConfig(version?: KittenVersion): KittenConfig {
    const modelVersion = version || this.activeVersion;
    const variantDir = this.getVariantDirectory(modelVersion);
    return {
      modelPath: `file://${variantDir}/kitten.onnx`,
      voicesPath: `file://${variantDir}/voices-manifest.json`,
    };
  }

  /**
   * Scan for all installed model variants on startup
   */
  async scanInstalledModel(): Promise<void> {
    const versions = Object.keys(MODEL_VARIANTS) as KittenVersion[];
    await Promise.all(versions.map(v => this.checkModelInstallation(v)));

    // Only change active version if current selection is not installed
    if (this.installedModels.has(this.activeVersion)) {
      return;
    }

    // Fall back to first installed variant
    const preferenceOrder: KittenVersion[] = [
      'nano-fp32',
      'nano-int8',
      'micro',
      'mini',
    ];
    for (const v of preferenceOrder) {
      if (this.installedModels.has(v)) {
        this.activeVersion = v;
        return;
      }
    }
  }

  /**
   * Check if a specific variant is installed (both ONNX + manifest present)
   */
  async checkModelInstallation(version: KittenVersion): Promise<boolean> {
    const variantDir = this.getVariantDirectory(version);

    try {
      const onnxExists = await RNFS.exists(`${variantDir}/kitten.onnx`);
      const manifestExists = await RNFS.exists(
        `${variantDir}/voices-manifest.json`,
      );

      if (!onnxExists || !manifestExists) {
        this.installedModels.delete(version);
        return false;
      }

      const stat = await RNFS.stat(`${variantDir}/kitten.onnx`);
      const config = MODEL_VARIANTS[version];

      this.installedModels.set(version, {
        version,
        variant: version,
        size: Number(stat.size),
        isInstalled: true,
        path: variantDir,
        languages: ['en'],
        description: config.description,
      });

      return true;
    } catch {
      this.installedModels.delete(version);
      return false;
    }
  }

  getInstalledModel(): KittenModelInfo | null {
    return this.installedModels.get(this.activeVersion) || null;
  }

  getAllInstalledModels(): KittenModelInfo[] {
    return Array.from(this.installedModels.values());
  }

  /**
   * Delete a specific model variant (ONNX + manifest + cached voices).
   */
  async deleteModel(version?: KittenVersion): Promise<void> {
    const modelVersion = version || this.activeVersion;
    const variantDir = this.getVariantDirectory(modelVersion);

    try {
      const exists = await RNFS.exists(variantDir);
      if (exists) {
        await RNFS.unlink(variantDir);
      }
    } catch (error) {
      console.warn(`[KittenModelManager] Failed to delete model:`, error);
    }

    this.installedModels.delete(modelVersion);

    // If active version was deleted, switch to another installed one
    if (modelVersion === this.activeVersion) {
      const remaining = Array.from(this.installedModels.keys());
      if (remaining.length > 0) {
        this.activeVersion = remaining[0]!;
      }
    }
  }

  async isModelInstalled(version?: KittenVersion): Promise<boolean> {
    const modelVersion = version || this.activeVersion;
    return this.installedModels.has(modelVersion);
  }

  getEstimatedModelSize(version?: KittenVersion): number {
    const modelVersion = version || this.activeVersion;
    return MODEL_VARIANTS[modelVersion].estimatedSize;
  }
}

export const kittenModelManager = new KittenModelManager();
