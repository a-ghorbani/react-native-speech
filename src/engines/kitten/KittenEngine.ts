/**
 * Kitten TTS Engine
 *
 * Neural TTS engine using a single ONNX model (StyleTTS 2 distilled).
 * Pipeline: Text → Phonemizer (JS or native) → IPA Tokenizer → ONNX → Audio (24kHz)
 *
 * Features:
 * - Single ONNX model (simpler than multi-model engines)
 * - Hardware acceleration (CoreML on iOS, NNAPI on Android)
 * - Pipelined synthesis for seamless playback
 * - Length-dependent voice style embeddings
 * - 8 built-in voices, English only
 */

import {Platform} from 'react-native';
import type {
  TTSEngine,
  TTSEngineInterface,
  AudioBuffer,
  EngineStreamHandle,
  ChunkProgressEvent,
  ChunkProgressCallback,
  ReleaseResult,
  ReleaseError,
  ExecutionProvider,
  ExecutionProviderPreset,
  OnnxInferenceSession,
  OnnxInferenceSessionConstructor,
  OnnxTensor,
  OnnxTensorConstructor,
} from '../../types';
import type {KittenConfig, KittenSynthesisOptions} from '../../types/Kitten';
import {IPATokenizer} from './IPATokenizer';
import {VoiceLoader} from './VoiceLoader';
import {
  KITTEN_CONSTANTS,
  KITTEN_VOICE_ALIASES,
  KITTEN_SPEED_PRIORS,
} from './constants';
import {neuralAudioPlayer} from '../NeuralAudioPlayer';
import {
  createPhonemizer,
  NoOpPhonemizer,
  type IPhonemizer,
} from '../kokoro/Phonemizer';
import {TextPreprocessor, loadNativeDict} from '../../phonemization';
import {chunkTextWithPositions} from './chunkTextWithPositions';
import {splitOversizedSource, concatAudioBuffers} from './splitOversized';
import {DEFAULT_COREML_FLAGS} from '../../types/Kokoro';
import {EngineStreamSession} from '../EngineStreamSession';
import {createComponentLogger} from '../../utils/logger';
import {
  stripMarkdown,
  createMarkdownStreamBuffer,
} from '../../utils/stripMarkdown';

const log = createComponentLogger('Kitten', 'Engine');

const {
  SAMPLE_RATE,
  DEFAULT_MAX_CHUNK_SIZE,
  TRIM_SAMPLES,
  PHONEMIZER_LANGUAGE,
  MAX_PHONEME_TOKENS,
} = KITTEN_CONSTANTS;

// Lazy-loaded ONNX Runtime
interface OnnxRuntimeBindings {
  InferenceSession: OnnxInferenceSessionConstructor;
  Tensor: OnnxTensorConstructor;
}
let OnnxRuntime: OnnxRuntimeBindings | null = null;

function getOnnxRuntime(): OnnxRuntimeBindings {
  if (!OnnxRuntime) {
    try {
      const onnx = require('onnxruntime-react-native');
      OnnxRuntime = {
        InferenceSession: onnx.InferenceSession,
        Tensor: onnx.Tensor,
      };
    } catch {
      throw new Error(
        'onnxruntime-react-native is required to use the Kitten engine.\n\n' +
          'Install it with:\n' +
          '  npm install onnxruntime-react-native\n' +
          '  # or\n' +
          '  yarn add onnxruntime-react-native\n\n' +
          'Then rebuild your app.',
      );
    }
  }
  return OnnxRuntime;
}

/**
 * Resolve execution provider preset to ONNX Runtime format
 */
