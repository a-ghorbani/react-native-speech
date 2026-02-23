/**
 * Pocket TTS Model Manager - Example Implementation
 *
 * Manages Pocket TTS models (4 ONNX files + SentencePiece tokenizer) for the example app.
 * Handles downloading from the community ONNX export repo on HuggingFace.
 *
 * Pocket TTS uses 4 ONNX models + a JS tokenizer:
 * 1. text_conditioner.onnx - converts token IDs to 512-dim embeddings
 * 2. flow_lm_main.onnx - autoregressive language model with KV cache
 * 3. flow_lm_flow.onnx - LSD flow matching for latent generation
 * 4. mimi_decoder.onnx - stateful neural audio codec decoder
 * 5. tokenizer.model - SentencePiece tokenizer (pure JS, not ONNX)
 *
 * Voice embeddings are generated from a reference audio sample using
 * mimi_encoder.onnx (downloaded temporarily, then deleted after encoding).
 */

import type {PocketConfig} from '@mhpdev/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';

// Model information
export interface PocketModelInfo {
  version: string;
  size: number;
  isInstalled: boolean;
  path?: string;
  languages: string[];
  description: string;
}

// Download progress callback
export interface ModelDownloadProgress {
  totalBytes: number;
  downloadedBytes: number;
  progress: number;
  currentFile?: string;
}

// All files come from the community ONNX export repo (public, no auth required)
const ONNX_REPO =
  'https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main';

// Estimated total download size (INT8 models + encoder + tokenizer + wav)
const ESTIMATED_SIZE = 200 * 1024 * 1024; // ~200MB (includes temporary mimi_encoder)

/**
 * Get model file URLs for download
 */
function getModelUrls() {
  return {
    // Core inference models (INT8 quantized where available)
    textConditioner: `${ONNX_REPO}/onnx/text_conditioner.onnx`,
    flowLmMain: `${ONNX_REPO}/onnx/flow_lm_main_int8.onnx`,
    flowLmFlow: `${ONNX_REPO}/onnx/flow_lm_flow_int8.onnx`,
    mimiDecoder: `${ONNX_REPO}/onnx/mimi_decoder_int8.onnx`,
    // Tokenizer
    tokenizer: `${ONNX_REPO}/tokenizer.model`,
    // Voice encoding (temporary - used to generate voice embedding, then deleted)
    mimiEncoder: `${ONNX_REPO}/onnx/mimi_encoder.onnx`,
    referenceAudio: `${ONNX_REPO}/reference_sample.wav`,
  };
}

/**
 * Parse a WAV file's raw bytes and extract mono float32 PCM samples.
 * Assumes 16-bit PCM or handles common WAV formats.
 */
function parseWavToFloat32(bytes: Uint8Array): {
  samples: Float32Array;
  sampleRate: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Read WAV header
  // Skip RIFF header (12 bytes), find 'data' chunk
  let offset = 12;
  let dataOffset = 0;
  let dataSize = 0;
  let bitsPerSample = 16;
  let numChannels = 1;
  let sampleRate = 24000;

  while (offset < bytes.length - 8) {
    const chunkId = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
    // Align to 2 bytes
    if (chunkSize % 2 !== 0) {
      offset += 1;
    }
  }

  if (dataOffset === 0) {
    throw new Error('No data chunk found in WAV file');
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataSize / (bytesPerSample * numChannels));
  const audio = new Float32Array(numSamples);

  if (bitsPerSample === 16) {
    for (let i = 0; i < numSamples; i++) {
      // Read first channel only (mono or left channel)
      const sampleOffset = dataOffset + i * bytesPerSample * numChannels;
      audio[i] = view.getInt16(sampleOffset, true) / 32768.0;
    }
  } else if (bitsPerSample === 32) {
    for (let i = 0; i < numSamples; i++) {
      const sampleOffset = dataOffset + i * bytesPerSample * numChannels;
      audio[i] = view.getFloat32(sampleOffset, true);
    }
  } else {
    throw new Error(`Unsupported bits per sample: ${bitsPerSample}`);
  }

  return {samples: audio, sampleRate};
}

