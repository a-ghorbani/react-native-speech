/**
 * Supertonic Inference Pipeline
 *
 * Implements the 4-model ONNX pipeline for Supertonic TTS:
 * 1. Duration Predictor - predicts phoneme durations from text
 * 2. Text Encoder - encodes text into embeddings
 * 3. Vector Estimator - iterative diffusion to generate mel-spectrogram
 * 4. Vocoder - converts mel-spectrogram to audio waveform
 *
 * Based on: https://github.com/mhpdev/supertonic
 */

import {Platform} from 'react-native';
import type {
  SupertonicConfig,
  SupertonicVoiceStyle,
  AudioBuffer,
  ExecutionProvider,
  ExecutionProviderPreset,
  OnnxInferenceSession,
  OnnxInferenceSessionConstructor,
  OnnxTensorConstructor,
} from '../../types';
import {
  createTextMask,
  createLatentMask,
  UnicodeProcessor,
} from './UnicodeProcessor';
import {SUPERTONIC_CONSTANTS} from './constants';

// Lazy import ONNX Runtime - initialized by ensureONNXRuntime()
let InferenceSession: OnnxInferenceSessionConstructor;
let Tensor: OnnxTensorConstructor;
let onnxInitialized = false;

/**
 * Ensure ONNX Runtime is available and initialize module-level variables
 */
function ensureONNXRuntime(): void {
  if (onnxInitialized) {
    return;
  }

  try {
    const onnx = require('onnxruntime-react-native');
    InferenceSession = onnx.InferenceSession;
    Tensor = onnx.Tensor;
    onnxInitialized = true;
  } catch (error) {
    throw new Error(
      'onnxruntime-react-native is required to use the Supertonic engine.\n\n' +
        'Install it with:\n' +
        '  npm install onnxruntime-react-native\n' +
        '  # or\n' +
        '  yarn add onnxruntime-react-native\n\n' +
        'Then rebuild your app:\n' +
        '  iOS: cd ios && pod install && cd ..\n' +
        '  Android: Rebuild the app',
    );
  }
}

/**
 * Resolve execution provider preset to ONNX Runtime format
 */
function resolveExecutionProviders(
  config: ExecutionProviderPreset | ExecutionProvider[] | undefined,
): any[] {
  if (!config) {
    config = 'auto';
  }

  if (typeof config === 'string') {
    const isIOS = Platform.OS === 'ios';

    switch (config) {
      case 'auto':
        if (isIOS) {
          return [
            {
              name: 'coreml',
              useCPUOnly: false,
              useCPUAndGPU: true,
              enableOnSubgraph: true,
            },
            'xnnpack',
            'cpu',
          ];
        } else {
          return ['nnapi', 'xnnpack', 'cpu'];
        }

      case 'cpu':
        return ['cpu'];

      case 'gpu':
        if (isIOS) {
          return [
            {
              name: 'coreml',
              useCPUOnly: false,
              useCPUAndGPU: true,
              enableOnSubgraph: true,
            },
            'cpu',
          ];
        } else {
          return ['nnapi', 'cpu'];
        }

      default:
        return ['cpu'];
    }
  }

  return config;
}

/**
 * Generate random noise for diffusion
 *
 * @param shape - [batch, latentDim, latentLen]
 * @param mask - Optional latent mask [latentLen] to zero out padding regions
 */
function generateNoise(shape: number[], mask?: Float32Array): Float32Array {
  const size = shape.reduce((a, b) => a * b, 1);
  const noise = new Float32Array(size);

  // Box-Muller transform for Gaussian noise
  for (let i = 0; i < size; i += 2) {
    const u1 = Math.random();
    const u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;

    noise[i] = r * Math.cos(theta);
    if (i + 1 < size) {
      noise[i + 1] = r * Math.sin(theta);
    }
  }

  // Apply mask to zero out padding regions (matches official implementation)
  // This is critical for consistent audio output
  if (mask && shape.length === 3) {
    const latentDim = shape[1]!;
    const latentLen = shape[2]!;
    for (let d = 0; d < latentDim; d++) {
      for (let t = 0; t < latentLen; t++) {
        const idx = d * latentLen + t;
        const maskValue = mask[t];
        if (maskValue !== undefined && noise[idx] !== undefined) {
          noise[idx] = noise[idx]! * maskValue;
        }
      }
    }
  }

  return noise;
}