function resolveExecutionProviders(
  config: ExecutionProviderPreset | ExecutionProvider[] | undefined,
): ExecutionProvider[] {
  if (!config) {
    config = 'auto';
  }

  if (typeof config === 'string') {
    const isIOS = Platform.OS === 'ios';

    // See KokoroEngine.resolveExecutionProviders for the full rationale.
    // Same approach: NNAPI dropped on Android (deprecated in Android 15);
    // CoreML uses numeric `coreMlFlags` since the high-level option fields
    // aren't honored by the React Native bridge; bare CPU on Android is
    // shadowed by xnnpack to dodge the silent-audio bug.
    switch (config) {
      case 'auto':
        if (isIOS) {
          return [
            {name: 'coreml', coreMlFlags: DEFAULT_COREML_FLAGS},
            'xnnpack',
            'cpu',
          ];
        }
        return ['xnnpack', 'cpu'];
      case 'cpu':
        return Platform.OS === 'android' ? ['xnnpack', 'cpu'] : ['cpu'];
      case 'gpu':
        if (isIOS) {
          return [{name: 'coreml', coreMlFlags: DEFAULT_COREML_FLAGS}, 'cpu'];
        }
        return ['xnnpack', 'cpu'];
      default:
        return ['cpu'];
    }
  }

  return config;
}

export class KittenEngine implements TTSEngineInterface<KittenConfig> {
  readonly name: TTSEngine = 'kitten' as TTSEngine;

  private session: OnnxInferenceSession | null = null;
  private tokenizer: IPATokenizer;
  private voiceLoader: VoiceLoader;
  private phonemizer: IPhonemizer;
  private preprocessor: TextPreprocessor;

  private config: KittenConfig | null = null;
  private isInitialized = false;
  private isLoading = false;
  private initError: string | null = null;

  private defaultVoiceId = 'expr-voice-2-f';

  // Chunking and progress tracking
  private stopRequested = false;
  private stopSignalResolver: (() => void) | null = null;
  private currentUtteranceId = 0;
  private chunkProgressCallback: ChunkProgressCallback | null = null;

  // Synthesis state tracking for safe resource release
  private isSynthesizing = false;
  private synthesisCompleteResolver: (() => void) | null = null;

  private activeStreamSession: EngineStreamSession | null = null;

  constructor() {
    this.tokenizer = new IPATokenizer();
    this.voiceLoader = new VoiceLoader();
    // Real phonemizer is created in initialize() once the dict is loaded.
    this.phonemizer = new NoOpPhonemizer();
    this.preprocessor = new TextPreprocessor({removePunctuation: false});
  }

  /**
   * Set callback for chunk progress events
   */
  setChunkProgressCallback(callback: ChunkProgressCallback | null): void {
    this.chunkProgressCallback = callback;
  }

  private emitChunkProgress(event: ChunkProgressEvent): void {
    if (this.chunkProgressCallback) {
      this.chunkProgressCallback(event);
    }
  }

  /**
   * Initialize the Kitten engine with model files
   */
  async initialize(config?: KittenConfig): Promise<void> {
    getOnnxRuntime();

    if (this.isInitialized) {
      return;
    }

    if (this.isLoading) {
      throw new Error('Engine is already loading');
    }

    this.isLoading = true;
    this.initError = null;
    const initStart = Date.now();

    try {
      if (!config) {
        throw new Error('Kitten config required for initialization');
      }
      this.config = config;

      log.debug('Initializing Kitten TTS engine');

      // Load IPA dictionary and build JS phonemizer (raw IPA mode).
      if (!config.dictPath) {
        throw new Error(
          'Kitten requires `dictPath` in config ' +
            '(path to the IPA dictionary .bin file, EPD1 format).',
        );
      }
      const dict = await loadNativeDict(config.dictPath);
      this.phonemizer = createPhonemizer('js-ipa', {dict});

      // Load tokenizer (external vocab or built-in symbols)
      if (config.tokenizerPath) {
        await this.loadTokenizer(config.tokenizerPath);
      } else {
        this.tokenizer.loadBuiltinVocab();
        // Verify key mappings match the reference TextCleaner
        const testVocab = require('./constants').buildDefaultVocab();
        log.debug(
          `Built-in vocab: size=${Object.keys(testVocab).length}, ` +
            // eslint-disable-next-line dot-notation
            `space=${testVocab[' ']}, A=${testVocab['A']}, a=${testVocab['a']}, ` +
            `ɪ=${testVocab['ɪ']}, ð=${testVocab['ð']}`,
        );
      }

      // Load voice embeddings
      await this.loadVoices(config.voicesPath);

      // Load ONNX model
      await this.loadModel(config.modelPath);

      this.isInitialized = true;
      this.isLoading = false;
      log.info(`engine_init_ms=${Date.now() - initStart}`);
      log.info(
        'Kitten uses KittenML kitten-tts (Apache-2.0, commercial use allowed).',
      );
    } catch (error) {
      this.isLoading = false;
      this.initError = error instanceof Error ? error.message : 'Unknown error';
      throw error;
    }
  }