/**
 * Resample audio from sourceSR to targetSR using linear interpolation.
 */
function resampleAudio(
  samples: Float32Array,
  sourceSR: number,
  targetSR: number,
): Float32Array {
  if (sourceSR === targetSR) {
    return samples;
  }

  const ratio = targetSR / sourceSR;
  const newLength = Math.round(samples.length * ratio);
  const resampled = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcPos = i / ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    const s0 = samples[srcIdx] ?? 0;
    const s1 = samples[Math.min(srcIdx + 1, samples.length - 1)] ?? 0;
    resampled[i] = s0 + (s1 - s0) * frac;
  }

  return resampled;
}

/**
 * Decode a base64 string to Uint8Array.
 * Works in React Native (Hermes) using global atob.
 */
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Pocket TTS Model Manager
 *
 * Handles downloading and managing Pocket TTS models.
 * Voice embeddings are generated from reference audio using mimi_encoder.
 */
export class PocketModelManager {
  private installedModel: PocketModelInfo | null = null;

  /**
   * Get path to models directory
   */
  getModelsDirectory(): string {
    return `${RNFS.DocumentDirectoryPath}/pocket/models`;
  }

  /**
   * Get estimated model size for UI display
   */
  getEstimatedModelSize(): number {
    return ESTIMATED_SIZE;
  }

