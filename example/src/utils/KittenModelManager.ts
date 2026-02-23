/**
 * Kitten TTS Model Manager - Example Implementation
 *
 * Manages Kitten TTS model downloads from HuggingFace.
 * Uses manifest-based lazy loading: only the ONNX model + voice manifest
 * are downloaded upfront (~57 MB). Individual voice files (~2 MB each)
 * are fetched on-demand when first used and cached to disk.
 *
 * Kitten TTS uses:
 * 1. kitten.onnx - Single StyleTTS 2 model (~56 MB FP32)
 * 2. voices-manifest.json - Lists available voices + remote base URL
 * 3. voices/{name}.json - Downloaded lazily per-voice
 */

import type {KittenConfig} from '@mhpdev/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';

export interface KittenModelInfo {
  version: string;
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

// HuggingFace model repository
const HF_REPO =
  'https://huggingface.co/palshub/kitten-tts-nano-0.8-fp32/resolve/main';

// Model files to download
// Uses manifest-based lazy loading: only ONNX + manifest are downloaded upfront.
// Individual voice files (~2 MB each) are fetched on-demand when first used.
const MODEL_FILES = [
  {
    name: 'kitten.onnx',
    url: `${HF_REPO}/kitten_tts_nano_v0_8.onnx`,
    size: 56 * 1024 * 1024,
  },
  {
    name: 'voices-manifest.json',
    url: `${HF_REPO}/voices-manifest.json`,
    size: 1 * 1024,
  },
];

const ESTIMATED_TOTAL_SIZE = MODEL_FILES.reduce((sum, f) => sum + f.size, 0);

export class KittenModelManager {
  private installedModel: KittenModelInfo | null = null;

  getModelsDirectory(): string {
    return `${RNFS.DocumentDirectoryPath}/kitten/models`;
  }

  getModelDirectory(): string {
    return `${this.getModelsDirectory()}/v1`;
  }

  /**
   * Download Kitten TTS model files from HuggingFace
   */
  async downloadModel(
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<void> {
    const modelDir = this.getModelDirectory();

    // Create directories
    await RNFS.mkdir(modelDir);

    let totalDownloaded = 0;

    for (const file of MODEL_FILES) {
      const destPath = `${modelDir}/${file.name}`;

      // Skip if already exists
      const exists = await RNFS.exists(destPath);
      if (exists) {
        const stat = await RNFS.stat(destPath);
        totalDownloaded += Number(stat.size);
        onProgress?.({
          totalBytes: ESTIMATED_TOTAL_SIZE,
          downloadedBytes: totalDownloaded,
          progress: totalDownloaded / ESTIMATED_TOTAL_SIZE,
          currentFile: file.name,
        });
        continue;
      }

      // Download file
      const result = RNFS.downloadFile({
        fromUrl: file.url,
        toFile: destPath,
        progress: res => {
          const current = totalDownloaded + res.bytesWritten;
          onProgress?.({
            totalBytes: ESTIMATED_TOTAL_SIZE,
            downloadedBytes: current,
            progress: current / ESTIMATED_TOTAL_SIZE,
            currentFile: file.name,
          });
        },
        progressInterval: 500,
      });

      const response = await result.promise;
      if (response.statusCode !== 200) {
        throw new Error(
          `Failed to download ${file.name}: HTTP ${response.statusCode}`,
        );
      }

      const stat = await RNFS.stat(destPath);
      totalDownloaded += Number(stat.size);
    }

    // Verify installation
    const installed = await this.checkModelInstallation();
    if (!installed) {
      throw new Error('Model files incomplete after download');
    }
  }

  /**
   * Get KittenConfig with paths to downloaded model files
   */
  getDownloadedModelConfig(): KittenConfig {
    const modelDir = this.getModelDirectory();
    return {
      modelPath: `file://${modelDir}/kitten.onnx`,
      voicesPath: `file://${modelDir}/voices-manifest.json`,
    };
  }

  /**
   * Scan for installed model files
   */
  async scanInstalledModel(): Promise<void> {
    const installed = await this.checkModelInstallation();
    if (installed) {
      const modelDir = this.getModelDirectory();
      let totalSize = 0;
      for (const file of MODEL_FILES) {
        try {
          const stat = await RNFS.stat(`${modelDir}/${file.name}`);
          totalSize += Number(stat.size);
        } catch {
          // File may not exist
        }
      }
      this.installedModel = {
        version: 'v0.8-nano',
        size: totalSize,
        isInstalled: true,
        path: modelDir,
        languages: ['en'],
        description: 'Kitten TTS Nano 0.8 (FP32, ~56MB)',
      };
    } else {
      this.installedModel = null;
    }
  }

  getInstalledModel(): KittenModelInfo | null {
    return this.installedModel;
  }

  /**
   * Delete all Kitten model files
   */
  async deleteModel(): Promise<void> {
    const modelsDir = this.getModelsDirectory();
    const exists = await RNFS.exists(modelsDir);
    if (exists) {
      await RNFS.unlink(modelsDir);
    }
    this.installedModel = null;
  }

  /**
   * Check if all required model files are present
   */
  async checkModelInstallation(): Promise<boolean> {
    const modelDir = this.getModelDirectory();

    for (const file of MODEL_FILES) {
      const filePath = `${modelDir}/${file.name}`;
      const exists = await RNFS.exists(filePath);
      if (!exists) {
        return false;
      }
    }

    return true;
  }
}

export const kittenModelManager = new KittenModelManager();
