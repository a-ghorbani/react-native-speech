/**
 * Pocket TTS Inference Pipeline
 *
 * Implements the 4-ONNX-session pipeline for Pocket TTS:
 * 1. Text Conditioner: tokens → embeddings [1, seq_len, 1024]
 * 2. Flow LM Main: multi-pass stateful transformer
 *    - Voice conditioning pass: feed voice embedding as text_embeddings
 *    - Text conditioning pass: feed text embeddings
 *    - Autoregressive generation: produce latent frames
 * 3. Flow LM Flow: Euler ODE integration (noise → latent, 32-dim)
 * 4. Mimi Decoder: chunked latent decoding → 24kHz PCM audio
 *
 * KEY DIFFERENCES from SupertonicInference:
 * - Autoregressive: ~100 steps per chunk (not single forward pass)
 * - Multi-pass: voice → text → generate (3 phases per utterance)
 * - Individual state tensors: state_0...state_N (not packed KV cache)
 * - State shapes discovered at runtime from session metadata
 * - Stop via simple boolean flag (not Promise.race)
 *
 * Reference: https://huggingface.co/KevinAHM/pocket-tts-onnx
 */

import {Platform} from 'react-native';
import type {
  PocketConfig,
  PocketVoiceEmbedding,
  AudioBuffer,
  StateTensorMap,
  ExecutionProvider,
  ExecutionProviderPreset,
  OnnxInferenceSession,
  OnnxInferenceSessionConstructor,
  OnnxTensor,
  OnnxTensorConstructor,
} from '../../types';
import {SentencePieceTokenizer} from './SentencePieceTokenizer';
import {POCKET_CONSTANTS} from './constants';
import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('Pocket', 'Inference');

const {
  SAMPLE_RATE,
  LATENT_DIM,
  HIDDEN_DIM,
  DECODER_CHUNK_SIZE,
  FRAMES_AFTER_EOS,
  TENSOR_NAMES,
  STATE_INPUT_PREFIX,
  STATE_OUTPUT_PREFIX,
} = POCKET_CONSTANTS;

// Lazy ONNX Runtime import (same pattern as SupertonicInference)
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
      'onnxruntime-react-native is required to use the Pocket engine.\n\n' +
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
 * Generate Gaussian noise using Box-Muller transform
 */
function generateGaussianNoise(
  size: number,
  temperature: number,
): Float32Array {
  if (temperature <= 0) {
    return new Float32Array(size);
  }

  const noise = new Float32Array(size);
  const std = Math.sqrt(temperature);

  for (let i = 0; i < size; i += 2) {
    const u1 = Math.random();
    const u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1)) * std;
    const theta = 2 * Math.PI * u2;

    noise[i] = r * Math.cos(theta);
    if (i + 1 < size) {
      noise[i + 1] = r * Math.sin(theta);
    }
  }

  return noise;
}

/**
 * Discover state tensor names from an ONNX session's inputNames.
 * Returns sorted list of state_* input names.
 */
function discoverStateNames(session: OnnxInferenceSession): string[] {
  const sessionAny = session as any;
  if (!sessionAny.inputNames) {
    return [];
  }

  const inputNames = sessionAny.inputNames as string[];
  return inputNames
    .filter(name => name.startsWith(STATE_INPUT_PREFIX))
    .sort((a, b) => {
      const numA = parseInt(a.replace(STATE_INPUT_PREFIX, ''), 10);
      const numB = parseInt(b.replace(STATE_INPUT_PREFIX, ''), 10);
      return numA - numB;
    });
}

/**
 * Initialize state tensors from ONNX session metadata.
 * Reads input shapes via session.inputMetadata (public API in onnxruntime-common).
 * Dynamic/symbolic dimensions are replaced with 0 (matching the Python reference).
 */