  /**
   * Download Pocket TTS models with progress tracking.
   *
   * Downloads 4 inference models + tokenizer + mimi_encoder + reference audio.
   * After download, encodes the reference audio into a voice embedding using
   * mimi_encoder, then deletes the encoder model to save space (~73MB).
   */
  async downloadModel(
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<void> {
    const modelUrls = getModelUrls();
    const modelsDir = this.getModelsDirectory();
    const modelDir = `${modelsDir}/v1`;

    // Create directories
    await RNFS.mkdir(modelDir, {NSURLIsExcludedFromBackupKey: true});
    await RNFS.mkdir(`${modelDir}/embeddings`, {
      NSURLIsExcludedFromBackupKey: true,
    });

    // Define all files to download
    const files = [
      {
        name: 'text_conditioner',
        url: modelUrls.textConditioner,
        path: `${modelDir}/text_conditioner.onnx`,
      },
      {
        name: 'flow_lm_main',
        url: modelUrls.flowLmMain,
        path: `${modelDir}/flow_lm_main.onnx`,
      },
      {
        name: 'flow_lm_flow',
        url: modelUrls.flowLmFlow,
        path: `${modelDir}/flow_lm_flow.onnx`,
      },
      {
        name: 'mimi_decoder',
        url: modelUrls.mimiDecoder,
        path: `${modelDir}/mimi_decoder.onnx`,
      },
      {
        name: 'tokenizer',
        url: modelUrls.tokenizer,
        path: `${modelDir}/tokenizer.model`,
      },
      {
        name: 'mimi_encoder',
        url: modelUrls.mimiEncoder,
        path: `${modelDir}/mimi_encoder.onnx`,
        temporary: true, // Will be deleted after voice encoding
      },
      {
        name: 'reference_audio',
        url: modelUrls.referenceAudio,
        path: `${modelDir}/reference_sample.wav`,
        temporary: true,
      },
    ];

    let totalDownloaded = 0;

    try {
      // Download each file
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        console.log(`[PocketModelManager] Downloading ${file.name}...`);

        const downloadResult = await RNFS.downloadFile({
          fromUrl: file.url,
          toFile: file.path,
          background: false,
          discretionary: false,
          cacheable: false,
          progressInterval: 500,
          begin: res => {
            console.log(
              `[PocketModelManager] ${file.name}: Begin download, size: ${res.contentLength}`,
            );
          },
          progress: res => {
            const fileProgress = res.bytesWritten / (res.contentLength || 1);
            const overallProgress = (i + fileProgress) / (files.length + 1); // +1 for encoding step

            if (onProgress) {
              onProgress({
                totalBytes: ESTIMATED_SIZE,
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

        console.log(`[PocketModelManager] ${file.name}: Download complete`);
      }

      // Generate voice embedding from reference audio
      console.log(
        '[PocketModelManager] Encoding reference audio into voice embedding...',
      );
      if (onProgress) {
        onProgress({
          totalBytes: ESTIMATED_SIZE,
          downloadedBytes: totalDownloaded,
          progress: files.length / (files.length + 1),
          currentFile: 'encoding_voice',
        });
      }

      await this.encodeReferenceVoice(modelDir);

      // Clean up temporary files (mimi_encoder ~73MB, reference_sample ~286KB)
      console.log('[PocketModelManager] Cleaning up temporary files...');
      for (const file of files) {
        if ('temporary' in file && file.temporary) {
          try {
            await RNFS.unlink(file.path);
          } catch {
            // Ignore cleanup errors
          }
        }
      }

      // Create voice embeddings manifest
      const manifest = {
        voices: ['reference'],
      };

      const manifestPath = `${modelDir}/embeddings/voice-embeddings-manifest.json`;
      await RNFS.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      console.log('[PocketModelManager] Voice embeddings manifest created');

      // Final progress update
      if (onProgress) {
        onProgress({
          totalBytes: ESTIMATED_SIZE,
          downloadedBytes: totalDownloaded,
          progress: 1.0,
        });
      }

      // Mark model as installed
      this.installedModel = {
        version: 'v1',
        size: totalDownloaded,
        isInstalled: true,
        path: modelDir,
        languages: ['en'],
        description: 'CPU-optimized, INT8 quantized',
      };

      console.log('[PocketModelManager] Model installed successfully');
    } catch (error) {
      // Clean up partial downloads
      await this.cleanupPartialDownload(modelDir);
      throw error;
    }
  }

  /**
   * Encode reference audio into a voice embedding using mimi_encoder.
   * Saves the embedding as a JSON file with data array and dims.
   */
  private async encodeReferenceVoice(modelDir: string): Promise<void> {
    // Lazy-load ONNX Runtime
    const ort = require('onnxruntime-react-native');
    const InferenceSession = ort.InferenceSession;
    const OnnxTensor = ort.Tensor;

    const encoderPath = `${modelDir}/mimi_encoder.onnx`;
    const wavPath = `${modelDir}/reference_sample.wav`;
    const outputPath = `${modelDir}/embeddings/reference.json`;

    try {
      // Read WAV file as base64, decode to bytes, parse to float32 PCM
      const wavBase64 = await RNFS.readFile(wavPath, 'base64');
      const wavBytes = base64ToUint8Array(wavBase64);
      const parsed = parseWavToFloat32(wavBytes);

      // Mimi encoder expects 24kHz audio — resample if needed
      const TARGET_SR = 24000;
      const audioSamples = resampleAudio(
        parsed.samples,
        parsed.sampleRate,
        TARGET_SR,
      );

      console.log(
        `[PocketModelManager] Reference audio: ${parsed.samples.length} samples @ ${parsed.sampleRate}Hz` +
          (parsed.sampleRate !== TARGET_SR
            ? ` → resampled to ${audioSamples.length} samples @ ${TARGET_SR}Hz`
            : '') +
          ` (${(audioSamples.length / TARGET_SR).toFixed(1)}s)`,
      );

      // Load mimi_encoder
      const session = await InferenceSession.create(encoderPath, {
        executionProviders: ['cpu'],
      });

      // Create input tensor: [batch=1, channels=1, samples]
      const inputTensor = new OnnxTensor('float32', audioSamples, [
        1,
        1,
        audioSamples.length,
      ]);

      // Run encoder
      const results = await session.run({audio: inputTensor});

      // Extract embeddings from first output
      const outputNames = Object.keys(results);
      if (outputNames.length === 0) {
        throw new Error('mimi_encoder produced no outputs');
      }
      const embeddings = results[outputNames[0]!];
      const embeddingData = new Float32Array(embeddings.data);
      const dims = Array.from(embeddings.dims) as number[];

      // Normalize to 3D [1, N, dim] if needed
      while (dims.length > 3) {
        dims.shift();
      }
      if (dims.length < 3) {
        dims.unshift(1);
      }

      console.log(
        `[PocketModelManager] Voice embedding: ${embeddingData.length} values, dims: [${dims}]`,
      );

      // Save as JSON file (VoiceEmbeddingLoader expects {data: [...], dims: [...]})
      const embeddingJson = {
        data: Array.from(embeddingData),
        dims,
      };
      await RNFS.writeFile(outputPath, JSON.stringify(embeddingJson));

      // Release encoder session
      await session.release();

      console.log('[PocketModelManager] Voice embedding saved');
    } catch (error) {
      console.error('[PocketModelManager] Voice encoding failed:', error);
      throw new Error(
        `Voice encoding failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
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
      console.warn(`[PocketModelManager] Failed to cleanup ${dir}:`, error);
    }
  }

  /**
   * Check if model is installed
   */
  async isModelInstalled(): Promise<boolean> {
    return this.installedModel !== null;
  }

  /**
   * Get installed model info
   */
  getInstalledModel(): PocketModelInfo | null {
    return this.installedModel;
  }

  /**
   * Delete the installed model
   */
  async deleteModel(): Promise<void> {
    const modelsDir = this.getModelsDirectory();
    const modelDir = `${modelsDir}/v1`;

    try {
      const exists = await RNFS.exists(modelDir);
      if (exists) {
        await RNFS.unlink(modelDir);
      }
    } catch (error) {
      console.warn('[PocketModelManager] Failed to delete model:', error);
    }

    this.installedModel = null;
  }

  /**
   * Get configuration for the downloaded model
   */
  getDownloadedModelConfig(): PocketConfig {
    const modelsDir = this.getModelsDirectory();
    const modelDir = `${modelsDir}/v1`;

    return {
      textConditionerPath: `file://${modelDir}/text_conditioner.onnx`,
      flowLmMainPath: `file://${modelDir}/flow_lm_main.onnx`,
      flowLmFlowPath: `file://${modelDir}/flow_lm_flow.onnx`,
      mimiDecoderPath: `file://${modelDir}/mimi_decoder.onnx`,
      tokenizerModelPath: `file://${modelDir}/tokenizer.model`,
      voiceEmbeddingsPath: `file://${modelDir}/embeddings/voice-embeddings-manifest.json`,
    };
  }

  /**
   * Check if model files exist on disk
   */
  async checkModelInstallation(): Promise<boolean> {
    const modelsDir = this.getModelsDirectory();
    const modelDir = `${modelsDir}/v1`;

    const requiredFiles = [
      'text_conditioner.onnx',
      'flow_lm_main.onnx',
      'flow_lm_flow.onnx',
      'mimi_decoder.onnx',
      'tokenizer.model',
      'embeddings/voice-embeddings-manifest.json',
      'embeddings/reference.json',
    ];

    try {
      for (const file of requiredFiles) {
        const filePath = `${modelDir}/${file}`;
        const exists = await RNFS.exists(filePath);
        if (!exists) {
          return false;
        }
      }

      // Calculate total size (ONNX models only)
      let totalSize = 0;
      const onnxFiles = requiredFiles.slice(0, 4);
      for (const file of onnxFiles) {
        const filePath = `${modelDir}/${file}`;
        const fileInfo = await RNFS.stat(filePath);
        totalSize += fileInfo.size;
      }

      this.installedModel = {
        version: 'v1',
        size: totalSize,
        isInstalled: true,
        path: modelDir,
        languages: ['en'],
        description: 'CPU-optimized, INT8 quantized',
      };

      return true;
    } catch (error) {
      console.warn('[PocketModelManager] Failed to check installation:', error);
      return false;
    }
  }

  /**
   * Scan for installed model on startup
   */
  async scanInstalledModel(): Promise<void> {
    await this.checkModelInstallation();
  }
}

// Singleton instance
export const pocketModelManager = new PocketModelManager();