const {
  CHUNK_SIZE,
  EFFECTIVE_LATENT_DIM,
  STYLE_DP_SIZE,
  STYLE_TTL_SIZE,
  SPEED_OFFSET,
} = SUPERTONIC_CONSTANTS;

/**
 * Validate voice style tensor dimensions
 * Throws an error if dimensions don't match expected sizes
 */
function validateVoiceStyle(style: SupertonicVoiceStyle): void {
  if (style.styleDp.length !== STYLE_DP_SIZE) {
    throw new Error(
      `Invalid style_dp size: expected ${STYLE_DP_SIZE}, got ${style.styleDp.length}. ` +
        `Voice style may be corrupted or from an incompatible model version.`,
    );
  }
  if (style.styleTtl.length !== STYLE_TTL_SIZE) {
    throw new Error(
      `Invalid style_ttl size: expected ${STYLE_TTL_SIZE}, got ${style.styleTtl.length}. ` +
        `Voice style may be corrupted or from an incompatible model version.`,
    );
  }
}

export class SupertonicInference {
  private durationPredictorSession: OnnxInferenceSession | null = null;
  private textEncoderSession: OnnxInferenceSession | null = null;
  private vectorEstimatorSession: OnnxInferenceSession | null = null;
  private vocoderSession: OnnxInferenceSession | null = null;

  private sampleRate = 44100; // Supertonic vocoder outputs 44.1kHz audio
  private latentDim = EFFECTIVE_LATENT_DIM; // 144 = 24 * 6
  private isInitialized = false;
  private unicodeProcessor: UnicodeProcessor | null = null;

  /**
   * Set the Unicode processor instance
   */
  setUnicodeProcessor(processor: UnicodeProcessor): void {
    this.unicodeProcessor = processor;
  }