  async isReady(): Promise<boolean> {
    return (
      this.isInitialized &&
      this.session !== null &&
      this.tokenizer.isReady() &&
      this.voiceLoader.isReady()
    );
  }

  /**
   * Synthesize text to audio and play it.
   * Automatically chunks long text by sentences.
   */
  async synthesize(
    text: string,
    options?: KittenSynthesisOptions,
  ): Promise<AudioBuffer | void> {
    if (!this.isInitialized || !this.session) {
      throw new Error('Kitten engine not initialized');
    }

    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    this.isSynthesizing = true;
    try {
      return await this.doSynthesize(text, options);
    } finally {
      this.isSynthesizing = false;
      if (this.synthesisCompleteResolver) {
        this.synthesisCompleteResolver();
        this.synthesisCompleteResolver = null;
      }
    }
  }

  synthesizeStream(options?: KittenSynthesisOptions): EngineStreamHandle {
    if (!this.isInitialized || !this.session) {
      throw new Error('Kitten engine not initialized');
    }

    if (this.activeStreamSession) {
      this.activeStreamSession.cancel().catch(() => {});
      this.activeStreamSession = null;
    }

    this.stopRequested = false;
    this.isSynthesizing = true;
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;

    const volumeAdjust =
      options?.volume !== undefined && options.volume !== 1.0
        ? (buf: AudioBuffer) => {
            const v = Math.max(0, Math.min(1, options.volume!));
            for (let i = 0; i < buf.samples.length; i++) {
              const s = buf.samples[i];
              if (s !== undefined) {
                buf.samples[i] = Math.max(-1, Math.min(1, s * v));
              }
            }
          }
        : undefined;

    const stripMd = options?.stripMarkdown !== false;
    // See KokoroEngine.synthesizeStream for the rationale: strip markdown
    // BEFORE StreamingChunker (via the line-buffered md stream buffer) so
    // structural markers become chunk boundaries.
    const mdBuffer = stripMd ? createMarkdownStreamBuffer() : null;
    const session = new EngineStreamSession({
      synthesizeChunk: (text: string) => {
        const processed = this.preprocessor.process(text);
        return this.synthesizeTextChunk(processed, voiceId, options);
      },
      playAudio: (buffer, playOpts) => neuralAudioPlayer.play(buffer, playOpts),
      stopPlayback: () => neuralAudioPlayer.stop(),
      maxChunkSize,
      playbackOptions: {
        ducking: options?.ducking,
        silentMode: options?.silentMode,
      },
      postProcess: volumeAdjust,
      onChunkProgress: this.chunkProgressCallback
        ? event => this.emitChunkProgress(event)
        : undefined,
    });

    this.activeStreamSession = session;

    const wrapFinalize = async () => {
      try {
        await session.finalize();
      } finally {
        this.activeStreamSession = null;
        this.isSynthesizing = false;
        if (this.synthesisCompleteResolver) {
          this.synthesisCompleteResolver();
          this.synthesisCompleteResolver = null;
        }
      }
    };

    const wrapCancel = async () => {
      try {
        await session.cancel();
      } finally {
        this.activeStreamSession = null;
        this.isSynthesizing = false;
        if (this.synthesisCompleteResolver) {
          this.synthesisCompleteResolver();
          this.synthesisCompleteResolver = null;
        }
      }
    };

    return {
      append: (text: string) => {
        if (mdBuffer) {
          const emit = mdBuffer.push(text);
          if (emit) session.append(emit);
        } else {
          session.append(text);
        }
      },
      finalize: async () => {
        if (mdBuffer) {
          const tail = mdBuffer.flush();
          if (tail) session.append(tail);
        }
        return wrapFinalize();
      },
      cancel: wrapCancel,
    };
  }