function initializeStateTensors(
  session: OnnxInferenceSession,
  stateNames: string[],
): StateTensorMap {
  const states: StateTensorMap = {};
  if (stateNames.length === 0) {
    return states;
  }

  const sessionAny = session as any;

  // Access input metadata via the public API (onnxruntime-common)
  // Each item: { name, isTensor, type, shape: Array<number|string> }
  const inputMetadata: any[] | null = Array.isArray(sessionAny.inputMetadata)
    ? sessionAny.inputMetadata
    : null;

  if (!inputMetadata) {
    log.warn(
      'session.inputMetadata not available — state tensors cannot be initialized correctly',
    );
  }

  for (const name of stateNames) {
    let shape: number[] = [0];
    let dtype: 'float32' | 'int64' | 'bool' = 'float32';

    if (inputMetadata) {
      const meta = inputMetadata.find((m: any) => m.name === name);
      if (meta?.shape) {
        // Replace symbolic/string dims with 0 (dynamic dims like "past_sequence_length")
        shape = (meta.shape as unknown[]).map((s: unknown) =>
          typeof s === 'number' && s >= 0 ? s : 0,
        );
      }
      if (meta?.type) {
        const typeStr = String(meta.type);
        if (typeStr.includes('int64')) {
          dtype = 'int64';
        } else if (typeStr.includes('bool')) {
          dtype = 'bool';
        }
      }
    }

    const totalElements = shape.reduce((a, b) => a * b, 1);
    const safeElements = totalElements > 0 ? totalElements : 0;

    if (dtype === 'int64') {
      states[name] = {
        data: new BigInt64Array(safeElements),
        dims: shape,
        dtype,
      };
    } else if (dtype === 'bool') {
      states[name] = {
        data: new Uint8Array(safeElements),
        dims: shape,
        dtype,
      };
    } else {
      states[name] = {
        data: new Float32Array(safeElements),
        dims: shape,
        dtype,
      };
    }
  }

  log.debug(
    `Initialized ${stateNames.length} state tensors, ` +
      `sample: ${stateNames[0]}=[${states[stateNames[0]!]?.dims}]`,
  );

  return states;
}

/**
 * Create ONNX tensor feeds from a StateTensorMap
 */
function stateToFeeds(states: StateTensorMap): Record<string, OnnxTensor> {
  const feeds: Record<string, OnnxTensor> = {};

  for (const [name, state] of Object.entries(states)) {
    feeds[name] = new Tensor(
      state.dtype === 'bool' ? 'bool' : state.dtype,
      state.data,
      state.dims,
    );
  }

  return feeds;
}

/**
 * Update state tensors from ONNX session output.
 * Maps out_state_N → state_N.
 */
function updateStatesFromOutput(
  states: StateTensorMap,
  results: Record<string, OnnxTensor>,
  session: OnnxInferenceSession,
): void {
  const sessionAny = session as any;
  const outputNames: string[] = sessionAny.outputNames || [];

  for (const outName of outputNames) {
    if (!outName.startsWith(STATE_OUTPUT_PREFIX)) {
      continue;
    }

    const idx = outName.replace(STATE_OUTPUT_PREFIX, '');
    const inputName = `${STATE_INPUT_PREFIX}${idx}`;
    const outTensor = results[outName];

    if (outTensor && states[inputName] !== undefined) {
      const dtype = states[inputName]!.dtype;
      let data: Float32Array | BigInt64Array | Uint8Array;
      if (dtype === 'int64') {
        data = new BigInt64Array(outTensor.data as BigInt64Array);
      } else if (dtype === 'bool') {
        data = new Uint8Array(outTensor.data as Uint8Array);
      } else {
        data = new Float32Array(outTensor.data as Float32Array);
      }
      states[inputName] = {
        data,
        dims: [...outTensor.dims],
        dtype,
      };
    }
  }
}

/**
 * Pre-compute s/t time step buffers for flow matching ODE.
 * s = start time, t = end time for each Euler step.
 */
function precomputeFlowBuffers(
  lsdSteps: number,
): Array<{s: Float32Array; t: Float32Array}> {
  const dt = 1.0 / lsdSteps;
  const buffers: Array<{s: Float32Array; t: Float32Array}> = [];

  for (let j = 0; j < lsdSteps; j++) {
    const sVal = j / lsdSteps;
    const tVal = sVal + dt;
    buffers.push({
      s: new Float32Array([sVal]),
      t: new Float32Array([tVal]),
    });
  }

  return buffers;
}