  /**
   * Initialize the inference pipeline by loading all 4 ONNX models
   */
  async initialize(config: SupertonicConfig): Promise<void> {
    ensureONNXRuntime();

    const executionProviders = resolveExecutionProviders(
      config.executionProviders,
    );

    console.log(
      '[SupertonicInference] Loading models with execution providers:',
      JSON.stringify(executionProviders),
    );

    const sessionOptions = {executionProviders};

    try {
      // Load all 4 models in parallel for faster initialization
      const startTime = Date.now();

      const [
        durationSession,
        textEncoderSession,
        vectorSession,
        vocoderSession,
      ] = await Promise.all([
        InferenceSession.create(config.durationPredictorPath, sessionOptions),
        InferenceSession.create(config.textEncoderPath, sessionOptions),
        InferenceSession.create(config.vectorEstimatorPath, sessionOptions),
        InferenceSession.create(config.vocoderPath, sessionOptions),
      ]);

      this.durationPredictorSession = durationSession;
      this.textEncoderSession = textEncoderSession;
      this.vectorEstimatorSession = vectorSession;
      this.vocoderSession = vocoderSession;

      const loadTime = Date.now() - startTime;
      console.log(`[SupertonicInference] All models loaded in ${loadTime}ms`);

      this.isInitialized = true;
    } catch (error) {
      // Try CPU fallback
      console.warn(
        '[SupertonicInference] Failed to load with acceleration, trying CPU fallback:',
        error instanceof Error ? error.message : 'Unknown error',
      );

      const cpuOptions = {executionProviders: ['cpu']};

      try {
        const [
          durationSession,
          textEncoderSession,
          vectorSession,
          vocoderSession,
        ] = await Promise.all([
          InferenceSession.create(config.durationPredictorPath, cpuOptions),
          InferenceSession.create(config.textEncoderPath, cpuOptions),
          InferenceSession.create(config.vectorEstimatorPath, cpuOptions),
          InferenceSession.create(config.vocoderPath, cpuOptions),
        ]);

        this.durationPredictorSession = durationSession;
        this.textEncoderSession = textEncoderSession;
        this.vectorEstimatorSession = vectorSession;
        this.vocoderSession = vocoderSession;

        console.log('[SupertonicInference] Models loaded with CPU fallback');
        this.isInitialized = true;
      } catch (fallbackError) {
        throw new Error(
          `Failed to load Supertonic models: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * Run the full synthesis pipeline
   *
   * Based on official Supertonic implementation:
   * 1. Duration predictor outputs a SCALAR (total audio duration in seconds)
   * 2. Text encoder outputs embeddings at [batch, emb_dim, seq_len]
   * 3. Vector estimator uses cross-attention (no manual embedding expansion)
   * 4. Vocoder converts latent to waveform
   *
   * @param text - Input text to synthesize
   * @param voiceStyle - Voice style embeddings
   * @param inferenceSteps - Number of diffusion steps (default: 5)
   * @param speed - Speech speed multiplier (default: 1.0)
   * @returns AudioBuffer with synthesized audio
   */
  async synthesize(
    text: string,
    voiceStyle: SupertonicVoiceStyle,
    inferenceSteps: number = 5,
    speed: number = 1.0,
  ): Promise<AudioBuffer> {
    if (!this.isInitialized) {
      throw new Error('SupertonicInference not initialized');
    }

    if (!this.unicodeProcessor || !this.unicodeProcessor.isReady()) {
      throw new Error('UnicodeProcessor not initialized');
    }

    // Validate voice style dimensions before synthesis
    validateVoiceStyle(voiceStyle);

    const totalStartTime = Date.now();

    // Step 1: Convert text to Unicode IDs
    const textIds = this.unicodeProcessor.textToUnicodeIds(text);
    const textMask = createTextMask(textIds.length);
    const seqLen = textIds.length;

    console.log(
      `[SupertonicInference] Text: "${text.substring(0, 30)}...", length=${seqLen}`,
    );

    // Step 2: Run duration predictor - returns SCALAR duration in seconds
    const durationStartTime = Date.now();
    const durationSeconds = await this.predictDuration(
      textIds,
      textMask,
      voiceStyle.styleDp,
      speed,
    );
    const durationTime = Date.now() - durationStartTime;

    // Calculate latent length from duration in seconds
    // latent_len = ceil(duration_seconds * sample_rate / chunk_size)
    const wavLength = durationSeconds * this.sampleRate;
    const latentLen = Math.ceil(wavLength / CHUNK_SIZE);

    console.log(
      `[SupertonicInference] Duration prediction: ${durationTime}ms, durationSeconds=${durationSeconds.toFixed(2)}s, latentLen=${latentLen}`,
    );

    // Step 3: Run text encoder - output shape [1, emb_dim, seq_len]
    const encoderStartTime = Date.now();
    const {textEmbedding, embDim} = await this.encodeText(
      textIds,
      textMask,
      voiceStyle.styleTtl,
      seqLen,
    );
    const encoderTime = Date.now() - encoderStartTime;
    console.log(
      `[SupertonicInference] Text encoding: ${encoderTime}ms, embDim=${embDim}`,
    );

    // Step 4: Run vector estimator (diffusion)
    // Note: text_emb is passed directly without expansion - model handles cross-attention
    const diffusionStartTime = Date.now();
    const latent = await this.estimateVector(
      textEmbedding,
      textMask,
      seqLen,
      embDim,
      latentLen,
      voiceStyle.styleTtl,
      inferenceSteps,
    );
    const diffusionTime = Date.now() - diffusionStartTime;
    console.log(
      `[SupertonicInference] Diffusion (${inferenceSteps} steps): ${diffusionTime}ms`,
    );

    // Step 5: Run vocoder
    const vocoderStartTime = Date.now();
    let audioSamples = await this.vocode(latent, latentLen);
    const vocoderTime = Date.now() - vocoderStartTime;
    console.log(`[SupertonicInference] Vocoding: ${vocoderTime}ms`);

    // Trim audio to predicted duration (vocoder may produce slightly more)
    const expectedSamples = Math.ceil(durationSeconds * this.sampleRate);
    if (audioSamples.length > expectedSamples) {
      console.log(
        `[SupertonicInference] Trimming audio from ${audioSamples.length} to ${expectedSamples} samples`,
      );
      audioSamples = audioSamples.slice(0, expectedSamples);
    }

    const totalTime = Date.now() - totalStartTime;
    const audioDuration = audioSamples.length / this.sampleRate;
    const rtf = totalTime / (audioDuration * 1000);

    console.log(
      `[SupertonicInference] Total: ${totalTime}ms, audio=${audioDuration.toFixed(2)}s, RTF=${rtf.toFixed(2)}`,
    );

    return {
      samples: audioSamples,
      sampleRate: this.sampleRate,
      channels: 1,
      duration: audioDuration,
    };
  }

  /**
   * Convert speed to duration factor (matches official implementation)
   * Formula: durationFactor = 1 / (speed + offset)
   *
   * The offset of 0.05 ensures:
   * - Speed 1.0x → factor 0.952 (slightly faster baseline)
   * - Speed 2.0x → factor 0.488 (much faster)
   *
   * @param speed - Speech speed multiplier (1.0 = normal)
   * @param offset - Small offset to prevent division by zero and tune baseline
   */
  private speedToDurationFactor(
    speed: number,
    offset: number = SPEED_OFFSET,
  ): number {
    return 1 / (speed + offset);
  }

  /**
   * Step 1: Predict total audio duration (in seconds)
   *
   * The duration predictor outputs a SCALAR value representing
   * the total audio duration in seconds, NOT per-character durations.
   *
   * Reference shapes from official implementation:
   * - text_ids: [batch_size, seq_len] int64
   * - style_dp: [batch_size, 8, 16] float32 (from voice JSON dims)
   * - text_mask: [batch_size, 1, seq_len] float32 (3D, not 2D!)
   * - output: [batch_size] float32 (scalar duration in seconds)
   */
  private async predictDuration(
    textIds: BigInt64Array,
    textMask: Float32Array,
    styleDp: Float32Array,
    speed: number,
  ): Promise<number> {
    const seqLen = textIds.length;

    console.log(
      `[SupertonicInference] predictDuration: seqLen=${seqLen}, styleDp.length=${styleDp.length}`,
    );

    // Create input tensors with correct shapes per official reference
    // text_ids: [1, seqLen]
    const textIdsTensor = new Tensor('int64', textIds, [1, seqLen]);

    // text_mask: [1, 1, seqLen] - 3D tensor per reference implementation!
    const textMaskTensor = new Tensor('float32', textMask, [1, 1, seqLen]);

    // style_dp: [1, 8, 16] - 128 elements from voice JSON
    const styleDpShape =
      styleDp.length === 128 ? [1, 8, 16] : [1, styleDp.length];
    const styleDpTensor = new Tensor('float32', styleDp, styleDpShape);

    console.log(
      `[SupertonicInference] Tensor shapes: textIds=[1,${seqLen}], textMask=[1,1,${seqLen}], styleDp=${JSON.stringify(styleDpShape)}`,
    );

    const feeds: Record<string, any> = {
      text_ids: textIdsTensor,
      style_dp: styleDpTensor,
      text_mask: textMaskTensor,
    };

    try {
      if (!this.durationPredictorSession) {
        throw new Error('Duration predictor session not initialized');
      }
      const results = await this.durationPredictorSession.run(feeds);

      console.log(
        `[SupertonicInference] Duration output keys: ${Object.keys(results).join(', ')}`,
      );

      // Get duration output - model outputs 'duration' (singular)
      // This is a SCALAR representing total audio duration in seconds
      const durOutput =
        results.duration ||
        results.dur_onnx ||
        results.durations ||
        results.output;
      if (!durOutput) {
        throw new Error(
          `No duration output. Available: ${Object.keys(results).join(', ')}`,
        );
      }

      // Duration is a scalar [batch_size] - get first element
      // Apply duration factor (matches official implementation formula)
      const durationFactor = this.speedToDurationFactor(speed);
      const durationSeconds = (durOutput.data[0] as number) * durationFactor;

      console.log(
        `[SupertonicInference] Raw duration output shape: [${durOutput.dims}], value: ${durOutput.data[0]}, factor: ${durationFactor.toFixed(3)}, adjusted: ${durationSeconds.toFixed(3)}s`,
      );

      return Math.max(0.1, durationSeconds); // Minimum 0.1 seconds
    } catch (error) {
      console.error('[SupertonicInference] predictDuration error:', error);
      throw error;
    }
  }

  /**
   * Step 2: Encode text into embeddings
   *
   * Output shape is [batch, emb_dim, seq_len] - NOT expanded by durations.
   * The vector estimator handles text-to-latent mapping via cross-attention.
   *
   * Reference shapes from official implementation:
   * - text_ids: [batch_size, seq_len] int64
   * - text_mask: [batch_size, 1, seq_len] float32 (3D, not 2D!)
   * - style_ttl: [batch_size, 50, 256] float32 (3D from voice JSON dims)
   * - output text_emb: [batch_size, emb_dim, seq_len] float32
   */
  private async encodeText(
    textIds: BigInt64Array,
    textMask: Float32Array,
    styleTtl: Float32Array,
    seqLen: number,
  ): Promise<{textEmbedding: Float32Array; embDim: number}> {
    // text_ids: [1, seqLen]
    const textIdsTensor = new Tensor('int64', textIds, [1, seqLen]);

    // text_mask: [1, 1, seqLen] - 3D tensor per reference implementation!
    const textMaskTensor = new Tensor('float32', textMask, [1, 1, seqLen]);

    // style_ttl: [1, 50, 256] - 12800 elements from voice JSON
    const styleTtlShape =
      styleTtl.length === 12800 ? [1, 50, 256] : [1, styleTtl.length];
    const styleTtlTensor = new Tensor('float32', styleTtl, styleTtlShape);

    console.log(
      `[SupertonicInference] encodeText: textIds=[1,${seqLen}], textMask=[1,1,${seqLen}], styleTtl=${JSON.stringify(styleTtlShape)}`,
    );

    const feeds = {
      text_ids: textIdsTensor,
      text_mask: textMaskTensor,
      style_ttl: styleTtlTensor,
    };

    try {
      if (!this.textEncoderSession) {
        throw new Error('Text encoder session not initialized');
      }
      const results = await this.textEncoderSession.run(feeds);

      console.log(
        `[SupertonicInference] Text encoder output keys: ${Object.keys(results).join(', ')}`,
      );

      const textEmb =
        results.text_emb_onnx || results.text_emb || results.output;
      if (!textEmb) {
        throw new Error(
          `No text embedding output. Available: ${Object.keys(results).join(', ')}`,
        );
      }

      // Output shape is [1, emb_dim, seq_len]
      const embDim = textEmb.dims[1] as number;
      console.log(
        `[SupertonicInference] Text embedding shape: [${textEmb.dims}], embDim=${embDim}`,
      );

      return {
        textEmbedding: new Float32Array(textEmb.data as Float32Array),
        embDim,
      };
    } catch (error) {
      console.error('[SupertonicInference] encodeText error:', error);
      throw error;
    }
  }

  /**
   * Step 3: Run iterative diffusion to estimate mel-spectrogram latent
   *
   * IMPORTANT: The text embedding is NOT expanded by durations.
   * The model uses cross-attention to map text_emb [1, emb_dim, seq_len]
   * to latent [1, latent_dim, latent_len] internally.
   *
   * Reference shapes from official implementation:
   * - noisy_latent: [batch_size, 144, latent_len] float32
   * - text_emb: [batch_size, emb_dim, seq_len] float32 (NOT expanded!)
   * - style_ttl: [batch_size, 50, 256] float32
   * - text_mask: [batch_size, 1, seq_len] float32 (3D!)
   * - latent_mask: [batch_size, 1, latent_len] float32 (3D!)
   * - current_step: [batch_size] float32
   * - total_step: [batch_size] float32
   */
  private async estimateVector(
    textEmbedding: Float32Array,
    textMask: Float32Array,
    seqLen: number,
    embDim: number,
    latentLen: number,
    styleTtl: Float32Array,
    numSteps: number,
  ): Promise<Float32Array> {
    console.log(
      `[SupertonicInference] estimateVector: seqLen=${seqLen}, embDim=${embDim}, latentLen=${latentLen}, numSteps=${numSteps}`,
    );

    // Create latent mask [latent_len] of 1s
    const latentMask = createLatentMask(latentLen);

    // Initialize with random noise [1, 144, latent_len]
    // Apply mask to zero out padding regions (matches official implementation)
    const latentShape = [1, this.latentDim, latentLen];
    let latent = generateNoise(latentShape, latentMask);

    // style_ttl: [1, 50, 256] - 12800 elements from voice JSON
    const styleTtlShape =
      styleTtl.length === 12800 ? [1, 50, 256] : [1, styleTtl.length];

    // Iterative diffusion
    for (let step = 0; step < numSteps; step++) {
      // current_step and total_step are float32 with shape [batch_size]
      const currentStepData = new Float32Array([step]);
      const totalStepData = new Float32Array([numSteps]);

      const noisyLatentTensor = new Tensor('float32', latent, latentShape);

      // text_emb: [1, emb_dim, seq_len] - NOT expanded, model handles cross-attention
      const textEmbTensor = new Tensor('float32', textEmbedding, [
        1,
        embDim,
        seqLen,
      ]);

      const styleTtlTensor = new Tensor('float32', styleTtl, styleTtlShape);

      // text_mask: [1, 1, seqLen] - 3D tensor
      const textMaskTensor = new Tensor('float32', textMask, [1, 1, seqLen]);

      // latent_mask: [1, 1, latentLen] - 3D tensor
      const latentMaskTensor = new Tensor('float32', latentMask, [
        1,
        1,
        latentLen,
      ]);

      const currentStepTensor = new Tensor('float32', currentStepData, [1]);
      const totalStepTensor = new Tensor('float32', totalStepData, [1]);

      const feeds = {
        noisy_latent: noisyLatentTensor,
        text_emb: textEmbTensor,
        style_ttl: styleTtlTensor,
        text_mask: textMaskTensor,
        latent_mask: latentMaskTensor,
        current_step: currentStepTensor,
        total_step: totalStepTensor,
      };

      if (step === 0) {
        console.log(
          `[SupertonicInference] Diffusion step ${step}: latent=[1,${this.latentDim},${latentLen}], textEmb=[1,${embDim},${seqLen}], textMask=[1,1,${seqLen}], latentMask=[1,1,${latentLen}]`,
        );
      }

      try {
        if (!this.vectorEstimatorSession) {
          throw new Error('Vector estimator session not initialized');
        }
        const results = await this.vectorEstimatorSession.run(feeds);

        const xt =
          results.denoised_latent ||
          results.xt ||
          results.latent ||
          results.output;
        if (!xt) {
          throw new Error(
            `No vector estimator output. Available: ${Object.keys(results).join(', ')}`,
          );
        }

        latent = new Float32Array(xt.data as Float32Array);
      } catch (error) {
        console.error(
          `[SupertonicInference] estimateVector step ${step} error:`,
          error,
        );
        throw error;
      }
    }

    return latent;
  }

  /**
   * Step 4: Convert latent to audio waveform
   *
   * Reference shapes:
   * - latent: [batch_size, 144, latent_len] float32
   * - output wav: [batch_size, wav_len] float32
   */
  private async vocode(
    latent: Float32Array,
    latentLen: number,
  ): Promise<Float32Array> {
    const latentTensor = new Tensor('float32', latent, [
      1,
      this.latentDim,
      latentLen,
    ]);

    console.log(
      `[SupertonicInference] vocode: latent shape=[1,${this.latentDim},${latentLen}]`,
    );

    const feeds = {
      latent: latentTensor,
    };

    try {
      if (!this.vocoderSession) {
        throw new Error('Vocoder session not initialized');
      }
      const results = await this.vocoderSession.run(feeds);

      console.log(
        `[SupertonicInference] Vocoder output keys: ${Object.keys(results).join(', ')}`,
      );

      const wav =
        results.wav_tts ||
        results.wav ||
        results.audio ||
        results.waveform ||
        results.output;
      if (!wav) {
        throw new Error(
          `No vocoder output. Available: ${Object.keys(results).join(', ')}`,
        );
      }

      console.log(`[SupertonicInference] Audio output shape: [${wav.dims}]`);

      return new Float32Array(wav.data as Float32Array);
    } catch (error) {
      console.error('[SupertonicInference] vocode error:', error);
      throw error;
    }
  }

  /**
   * Check if inference pipeline is ready
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Release all model resources
   */
  async destroy(): Promise<void> {
    // ONNX Runtime React Native doesn't have explicit dispose
    this.durationPredictorSession = null;
    this.textEncoderSession = null;
    this.vectorEstimatorSession = null;
    this.vocoderSession = null;
    this.isInitialized = false;
  }

  /**
   * Release all ONNX sessions to free memory.
   * Unlike destroy(), this method calls session.release() if available
   * to properly free native resources.
   *
   * @returns Array of errors that occurred during release (empty if all succeeded)
   */
  async release(): Promise<Error[]> {
    const errors: Error[] = [];
    const sessionNames = [
      'durationPredictor',
      'textEncoder',
      'vectorEstimator',
      'vocoder',
    ];
    const sessions = [
      this.durationPredictorSession,
      this.textEncoderSession,
      this.vectorEstimatorSession,
      this.vocoderSession,
    ];

    // Release all sessions in parallel, collecting errors
    const results = await Promise.all(
      sessions.map(async (session, index) => {
        if (session && typeof (session as any).release === 'function') {
          try {
            await (session as any).release();
            return null;
          } catch (error) {
            const sessionName = sessionNames[index];
            console.warn(
              `[SupertonicInference] ${sessionName} session release failed:`,
              error,
            );
            return new Error(
              `${sessionName}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return null;
      }),
    );

    // Collect non-null errors
    for (const error of results) {
      if (error) {
        errors.push(error);
      }
    }

    this.durationPredictorSession = null;
    this.textEncoderSession = null;
    this.vectorEstimatorSession = null;
    this.vocoderSession = null;
    this.isInitialized = false;

    return errors;
  }
}