  private createStopSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      this.stopSignalResolver = () => resolve(null);
    });
  }

  private raceWithStop<T>(
    promise: Promise<T>,
    stopSignal: Promise<null>,
  ): Promise<T | null> {
    return Promise.race([promise, stopSignal]);
  }

  /**
   * Internal synthesis implementation with pipelined chunking
   */
  private async doSynthesize(
    text: string,
    options?: KittenSynthesisOptions,
  ): Promise<AudioBuffer | void> {
    this.stopRequested = false;
    this.stopSignalResolver = null;
    this.currentUtteranceId = Date.now();
    const utteranceId = this.currentUtteranceId;

    const stopSignal = this.createStopSignal();

    const voiceId = options?.voiceId || this.defaultVoiceId;

    log.debug(
      `Synthesis start: voice=${voiceId}, text="${text.substring(0, 50)}..."`,
    );

    // Strip markdown first (default on) so structural markers become
    // sentence breaks the chunker can split on. Consumers who wire
    // HighlightedText to original-input offsets can opt out via
    // `stripMarkdown: false` — note that textRange indices then track the
    // original string, which is not the case when stripping is active.
    const sourceText =
      options?.stripMarkdown === false ? text : stripMarkdown(text);

    // Chunk the ORIGINAL text first (so textRange indices match what the
    // consumer passed to speak and stay aligned with HighlightedText), then
    // preprocess each chunk before phonemization. Preprocessor operations
    // (contraction expansion, number/unit expansion, etc.) are per-token and
    // sentence-independent, so per-chunk preprocessing is equivalent to
    // preprocessing the whole string — without the position drift that
    // whole-text normalization introduces.
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    const sentenceChunks = chunkTextWithPositions(sourceText, maxChunkSize);
    const chunks = sentenceChunks.map(c => ({
      text: this.preprocessor.process(c.text),
      startIndex: c.startIndex,
      endIndex: c.endIndex,
    }));

    log.debug(`Text chunked into ${chunks.length} chunks`);

    // Pipelined synthesis
    let nextAudioPromise: Promise<AudioBuffer> | null = null;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (this.stopRequested) {
        log.debug('Stop requested, aborting synthesis');
        return undefined;
      }

      const chunk = chunks[chunkIndex]!;
      const progress = Math.round((chunkIndex / chunks.length) * 100);

      log.debug(`Processing chunk ${chunkIndex + 1}/${chunks.length}`);

      this.emitChunkProgress({
        id: utteranceId,
        chunkIndex,
        totalChunks: chunks.length,
        chunkText: chunk.text,
        textRange: {start: chunk.startIndex, end: chunk.endIndex},
        progress,
      });

      // Get current chunk audio (from pipeline or synthesize now)
      let audioBuffer: AudioBuffer | null;

      try {
        if (nextAudioPromise) {
          audioBuffer = await this.raceWithStop(nextAudioPromise, stopSignal);
          nextAudioPromise = null;
        } else {
          audioBuffer = await this.raceWithStop(
            this.synthesizeTextChunk(chunk.text, voiceId, options),
            stopSignal,
          );
        }
      } catch (synthError) {
        log.error(
          `Chunk synthesis error: ${synthError instanceof Error ? synthError.message : String(synthError)}`,
        );
        throw synthError;
      }

      if (
        audioBuffer === null ||
        this.stopRequested ||
        audioBuffer.samples.length === 0
      ) {
        log.debug('Stop requested, aborting before playback');
        return undefined;
      }

      // Start synthesizing next chunk in parallel
      const nextChunkIndex = chunkIndex + 1;
      if (!this.stopRequested && nextChunkIndex < chunks.length) {
        const nextChunk = chunks[nextChunkIndex]!;
        nextAudioPromise = this.synthesizeTextChunk(
          nextChunk.text,
          voiceId,
          options,
        );
      }

      // Play current chunk
      await this.raceWithStop(
        neuralAudioPlayer.play(audioBuffer, {
          ducking: options?.ducking,
          silentMode: options?.silentMode,
        }),
        stopSignal,
      );
    }

    log.debug('Synthesis complete');
    return undefined;
  }

  /**
   * Synthesize a text chunk: normalize → phonemize → tokenize → infer → trim
   */
  private async synthesizeTextChunk(
    chunkStr: string,
    voiceId: string,
    options?: KittenSynthesisOptions,
  ): Promise<AudioBuffer> {
    const emptyBuffer = (): AudioBuffer => ({
      samples: new Float32Array(0),
      sampleRate: SAMPLE_RATE,
      channels: 1,
      duration: 0,
    });

    try {
      // Text is already preprocessed by doSynthesize; go straight to phonemize.
      if (this.stopRequested) {
        return emptyBuffer();
      }

      // Guard against near-empty chunks. Streaming with markdown stripping
      // can hand us a chunk that's just `.` (e.g. an isolated horizontal
      // rule converted to a sentence break, then emitted alone by
      // StreamingChunker). Tokenizing produces only [pad, eos, pad] which
      // crashes Kitten's BERT expand op ("invalid expand shape"). Treat as
      // a no-op — the period has already done its job as a chunk boundary
      // upstream.
      if (!/[\p{L}\p{N}]/u.test(chunkStr)) {
        log.debug(
          `Skipping no-content chunk: ${JSON.stringify(chunkStr.slice(0, 40))}`,
        );
        return emptyBuffer();
      }

      // 1. Phonemize (GPL-free JS phonemizer, IPA mode)
      const phonemes = await this.phonemizeText(chunkStr);
      log.debug(
        `Phonemized: "${phonemes.substring(0, 80)}..." (${phonemes.length} chars)`,
      );
      if (this.stopRequested) {
        return emptyBuffer();
      }

      // 2. Tokenize IPA phonemes
      const tokens = this.tokenizer.encode(phonemes);
      log.debug(
        `Tokenized: ${tokens.length} tokens, first 10: [${tokens.slice(0, 10).join(',')}]`,
      );

      // BERT's expand op needs more than just the framing tokens — encode()
      // always emits [pad, ...content, eos, pad], so length 3 means zero
      // content survived phonemization (e.g. punctuation that mapped to no
      // vocab entries). Skip rather than feed garbage through ONNX.
      if (tokens.length <= 3) {
        log.debug(
          `Skipping chunk with no phoneme tokens (got ${tokens.length})`,
        );
        return emptyBuffer();
      }

      // Upper bound: BERT's positional embeddings cap at MAX_PHONEME_TOKENS.
      // English IPA expands at ~2-3.5x source-char count, so a 167-char
      // source chunk can produce ~570 tokens — past the model limit. When
      // we exceed the cap, split the source text into smaller pieces and
      // synthesize each separately, then concatenate the audio. User
      // hears the full content with a tiny prosody seam at the split,
      // instead of silence. See splitOversized.ts for the split
      // strategy.
      if (tokens.length > MAX_PHONEME_TOKENS) {
        log.warn(
          `Oversized chunk (${tokens.length} > ${MAX_PHONEME_TOKENS}, ` +
            `source chars=${chunkStr.length}); splitting and recursing.`,
        );
        const pieces = splitOversizedSource(chunkStr);
        if (pieces.length <= 1) {
          // Couldn't split (single huge token / no whitespace). Drop
          // rather than recurse infinitely. Rare in real text.
          log.warn(
            `Unsplittable oversized chunk; dropping ${chunkStr.length} chars.`,
          );
          return emptyBuffer();
        }
        const subBuffers: AudioBuffer[] = [];
        for (const piece of pieces) {
          if (this.stopRequested) return emptyBuffer();
          const subAudio = await this.synthesizeTextChunk(
            piece,
            voiceId,
            options,
          );
          if (subAudio.samples.length > 0) subBuffers.push(subAudio);
        }
        if (subBuffers.length === 0) return emptyBuffer();
        return concatAudioBuffers(subBuffers);
      }

      // 3. Run ONNX inference with length-dependent voice style.
      return await this.synthesizeChunk(
        tokens,
        voiceId,
        chunkStr.length,
        options,
      );
    } catch (error) {
      log.error(
        `synthesizeTextChunk failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Phonemize text using the configured phonemizer (defaults to GPL-free JS).
   */
  private async phonemizeText(text: string): Promise<string> {
    return this.phonemizer.phonemize(text, PHONEMIZER_LANGUAGE);
  }

  /**
   * Resolve voice alias (e.g., 'Bella' → 'expr-voice-2-f')
   * and return the internal voice ID used by the model.
   */
  private resolveVoiceId(voiceId: string): string {
    return KITTEN_VOICE_ALIASES[voiceId] || voiceId;
  }

  /**
   * Core ONNX inference for a single tokenized chunk
   */
  private async synthesizeChunk(
    tokens: number[],
    voiceId: string,
    rawTextLength: number,
    options?: KittenSynthesisOptions,
  ): Promise<AudioBuffer> {
    const chunkStartTime = Date.now();

    // Resolve voice alias to internal name
    const internalVoiceId = this.resolveVoiceId(voiceId);

    // Get length-dependent voice style embedding
    const voiceStartTime = Date.now();
    const styleEmbedding = await this.voiceLoader.getStyleEmbedding(
      internalVoiceId,
      rawTextLength,
    );
    const voiceTime = Date.now() - voiceStartTime;

    // Create ONNX input tensors
    const {Tensor} = getOnnxRuntime();

    const tokensBigInt = new BigInt64Array(tokens.map(t => BigInt(t)));

    // Apply per-voice speed prior (from config.json) multiplied by user speed
    const userSpeed = options?.speed ?? 1.0;
    const speedPrior = KITTEN_SPEED_PRIORS[internalVoiceId] ?? 1.0;
    const speed = userSpeed * speedPrior;

    const feeds = {
      input_ids: new Tensor('int64', tokensBigInt, [1, tokens.length]),
      style: new Tensor('float32', styleEmbedding, [1, styleEmbedding.length]),
      speed: new Tensor('float32', new Float32Array([speed]), [1]),
    };

    log.debug(
      `ONNX feeds: input_ids=[1,${tokens.length}], style=[1,${styleEmbedding.length}], speed=${speed.toFixed(2)}`,
    );

    // Run inference
    const inferenceStartTime = Date.now();
    log.debug('Starting ONNX inference...');
    if (!this.session) {
      throw new Error('Kitten session not initialized');
    }
    let results: Record<string, OnnxTensor>;
    try {
      results = await this.session.run(feeds);
    } catch (inferError) {
      log.error(
        `ONNX inference failed: ${inferError instanceof Error ? inferError.message : String(inferError)}`,
      );
      throw inferError;
    }
    const inferenceTime = Date.now() - inferenceStartTime;
    log.debug(
      `ONNX inference done in ${inferenceTime}ms, output keys: ${Object.keys(results).join(', ')}`,
    );

    // Extract audio output — try known names, then fall back to first output
    const outputKeys = Object.keys(results);
    let audioTensor = results.waveform || results.audio;
    if (!audioTensor && outputKeys.length > 0) {
      log.debug(
        `No 'waveform'/'audio' key found, using first output: '${outputKeys[0]}'`,
      );
      audioTensor = results[outputKeys[0]!];
    }
    if (!audioTensor) {
      throw new Error(
        `No audio output from model. Available outputs: ${outputKeys.join(', ')}`,
      );
    }

    const rawAudio = audioTensor.data as Float32Array;
    log.debug(`Raw audio: ${rawAudio.length} samples`);

    // Trim trailing samples to remove artifacts
    const trimmedLength = Math.max(0, rawAudio.length - TRIM_SAMPLES);
    const audioData =
      trimmedLength < rawAudio.length
        ? rawAudio.slice(0, trimmedLength)
        : rawAudio;

    // Apply volume if specified
    if (options?.volume !== undefined && options.volume !== 1.0) {
      const clampedVolume = Math.max(0, Math.min(1, options.volume));
      for (let i = 0; i < audioData.length; i++) {
        const sample = audioData[i];
        if (sample !== undefined) {
          audioData[i] = Math.max(-1, Math.min(1, sample * clampedVolume));
        }
      }
    }

    const totalChunkTime = Date.now() - chunkStartTime;
    const duration = audioData.length / SAMPLE_RATE;

    log.debug(
      `Chunk done: inference=${inferenceTime}ms, voice=${voiceTime}ms, total=${totalChunkTime}ms, audio=${duration.toFixed(2)}s`,
    );

    return {
      samples: audioData,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      duration,
    };
  }

  async getAvailableVoices(_language?: string): Promise<string[]> {
    return this.voiceLoader.getAvailableVoices().map(v => v.id);
  }

  getVoicesWithMetadata() {
    return this.voiceLoader.getAvailableVoices();
  }

  /**
   * Stop current playback and abort ongoing synthesis.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.stopSignalResolver) {
      this.stopSignalResolver();
      this.stopSignalResolver = null;
    }
    if (this.activeStreamSession) {
      await this.activeStreamSession.cancel().catch(() => {});
      this.activeStreamSession = null;
      this.isSynthesizing = false;
    }
    neuralAudioPlayer.stop().catch(() => {});
  }

  async destroy(): Promise<void> {
    this.stopRequested = true;
    if (this.session) {
      this.session = null;
    }
    this.isInitialized = false;
    this.isLoading = false;
    this.initError = null;
    this.config = null;
  }

  private async waitForSynthesisComplete(
    timeoutMs: number = 5000,
  ): Promise<void> {
    if (!this.isSynthesizing) {
      return;
    }

    log.debug('Waiting for synthesis to complete...');

    return new Promise<void>(resolve => {
      this.synthesisCompleteResolver = resolve;

      setTimeout(() => {
        if (this.synthesisCompleteResolver === resolve) {
          log.warn('Synthesis wait timeout, proceeding with release');
          this.synthesisCompleteResolver = null;
          resolve();
        }
      }, timeoutMs);
    });
  }

  private resetState(): void {
    this.isInitialized = false;
    this.isLoading = false;
    this.initError = null;
    this.config = null;
  }

  /**
   * Release model resources from memory while keeping engine instance reusable.
   */
  async release(): Promise<ReleaseResult> {
    const errors: ReleaseError[] = [];

    if (!this.isInitialized && !this.isLoading) {
      log.debug('Engine already released, skipping');
      return {success: true, partialRelease: false, errors: []};
    }

    log.info('Releasing engine resources...');

    if (this.isLoading) {
      log.warn('Cannot release while engine is loading');
      return {
        success: false,
        partialRelease: false,
        errors: [
          {
            component: 'engine',
            error: new Error('Cannot release while loading'),
          },
        ],
      };
    }

    this.stopRequested = true;

    try {
      await neuralAudioPlayer.stop();
      log.debug('Audio player stopped');
    } catch (e) {
      log.warn('Failed to stop audio player:', e);
      errors.push({component: 'audioPlayer', error: e as Error});
    }

    await this.waitForSynthesisComplete();

    if (this.session) {
      try {
        if (typeof this.session.release === 'function') {
          await this.session.release();
          log.debug('ONNX session released');
        }
      } catch (e) {
        log.warn('Failed to release ONNX session:', e);
        errors.push({component: 'session', error: e as Error});
      }
      this.session = null;
    }

    try {
      this.voiceLoader.clear();
      log.debug('Voice loader cleared');
    } catch (e) {
      log.warn('Failed to clear voice loader:', e);
      errors.push({component: 'voiceLoader', error: e as Error});
    }

    try {
      this.tokenizer.clear();
      log.debug('Tokenizer cleared');
    } catch (e) {
      log.warn('Failed to clear tokenizer:', e);
      errors.push({component: 'tokenizer', error: e as Error});
    }

    this.resetState();

    const success = errors.length === 0;
    log.info(
      success
        ? 'Engine resources released successfully'
        : `Engine released with ${errors.length} error(s)`,
    );

    return {success, partialRelease: errors.length > 0, errors};
  }

  getStatus() {
    return {
      isReady: this.isInitialized,
      isLoading: this.isLoading,
      error: this.initError,
    };
  }

  // --- Private initialization methods ---

  private async loadModel(modelPath: string): Promise<void> {
    const {InferenceSession} = getOnnxRuntime();

    try {
      const executionProviders = resolveExecutionProviders(
        this.config?.executionProviders,
      );

      log.debug(
        `Loading model with providers: ${JSON.stringify(executionProviders)}`,
      );

      const startTime = Date.now();
      this.session = await InferenceSession.create(modelPath, {
        executionProviders,
      });
      const loadTime = Date.now() - startTime;
      log.info(`Model loaded in ${loadTime}ms`);

      // Log model I/O metadata for debugging
      try {
        const inputNames = this.session.inputNames || [];
        const outputNames = this.session.outputNames || [];
        log.debug(`Model inputs: ${JSON.stringify(inputNames)}`);
        log.debug(`Model outputs: ${JSON.stringify(outputNames)}`);
      } catch {
        log.debug('Could not read model I/O metadata');
      }
    } catch (error) {
      log.warn(
        `Failed to load with acceleration, trying CPU fallback: ${error instanceof Error ? error.message : 'Unknown'}`,
      );

      try {
        this.session = await InferenceSession.create(modelPath, {
          executionProviders: ['cpu'],
        });
        log.info('Model loaded with CPU fallback');
      } catch (fallbackError) {
        throw new Error(
          `Failed to load ONNX model: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown'}`,
        );
      }
    }
  }

  private async loadTokenizer(tokenizerPath: string): Promise<void> {
    try {
      log.debug('Loading tokenizer from file');
      const {loadAssetAsJSON} = require('../../utils/AssetLoader');
      const vocabData = await loadAssetAsJSON(tokenizerPath);
      await this.tokenizer.loadFromData(vocabData);
      log.debug(`Tokenizer loaded: ${Object.keys(vocabData).length} symbols`);
    } catch (error) {
      throw new Error(
        `Failed to load tokenizer: ${error instanceof Error ? error.message : 'Unknown'}`,
      );
    }
  }

  private async loadVoices(voicesPath: string): Promise<void> {
    try {
      const {loadAssetAsJSON} = require('../../utils/AssetLoader');

      if (voicesPath.includes('manifest') && voicesPath.endsWith('.json')) {
        log.debug('Loading voices from manifest (lazy loading)');
        const manifest = await loadAssetAsJSON(voicesPath);
        await this.voiceLoader.loadFromManifest(manifest, voicesPath);
      } else if (voicesPath.endsWith('.json')) {
        log.debug('Loading voices from JSON');
        const voicesData = await loadAssetAsJSON(voicesPath);
        await this.voiceLoader.loadFromJSON(voicesData);
      } else {
        throw new Error(
          'Kitten voices must be in JSON format. Use scripts/convert-kitten-voices.py to convert NPZ files.',
        );
      }

      log.info(
        `Voice loader ready: ${this.voiceLoader.getAvailableVoices().length} voices`,
      );
    } catch (error) {
      throw new Error(
        `Failed to load voices: ${error instanceof Error ? error.message : 'Unknown'}`,
      );
    }
  }
}