export class PocketInference {
  // ONNX sessions (4 required)
  private textConditionerSession: OnnxInferenceSession | null = null;
  private flowLmMainSession: OnnxInferenceSession | null = null;
  private flowLmFlowSession: OnnxInferenceSession | null = null;
  private mimiDecoderSession: OnnxInferenceSession | null = null;

  // Tokenizer
  private tokenizer: SentencePieceTokenizer;

  // State tensor names (discovered at runtime from session.inputNames)
  private flowLmMainStateNames: string[] = [];
  private mimiDecoderStateNames: string[] = [];

  // Stateful inference state
  private flowLmMainState: StateTensorMap = {};
  private mimiDecoderState: StateTensorMap = {};

  // Configuration
  private initialized = false;

  // Stop flag — checked between autoregressive steps
  private stopRequested = false;

  constructor() {
    this.tokenizer = new SentencePieceTokenizer();
  }

  /**
   * Initialize the inference pipeline.
   * Loads 4 ONNX models in parallel + tokenizer, discovers state tensor names.
   */
  async initialize(config: PocketConfig): Promise<void> {
    ensureONNXRuntime();

    const executionProviders = resolveExecutionProviders(
      config.executionProviders,
    );

    log.info(
      'Loading models with execution providers:',
      JSON.stringify(executionProviders),
    );

    const sessionOptions = {executionProviders};
    // Stateful models (flow_lm_main, mimi_decoder) use zero-element dynamic
    // tensors during conditioning passes. CoreML/NNAPI don't support this,
    // so force CPU for these two models.
    const cpuOnlyOptions = {executionProviders: ['cpu']};

    try {
      const startTime = Date.now();

      // Load tokenizer and 4 models in parallel
      // Stateless models can use accelerated EPs; stateful models need CPU
      const [, textConditioner, flowLmMain, flowLmFlow, mimiDecoder] =
        await Promise.all([
          this.tokenizer.initialize(config.tokenizerModelPath),
          InferenceSession.create(config.textConditionerPath, sessionOptions),
          InferenceSession.create(config.flowLmMainPath, cpuOnlyOptions),
          InferenceSession.create(config.flowLmFlowPath, sessionOptions),
          InferenceSession.create(config.mimiDecoderPath, cpuOnlyOptions),
        ]);

      this.textConditionerSession = textConditioner;
      this.flowLmMainSession = flowLmMain;
      this.flowLmFlowSession = flowLmFlow;
      this.mimiDecoderSession = mimiDecoder;

      // Discover state tensor names from session metadata
      this.flowLmMainStateNames = discoverStateNames(flowLmMain);
      this.mimiDecoderStateNames = discoverStateNames(mimiDecoder);

      log.info(
        `State tensors: flow_lm_main=${this.flowLmMainStateNames.length}, mimi_decoder=${this.mimiDecoderStateNames.length}`,
      );

      const loadTime = Date.now() - startTime;
      log.info(`All models loaded in ${loadTime}ms`);

      this.initialized = true;
    } catch (error) {
      // Try CPU fallback
      log.warn(
        'Failed to load with acceleration, trying CPU fallback:',
        error instanceof Error ? error.message : 'Unknown error',
      );

      const cpuOptions = {executionProviders: ['cpu']};

      try {
        const [, textConditioner, flowLmMain, flowLmFlow, mimiDecoder] =
          await Promise.all([
            this.tokenizer.isReady()
              ? Promise.resolve()
              : this.tokenizer.initialize(config.tokenizerModelPath),
            InferenceSession.create(config.textConditionerPath, cpuOptions),
            InferenceSession.create(config.flowLmMainPath, cpuOptions),
            InferenceSession.create(config.flowLmFlowPath, cpuOptions),
            InferenceSession.create(config.mimiDecoderPath, cpuOptions),
          ]);

        this.textConditionerSession = textConditioner;
        this.flowLmMainSession = flowLmMain;
        this.flowLmFlowSession = flowLmFlow;
        this.mimiDecoderSession = mimiDecoder;

        this.flowLmMainStateNames = discoverStateNames(flowLmMain);
        this.mimiDecoderStateNames = discoverStateNames(mimiDecoder);

        log.info('Models loaded with CPU fallback');
        this.initialized = true;
      } catch (fallbackError) {
        throw new Error(
          `Failed to load Pocket models: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * Request stop of autoregressive generation.
   */
  requestStop(): void {
    this.stopRequested = true;
  }

  /**
   * Full synthesis pipeline for a single text chunk.
   *
   * Multi-pass inference strategy (matching community Python implementation):
   * 1. Preprocess text (capitalize, ensure trailing punctuation)
   * 2. Tokenize text via SentencePiece
   * 3. Text conditioning: tokens → embeddings
   * 4. Initialize flow_lm_main state (zeros)
   * 5. Voice conditioning pass: feed voice embedding as text_embeddings
   * 6. Text conditioning pass: feed text embeddings
   * 7. Autoregressive generation loop:
   *    a. Flow LM Main: current latent → conditioning + EOS logit
   *    b. Flow LM Flow (LSD steps): Euler ODE integration
   *    c. Check EOS, check stop flag
   * 8. Initialize mimi_decoder state (zeros)
   * 9. Mimi Decoder: decode latent chunks → PCM audio
   */
  async synthesize(
    text: string,
    voiceEmbedding: PocketVoiceEmbedding,
    lsdSteps: number,
    temperature: number,
    eosThreshold: number,
    maxTokens: number,
  ): Promise<AudioBuffer> {
    if (!this.initialized) {
      throw new Error('PocketInference not initialized');
    }

    this.stopRequested = false;
    const totalStartTime = Date.now();

    // Step 1: Preprocess text (matching Python reference)
    let processedText = text.trim();
    if (processedText.length > 0) {
      // Capitalize first letter
      if (processedText[0] !== processedText[0]!.toUpperCase()) {
        processedText =
          processedText[0]!.toUpperCase() + processedText.slice(1);
      }
      // Ensure trailing punctuation
      const lastChar = processedText[processedText.length - 1]!;
      if (/[a-zA-Z0-9]/.test(lastChar)) {
        processedText += '.';
      }
    }

    // Step 2: Tokenize
    const tokenIds = this.tokenizer.encode(processedText);
    log.debug(
      `Tokenized "${processedText.substring(0, 30)}..." → ${tokenIds.length} tokens`,
    );

    // Step 3: Text conditioning
    const condStartTime = Date.now();
    const textEmbeddings = await this.runTextConditioner(tokenIds);
    const textEmbDim = textEmbeddings.length / tokenIds.length; // infer embedding dim
    log.debug(
      `Text conditioning: ${Date.now() - condStartTime}ms, dim=${textEmbDim}`,
    );

    // Step 4: Initialize flow_lm_main state
    this.flowLmMainState = initializeStateTensors(
      this.flowLmMainSession!,
      this.flowLmMainStateNames,
    );

    // Step 5: Voice conditioning pass
    const voiceStartTime = Date.now();
    await this.runVoiceConditioningPass(voiceEmbedding);
    log.debug(`Voice conditioning pass: ${Date.now() - voiceStartTime}ms`);

    // Step 6: Text conditioning pass
    const textPassStartTime = Date.now();
    await this.runTextConditioningPass(
      textEmbeddings,
      tokenIds.length,
      textEmbDim,
    );
    log.debug(`Text conditioning pass: ${Date.now() - textPassStartTime}ms`);

    // Step 7: Autoregressive generation
    const latents: Float32Array[] = [];
    let step = 0;
    let eosStep: number | null = null;

    // Pre-compute ODE time step buffers
    const flowBuffers = precomputeFlowBuffers(lsdSteps);
    const dt = 1.0 / lsdSteps;

    const genStartTime = Date.now();

    // Start with NaN-filled latent (signals BOS to the model)
    let currentLatent: Float32Array<ArrayBufferLike> = new Float32Array(
      LATENT_DIM,
    );
    currentLatent.fill(NaN);

    while (step < maxTokens) {
      // Simple boolean check — no Promise.race overhead
      if (this.stopRequested) {
        log.debug(`Stop requested at step ${step}`);
        break;
      }

      // 6a. Flow LM Main: autoregressive step
      const {conditioning, eosLogit} =
        await this.runAutoregressiveStep(currentLatent);

      // 6b. Check EOS (raw logit comparison, not sigmoid)
      if (eosLogit > eosThreshold && eosStep === null) {
        eosStep = step;
        log.debug(`EOS detected at step ${step}, logit=${eosLogit.toFixed(3)}`);
      }

      if (eosStep !== null && step >= eosStep + FRAMES_AFTER_EOS) {
        break;
      }

      // 6c. Flow LM Flow: LSD decode steps (Euler ODE integration)
      let x = generateGaussianNoise(LATENT_DIM, temperature);

      for (let j = 0; j < lsdSteps; j++) {
        const flowDir = await this.runFlowStep(
          conditioning,
          flowBuffers[j]!.s,
          flowBuffers[j]!.t,
          x,
        );

        // Euler step: x = x + flow_dir * dt
        const newX = new Float32Array(LATENT_DIM);
        for (let i = 0; i < LATENT_DIM; i++) {
          newX[i] = (x[i] ?? 0) + (flowDir[i] ?? 0) * dt;
        }
        x = newX;
      }

      latents.push(x);
      currentLatent = x;
      step++;
    }

    const genTime = Date.now() - genStartTime;
    log.debug(
      `Autoregressive generation: ${genTime}ms, ${step} steps, ` +
        `${step * (1 + lsdSteps)} ONNX calls`,
    );

    if (latents.length === 0) {
      log.warn('No latents generated');
      return {
        samples: new Float32Array(0),
        sampleRate: SAMPLE_RATE,
        channels: 1,
        duration: 0,
      };
    }

    // Step 8-9: Decode latents → audio
    const decodeStartTime = Date.now();
    const audioSamples = await this.decodeLatents(latents);
    log.debug(`Mimi decode: ${Date.now() - decodeStartTime}ms`);

    // Clean up per-utterance state
    this.flowLmMainState = {};
    this.mimiDecoderState = {};

    const totalTime = Date.now() - totalStartTime;
    const audioDuration = audioSamples.length / SAMPLE_RATE;
    const rtf = totalTime / (audioDuration * 1000);

    log.info(
      `Total: ${totalTime}ms, audio=${audioDuration.toFixed(2)}s, RTF=${rtf.toFixed(2)}, steps=${step}`,
    );

    return {
      samples: audioSamples,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      duration: audioDuration,
    };
  }

  // --- Private inference methods ---

  /**
   * Run text conditioner: token IDs → embeddings
   */
  private async runTextConditioner(
    tokenIds: BigInt64Array,
  ): Promise<Float32Array> {
    if (!this.textConditionerSession) {
      throw new Error('Text conditioner session not initialized');
    }

    const seqLen = tokenIds.length;
    const inputTensor = new Tensor('int64', tokenIds, [1, seqLen]);

    const feeds: Record<string, OnnxTensor> = {
      [TENSOR_NAMES.TEXT_COND_INPUT]: inputTensor,
    };

    const results = await this.textConditionerSession.run(feeds);

    const output = results[TENSOR_NAMES.TEXT_COND_OUTPUT];
    if (!output) {
      throw new Error(
        `No text conditioner output '${TENSOR_NAMES.TEXT_COND_OUTPUT}'. Available: ${Object.keys(results).join(', ')}`,
      );
    }

    return new Float32Array(output.data as Float32Array);
  }

  /**
   * Voice conditioning pass: feed voice embedding as text_embeddings.
   * Populates transformer state with voice context.
   * Uses empty sequence [1, 0, LATENT_DIM].
   */
  private async runVoiceConditioningPass(
    voiceEmbedding: PocketVoiceEmbedding,
  ): Promise<void> {
    if (!this.flowLmMainSession) {
      throw new Error('Flow LM Main session not initialized');
    }

    const feeds: Record<string, OnnxTensor> = {
      [TENSOR_NAMES.FLOW_MAIN_SEQUENCE]: new Tensor(
        'float32',
        new Float32Array(0),
        [1, 0, LATENT_DIM],
      ),
      [TENSOR_NAMES.FLOW_MAIN_TEXT_EMBEDDINGS]: new Tensor(
        'float32',
        voiceEmbedding.data,
        voiceEmbedding.dims,
      ),
      ...stateToFeeds(this.flowLmMainState),
    };

    const results = await this.flowLmMainSession.run(feeds);
    updateStatesFromOutput(
      this.flowLmMainState,
      results,
      this.flowLmMainSession,
    );
  }

  /**
   * Text conditioning pass: feed text embeddings.
   * Populates transformer state with text context.
   * Uses empty sequence [1, 0, LATENT_DIM].
   */
  private async runTextConditioningPass(
    textEmbeddings: Float32Array,
    seqLen: number,
    embDim: number,
  ): Promise<void> {
    if (!this.flowLmMainSession) {
      throw new Error('Flow LM Main session not initialized');
    }

    const feeds: Record<string, OnnxTensor> = {
      [TENSOR_NAMES.FLOW_MAIN_SEQUENCE]: new Tensor(
        'float32',
        new Float32Array(0),
        [1, 0, LATENT_DIM],
      ),
      [TENSOR_NAMES.FLOW_MAIN_TEXT_EMBEDDINGS]: new Tensor(
        'float32',
        textEmbeddings,
        [1, seqLen, embDim],
      ),
      ...stateToFeeds(this.flowLmMainState),
    };

    const results = await this.flowLmMainSession.run(feeds);
    updateStatesFromOutput(
      this.flowLmMainState,
      results,
      this.flowLmMainSession,
    );
  }

  /**
   * Single autoregressive step of flow_lm_main.
   * Feeds current latent as sequence, empty text_embeddings.
   * Returns conditioning vector and EOS logit.
   */
  private async runAutoregressiveStep(
    currentLatent: Float32Array,
  ): Promise<{conditioning: Float32Array; eosLogit: number}> {
    if (!this.flowLmMainSession) {
      throw new Error('Flow LM Main session not initialized');
    }

    const feeds: Record<string, OnnxTensor> = {
      [TENSOR_NAMES.FLOW_MAIN_SEQUENCE]: new Tensor('float32', currentLatent, [
        1,
        1,
        LATENT_DIM,
      ]),
      [TENSOR_NAMES.FLOW_MAIN_TEXT_EMBEDDINGS]: new Tensor(
        'float32',
        new Float32Array(0),
        [1, 0, HIDDEN_DIM],
      ),
      ...stateToFeeds(this.flowLmMainState),
    };

    const results = await this.flowLmMainSession.run(feeds);

    // Update states
    updateStatesFromOutput(
      this.flowLmMainState,
      results,
      this.flowLmMainSession,
    );

    // Extract conditioning
    const condOutput = results[TENSOR_NAMES.FLOW_MAIN_CONDITIONING];
    if (!condOutput) {
      throw new Error(
        `No conditioning output. Available: ${Object.keys(results).join(', ')}`,
      );
    }
    const conditioning = new Float32Array(condOutput.data as Float32Array);

    // Extract EOS logit
    let eosLogit = -Infinity;
    const eosOutput = results[TENSOR_NAMES.FLOW_MAIN_EOS_LOGIT];
    if (eosOutput) {
      const eosData = eosOutput.data as Float32Array;
      eosLogit = eosData[0] ?? -Infinity;
    }

    return {conditioning, eosLogit};
  }

  /**
   * Single flow matching ODE step.
   * c = conditioning, s = start time, t = end time, x = current latent.
   * Returns flow direction vector.
   */
  private async runFlowStep(
    conditioning: Float32Array,
    s: Float32Array,
    t: Float32Array,
    x: Float32Array,
  ): Promise<Float32Array> {
    if (!this.flowLmFlowSession) {
      throw new Error('Flow LM Flow session not initialized');
    }

    const feeds: Record<string, OnnxTensor> = {
      [TENSOR_NAMES.FLOW_C]: new Tensor('float32', conditioning, [
        1,
        conditioning.length,
      ]),
      [TENSOR_NAMES.FLOW_S]: new Tensor('float32', s, [1, 1]),
      [TENSOR_NAMES.FLOW_T]: new Tensor('float32', t, [1, 1]),
      [TENSOR_NAMES.FLOW_X]: new Tensor('float32', x, [1, LATENT_DIM]),
    };

    const results = await this.flowLmFlowSession.run(feeds);

    const flowDir = results[TENSOR_NAMES.FLOW_DIR];
    if (!flowDir) {
      throw new Error(
        `No flow_dir output '${TENSOR_NAMES.FLOW_DIR}'. Available: ${Object.keys(results).join(', ')}`,
      );
    }

    return new Float32Array(flowDir.data as Float32Array);
  }

  /**
   * Decode accumulated latents into audio via Mimi decoder.
   * Processes latents in chunks (default 15 frames per chunk).
   * Stateful: maintains decoder streaming state across chunks.
   */
  private async decodeLatents(latents: Float32Array[]): Promise<Float32Array> {
    if (!this.mimiDecoderSession) {
      throw new Error('Mimi decoder session not initialized');
    }

    // Initialize decoder state
    this.mimiDecoderState = initializeStateTensors(
      this.mimiDecoderSession,
      this.mimiDecoderStateNames,
    );

    const audioChunks: Float32Array[] = [];
    const numFrames = latents.length;

    for (let i = 0; i < numFrames; i += DECODER_CHUNK_SIZE) {
      const chunkEnd = Math.min(i + DECODER_CHUNK_SIZE, numFrames);
      const chunkSize = chunkEnd - i;

      // Build latent chunk tensor [1, chunkSize, LATENT_DIM]
      const chunkData = new Float32Array(chunkSize * LATENT_DIM);
      for (let j = 0; j < chunkSize; j++) {
        chunkData.set(latents[i + j]!, j * LATENT_DIM);
      }

      const feeds: Record<string, OnnxTensor> = {
        [TENSOR_NAMES.DECODER_LATENT]: new Tensor('float32', chunkData, [
          1,
          chunkSize,
          LATENT_DIM,
        ]),
        ...stateToFeeds(this.mimiDecoderState),
      };

      const results = await this.mimiDecoderSession.run(feeds);

      const audioOutput = results[TENSOR_NAMES.DECODER_AUDIO];
      if (!audioOutput) {
        throw new Error(
          `No decoder audio output '${TENSOR_NAMES.DECODER_AUDIO}'. Available: ${Object.keys(results).join(', ')}`,
        );
      }

      audioChunks.push(new Float32Array(audioOutput.data as Float32Array));

      // Update decoder state
      updateStatesFromOutput(
        this.mimiDecoderState,
        results,
        this.mimiDecoderSession,
      );
    }

    // Concatenate audio chunks
    const totalSamples = audioChunks.reduce((sum, c) => sum + c.length, 0);
    const audioSamples = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of audioChunks) {
      audioSamples.set(chunk, offset);
      offset += chunk.length;
    }

    return audioSamples;
  }

  // --- Lifecycle ---

  isReady(): boolean {
    return this.initialized;
  }

  async destroy(): Promise<void> {
    this.textConditionerSession = null;
    this.flowLmMainSession = null;
    this.flowLmFlowSession = null;
    this.mimiDecoderSession = null;
    this.tokenizer.clear();
    this.flowLmMainState = {};
    this.mimiDecoderState = {};
    this.initialized = false;
  }

  /**
   * Release all ONNX sessions to free memory.
   */
  async release(): Promise<Error[]> {
    const errors: Error[] = [];
    const sessionNames = [
      'textConditioner',
      'flowLmMain',
      'flowLmFlow',
      'mimiDecoder',
    ];
    const sessions = [
      this.textConditionerSession,
      this.flowLmMainSession,
      this.flowLmFlowSession,
      this.mimiDecoderSession,
    ];

    const results = await Promise.all(
      sessions.map(async (session, index) => {
        if (session && typeof (session as any).release === 'function') {
          try {
            await (session as any).release();
            return null;
          } catch (error) {
            const sessionName = sessionNames[index];
            log.warn(`${sessionName} session release failed:`, error);
            return new Error(
              `${sessionName}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return null;
      }),
    );

    for (const error of results) {
      if (error) {
        errors.push(error);
      }
    }

    this.textConditionerSession = null;
    this.flowLmMainSession = null;
    this.flowLmFlowSession = null;
    this.mimiDecoderSession = null;
    this.tokenizer.clear();
    this.flowLmMainState = {};
    this.mimiDecoderState = {};
    this.initialized = false;

    return errors;
  }
}
