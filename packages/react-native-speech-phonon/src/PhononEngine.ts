/**
 * Phonon TTS Engine
 *
 * Gradium's Phonon (xn-ptts) runs entirely in native code: CPU on
 * Android (`libptts_ffi.so`), Core ML on iOS. Unlike the ONNX engines,
 * PCM never crosses into JS on the playback path: native synthesizes
 * into a buffer store and JS passes buffer ids to the player.
 *
 * - Request ids are issued natively (process-wide, monotonic). Stop and
 *   stream cancel call `cancelUpTo(max in-flight id)` synchronously.
 * - Every `synthesize()` / `synthesizeStream()` call captures a
 *   generation. A chunk result from an older generation is released,
 *   never played, even if it arrives after a newer call started.
 * - Every native synthesize and create races a watchdog. On timeout the
 *   engine is marked broken for the process (a hung native worker cannot
 *   be recovered without a restart) and reports `ERR_PHONON_TIMEOUT`.
 *   Once broken, release/destroy never wait for the native destroy: it is
 *   queued behind the hung job on the serial worker.
 *
 * Register it with `Speech.registerEngine(new PhononEngine())`, then check
 * `PhononEngine.getSupport()` (or `Speech.getEngineSupport(PHONON)`) first.
 */

import {
  isPhonemeInput,
  createMarkdownStreamBuffer,
  type TTSEngineInterface,
  type AudioBuffer,
  type EngineStreamHandle,
  type ChunkProgressEvent,
  type ChunkProgressCallback,
  type ReleaseResult,
  type ReleaseError,
  type SpeechInput,
} from '@pocketpalai/react-native-speech';
import {
  neuralAudioPlayer,
  EngineStreamSession,
  TextChunker,
  findFirstClauseEnd,
  stripMarkdown,
  base64ToArrayBuffer,
  loadAssetAsText,
  createComponentLogger,
  type PlaybackOptions,
  type TextChunk,
} from '@pocketpalai/react-native-speech/engine-sdk';
import type {PhononConfig, PhononSynthesisOptions, PhononVoice} from './types';
import type {
  PhononDiagnostics,
  PhononLoadResult,
  PhononPlayConfig,
  PhononSupportInfo,
  PhononSynthResult,
} from './NativeSpeechPhonon';
import NativePhonon, {NOT_COMPILED_SUPPORT} from './NativePhonon';
import {PHONON, PHONON_CONSTANTS, PHONON_LANGUAGES} from './constants';
import {
  PhononError,
  PhononUnsupportedError,
  isNothingToSynthesize,
  nativeCodeOf,
  toPhononError,
} from './errors';
import {buildVoices, parseVoicesJsonl, type PhononCatalogEntry} from './voices';

const log = createComponentLogger('Phonon', 'Engine');

const {
  DEFAULT_MAX_CHUNK_SIZE,
  SAMPLE_RATE,
  DEFAULT_LANGUAGE,
  DEFAULT_COMPUTE_UNIT,
  WATCHDOG_MIN_MS,
  WATCHDOG_FACTOR,
  ESTIMATED_MS_PER_CHAR,
  CREATE_WATCHDOG_MS,
  CREATE_COMPILE_WATCHDOG_MS,
} = PHONON_CONSTANTS;

/**
 * One synthesized chunk. The PCM stays native (`bufferId`); `pcm` is a
 * JS copy made only when the caller set `onAudioChunk`.
 */
export interface PhononChunk {
  requestId: number;
  /** 0 when the chunk has no audio (cancelled, stale or empty) */
  bufferId: number;
  samples: number;
  sampleRate: number;
  durationSec: number;
  pcm?: Float32Array;
  /** Native timings; null for an empty chunk */
  result: PhononSynthResult | null;
  chars: number;
}

/** Per-chunk timeline, also logged as a `[BENCH]` line. */
export interface PhononChunkMetrics {
  event: 'PHONON_CHUNK';
  path: 'synth' | 'stream';
  requestId: number;
  chars: number;
  samples: number;
  audioSec: number;
  ttfaMs: number;
  totalMs: number;
  queuedMs: number;
  /** Native monotonic clock */
  startedAtMs: number;
  /** Native monotonic clock */
  finishedAtMs: number;
  /** JS wall clock (Date.now) when playback was requested */
  playStartTs: number;
  /** JS wall clock when playback ended (finished or stopped) */
  playEndTs: number;
  voiceChanged: boolean;
}

/** State shared by all chunks of one synthesize/stream call. */
interface RunContext {
  gen: number;
  voice: string;
  language: string;
  wantPcm: boolean;
  path: 'synth' | 'stream';
  /** Request ids of this call that are still in flight */
  ids: Set<number>;
}

/**
 * Set when a watchdog fires. Process-wide: a hung native worker outlives
 * any engine instance, so every instance refuses work until restart.
 */
let brokenError: PhononError | null = null;
let signalBroken: () => void = () => {};
/** Resolves once `brokenError` is set. */
let brokenSignal = newBrokenSignal();

function newBrokenSignal(): Promise<void> {
  return new Promise<void>(resolve => {
    signalBroken = resolve;
  });
}

function markBroken(error: PhononError): void {
  brokenError = error;
  signalBroken();
}

function timeoutError(what: string, detail: string): PhononError {
  return new PhononError(
    'ERR_PHONON_TIMEOUT',
    `Phonon ${what} timed out (${detail}); the engine is unavailable until the app restarts`,
  );
}

/** Watchdog budget of a native create. */
export function phononCreateWatchdogMs(needsCompile: boolean): number {
  return needsCompile ? CREATE_COMPILE_WATCHDOG_MS : CREATE_WATCHDOG_MS;
}

/** Support reasons that depend on the model on disk, so are never cached. */
const UNCACHED_REASONS: readonly string[] = ['load-failed'];

/** Normalize 'en-US' / 'en_GB' / 'EN' to the base language code. */
export function normalizePhononLanguage(language: string): string {
  return (language.split(/[-_]/)[0] ?? '').trim().toLowerCase();
}

/** Watchdog budget for one native synthesize of `text`. */
export function phononWatchdogMs(text: string): number {
  return Math.max(
    WATCHDOG_MIN_MS,
    WATCHDOG_FACTOR * text.length * ESTIMATED_MS_PER_CHAR,
  );
}

/** Decode native base64 little-endian float32 PCM. */
function decodePcm(base64: string): Float32Array {
  if (!base64) {
    return new Float32Array(0);
  }
  const buffer = base64ToArrayBuffer(base64);
  return new Float32Array(buffer, 0, Math.floor(buffer.byteLength / 4));
}

function playConfig(
  sampleRate: number,
  options: PlaybackOptions,
  volume: number | undefined,
): PhononPlayConfig {
  const config: PhononPlayConfig = {sampleRate};
  if (options.ducking !== undefined) {
    config.ducking = options.ducking;
  }
  if (options.silentMode !== undefined) {
    config.silentMode = options.silentMode;
  }
  if (volume !== undefined) {
    config.volume = Math.max(0, Math.min(1, volume));
  }
  return config;
}

function errorSupport(detail: string): PhononSupportInfo {
  return {...NOT_COMPILED_SUPPORT, supported: false, reason: 'error', detail};
}

export class PhononEngine implements TTSEngineInterface<PhononConfig> {
  readonly name = PHONON;

  /** Last resolved support probe; rejections are never cached. */
  private static supportCache: PhononSupportInfo | null = null;

  private config: PhononConfig | null = null;
  private loadResult: PhononLoadResult | null = null;
  private handleId = 0;
  private language: string = DEFAULT_LANGUAGE;
  private catalog: PhononCatalogEntry[] = [];
  private isInitialized = false;
  /** initialize() calls not yet settled (queued or running) */
  private pendingInits = 0;
  /**
   * initialize() and destroy() run one at a time, in call order, so a
   * concurrent re-initialization (EngineManager: destroy + initialize)
   * never overlaps a create in flight. Never rejects.
   */
  private lifecycle: Promise<void> = Promise.resolve();
  private initError: string | null = null;

  // Cancellation and re-entry
  private generation = 0;
  private callSeq = 0;
  private readonly inflight = new Set<number>();
  private readonly stopResolvers = new Set<() => void>();
  private activeRun: Promise<void> | null = null;
  private activeStreamSession: EngineStreamSession<PhononChunk> | null = null;

  private chunkProgressCallback: ChunkProgressCallback | null = null;
  private lastMetrics: PhononChunkMetrics | null = null;
  private readonly metricsListeners = new Set<
    (metrics: PhononChunkMetrics) => void
  >();
  private warnedSpeed = false;
  private warnedPitch = false;

  /**
   * Cheap capability probe; never loads the Phonon library and never
   * throws. A resolved probe is cached for the process; a rejection
   * reports `reason: 'error'` and is retried on the next call.
   * `supported` is true only for `reason: 'ok'`.
   */
  static async getSupport(): Promise<PhononSupportInfo> {
    const cached = PhononEngine.supportCache;
    if (cached) {
      return {...cached};
    }
    try {
      const info = await NativePhonon.getSupport();
      if (
        !info ||
        typeof info.supported !== 'boolean' ||
        typeof info.reason !== 'string'
      ) {
        return errorSupport('malformed support info from native');
      }
      const normalized: PhononSupportInfo = {
        ...NOT_COMPILED_SUPPORT,
        ...info,
        supported: info.supported && info.reason === 'ok',
        detail: info.detail ?? '',
      };
      // Native drops a load-failed record when the model changes.
      if (!UNCACHED_REASONS.includes(normalized.reason)) {
        PhononEngine.supportCache = normalized;
      }
      return {...normalized};
    } catch (e) {
      return errorSupport(e instanceof Error ? e.message : String(e));
    }
  }

  /** Drop the cached probe (e.g. after a load failure was recorded). */
  static clearSupportCache(): void {
    PhononEngine.supportCache = null;
  }

  /**
   * Clear the persisted capability record (native) and the cached probe.
   * Never throws; resolves false if native could not clear the record.
   */
  static async resetSupport(): Promise<boolean> {
    PhononEngine.supportCache = null;
    try {
      return await NativePhonon.resetSupport();
    } catch (e) {
      log.warn('resetSupport failed:', e);
      return false;
    } finally {
      PhononEngine.supportCache = null;
    }
  }

  /**
   * iOS: true if the model bundle still has to be compiled for Core ML,
   * so a load will take seconds. Android: always false. Never throws.
   */
  static async needsCompile(modelPath: string): Promise<boolean> {
    try {
      return await NativePhonon.needsCompile(modelPath);
    } catch {
      return false;
    }
  }

  /** Native memory/thread/buffer diagnostics. Never throws. */
  static async getDiagnostics(): Promise<PhononDiagnostics | null> {
    try {
      return await NativePhonon.getDiagnostics();
    } catch (e) {
      log.warn('getDiagnostics failed:', e);
      return null;
    }
  }

  /** `TTSEngineInterface.getSupport`, used by `Speech.getEngineSupport`. */
  getSupport(): Promise<PhononSupportInfo> {
    return PhononEngine.getSupport();
  }

  /** `TTSEngineInterface.resetSupport`, used by `Speech.resetEngineSupport`. */
  resetSupport(): Promise<boolean> {
    return PhononEngine.resetSupport();
  }

  setChunkProgressCallback(callback: ChunkProgressCallback | null): void {
    this.chunkProgressCallback = callback;
  }

  /** Never throws: a throwing listener must not abort playback. */
  private emitChunkProgress(event: ChunkProgressEvent): void {
    if (!this.chunkProgressCallback) {
      return;
    }
    try {
      this.chunkProgressCallback(event);
    } catch (e) {
      log.warn('chunk progress callback threw; continuing:', e);
    }
  }

  /** Run a lifecycle step after every earlier initialize()/destroy(). */
  private serialized(step: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(step);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /**
   * Initialize: support probe → (compile check) → native create.
   * Rejects `ERR_PHONON_UNSUPPORTED` without touching the native
   * library when the probe is negative. A call made while another
   * initialize() or destroy() runs waits for it; once initialized,
   * initialize() is a no-op until destroy()/release().
   */
  initialize(config?: PhononConfig): Promise<void> {
    this.pendingInits++;
    const run = this.serialized(() => this.initializeNow(config));
    // Registered first, so callers see isLoading=false once run settles.
    const settle = () => {
      this.pendingInits--;
    };
    run.then(settle, settle);
    return run;
  }

  private get isLoading(): boolean {
    return this.pendingInits > 0;
  }

  private async initializeNow(config?: PhononConfig): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    if (brokenError) {
      throw brokenError;
    }

    this.initError = null;
    const initStart = Date.now();

    try {
      if (!config || !config.modelPath) {
        throw new Error('Phonon config with modelPath required');
      }

      const language = normalizePhononLanguage(
        config.language ?? DEFAULT_LANGUAGE,
      );
      if (!(PHONON_LANGUAGES as readonly string[]).includes(language)) {
        throw new PhononError(
          'ERR_PHONON_LANGUAGE',
          `Unsupported Phonon language '${config.language}'. Supported: ${PHONON_LANGUAGES.join(', ')}`,
        );
      }

      const support = await PhononEngine.getSupport();
      if (!support.supported) {
        throw new PhononUnsupportedError(support.reason, support.detail);
      }

      const needsCompile = await PhononEngine.needsCompile(config.modelPath);
      if (needsCompile) {
        log.info('Model needs a Core ML compile; the first load is slow');
      }

      let result: PhononLoadResult;
      try {
        result = await this.withWatchdog(
          NativePhonon.create(config.modelPath, {
            language,
            numThreads: config.numThreads ?? 0,
            computeUnit: config.computeUnit ?? DEFAULT_COMPUTE_UNIT,
            spinBudget: config.spinBudget ?? 0,
          }),
          phononCreateWatchdogMs(needsCompile),
          budget => timeoutError('load', `${budget} ms`),
          // A handle created after the timeout is freed, never used.
          late => {
            NativePhonon.destroy(late.handleId).catch(() => {});
          },
        );
      } catch (e) {
        const err = toPhononError(e);
        if (
          err.code === 'ERR_PHONON_UNSUPPORTED' ||
          err.code === 'ERR_PHONON_LOAD'
        ) {
          // Native may have recorded a negative capability; re-probe.
          PhononEngine.clearSupportCache();
        }
        throw err;
      }

      this.handleId = result.handleId;
      this.loadResult = result;
      this.config = config;
      this.language = language;

      if (
        language !== 'none' &&
        result.languages.length > 0 &&
        !result.languages.includes(language)
      ) {
        throw new PhononError(
          'ERR_PHONON_LANGUAGE',
          `Model does not support language '${language}'. Supported: ${result.languages.join(', ')}`,
        );
      }
      if (config.defaultVoice) {
        this.resolveVoice(config.defaultVoice);
      }

      if (config.voicesMetadataPath) {
        this.catalog = await this.loadCatalog(config.voicesMetadataPath);
      }

      this.isInitialized = true;
      log.info(
        `engine_init_ms=${Date.now() - initStart} load_ms=${result.loadMs} ` +
          `voices=${result.voices.length} threads=${result.numThreads} ` +
          `unit=${result.computeUnit} compiled=${result.compiled}`,
      );
    } catch (error) {
      // Clean up partial initialization to allow retry.
      await this.teardown();
      this.initError = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof PhononUnsupportedError) {
        // Expected gating outcome: no console.error, so no LogBox in dev.
        log.info(`Initialization skipped: ${error.message}`);
      } else if (
        error instanceof PhononError &&
        error.code === 'ERR_PHONON_LOAD'
      ) {
        log.warn('Initialization failed:', error);
      } else {
        log.error('Initialization failed:', error);
      }
      throw error;
    }
  }

  async isReady(): Promise<boolean> {
    return this.isInitialized && this.handleId > 0 && brokenError === null;
  }

  /** Native load result of the current handle, or null. */
  getLoadInfo(): PhononLoadResult | null {
    return this.loadResult ? {...this.loadResult} : null;
  }

  /** Timeline of the last played chunk, or null. */
  getLastMetrics(): PhononChunkMetrics | null {
    return this.lastMetrics ? {...this.lastMetrics} : null;
  }

  /**
   * Call `listener` with the timeline of every chunk once its playback
   * ends. Returns the unsubscribe function.
   */
  onChunkMetrics(listener: (metrics: PhononChunkMetrics) => void): () => void {
    this.metricsListeners.add(listener);
    return () => {
      this.metricsListeners.delete(listener);
    };
  }

  getStatus(): {isReady: boolean; isLoading: boolean; error: string | null} {
    return {
      isReady: this.isInitialized && brokenError === null,
      isLoading: this.isLoading,
      error: brokenError?.message ?? this.initError,
    };
  }

  /**
   * Synthesize text and play it, chunk by chunk, synthesizing the next
   * chunk while the current one plays. Resolves when playback ends or
   * the call is superseded / stopped.
   */
  async synthesize(
    input: SpeechInput,
    options?: PhononSynthesisOptions,
  ): Promise<void> {
    this.assertUsable();

    if (isPhonemeInput(input)) {
      throw new Error(
        'Phonon engine has no phoneme path; phoneme input requires ' +
          'the Kokoro or Kitten engine.',
      );
    }
    const text = input;
    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    const ctxBase = this.prepareCall(options);

    // Re-entry: cancel the previous call and wait for it to unwind
    // before starting, so two calls never interleave native requests.
    const ticket = ++this.callSeq;
    const unwound = this.unwind();
    // Captured after unwind's own generation bump: any later stop() or
    // newer call bumps it again and supersedes this one.
    const gen = this.generation;
    await unwound;
    if (ticket !== this.callSeq || gen !== this.generation) {
      return;
    }
    this.assertUsable();

    const ctx: RunContext = {
      ...ctxBase,
      gen,
      wantPcm: !!options?.onAudioChunk,
      path: 'synth',
      ids: new Set(),
    };
    const run = this.runSynthesis(text, options, ctx);
    this.activeRun = run;
    try {
      await run;
    } finally {
      if (this.activeRun === run) {
        this.activeRun = null;
      }
    }
  }

  synthesizeStream(options?: PhononSynthesisOptions): EngineStreamHandle {
    this.assertUsable();
    const ctxBase = this.prepareCall(options);

    // Re-entry: unwind() runs its synchronous part (generation bump,
    // native cancel, session cancel) now; the new session's first
    // native request waits until the previous call has unwound.
    ++this.callSeq;
    const previous = this.unwind();

    const ctx: RunContext = {
      ...ctxBase,
      gen: this.generation,
      wantPcm: !!options?.onAudioChunk,
      path: 'stream',
      ids: new Set(),
    };
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;

    const stripMd = options?.stripMarkdown !== false;
    const mdBuffer = stripMd
      ? createMarkdownStreamBuffer({firstChunk: options?.firstChunk})
      : null;

    const playbackOptions = {
      ducking: options?.ducking,
      silentMode: options?.silentMode,
    };
    const volume = options?.volume;

    const session = new EngineStreamSession<PhononChunk>({
      synthesizeChunk: async (chunkText: string) => {
        await previous;
        return this.synthesizeChunk(chunkText, ctx);
      },
      playAudio: chunk => this.playChunk(chunk, playbackOptions, volume, ctx),
      stopPlayback: () => neuralAudioPlayer.stop(),
      hasAudio: chunk => chunk.bufferId > 0 && chunk.samples > 0,
      discard: chunk => this.releaseChunk(chunk),
      onCancel: () => this.cancelIds(ctx.ids),
      maxChunkSize,
      firstChunk: options?.firstChunk,
      postProcess: options?.onAudioChunk
        ? chunk => this.observeChunk(chunk, options)
        : undefined,
      // Always bind: listeners may subscribe after the stream starts.
      onChunkProgress: event => this.emitChunkProgress(event),
    });

    this.activeStreamSession = session;
    const settle = () => {
      if (this.activeStreamSession === session) {
        this.activeStreamSession = null;
      }
    };

    return {
      append: (chunkText: string) => {
        if (mdBuffer) {
          const emit = mdBuffer.push(chunkText);
          if (emit) session.append(emit);
        } else {
          session.append(chunkText);
        }
      },
      finalize: async () => {
        if (mdBuffer) {
          const tail = mdBuffer.flush();
          if (tail) session.append(tail);
        }
        try {
          await session.finalize();
        } finally {
          settle();
        }
      },
      cancel: async () => {
        try {
          await session.cancel();
        } finally {
          settle();
        }
      },
    };
  }

  private assertUsable(): void {
    if (brokenError) {
      throw brokenError;
    }
    if (!this.isInitialized || this.handleId <= 0) {
      throw new PhononError(
        'ERR_PHONON_NOT_INITIALIZED',
        'Phonon engine not initialized',
      );
    }
  }

  /** Resolve voice/language for a call and warn about ignored options. */
  private prepareCall(
    options?: PhononSynthesisOptions,
  ): Pick<RunContext, 'voice' | 'language'> {
    if (
      options?.speed !== undefined &&
      options.speed !== 1 &&
      !this.warnedSpeed
    ) {
      this.warnedSpeed = true;
      log.warn('speed is not supported by Phonon v0.4.0; ignored');
    }
    if (
      options?.pitch !== undefined &&
      options.pitch !== 1 &&
      !this.warnedPitch
    ) {
      this.warnedPitch = true;
      log.warn('pitch is not supported by Phonon; ignored');
    }
    const voice = this.resolveVoice(
      options?.voiceId ?? this.config?.defaultVoice ?? '',
    );
    const language = this.resolveLanguage(options?.language);
    return {voice, language};
  }

  /**
   * `''` lets native use upstream's default voice. Any other id must be
   * one of the model's voices (matched case-insensitively).
   */
  private resolveVoice(voiceId: string): string {
    if (!voiceId) {
      return '';
    }
    const voices = this.loadResult?.voices ?? [];
    if (voices.includes(voiceId)) {
      return voiceId;
    }
    const folded = voiceId.toLowerCase();
    const match = voices.find(v => v.toLowerCase() === folded);
    if (match) {
      return match;
    }
    throw new PhononError(
      'ERR_PHONON_VOICE',
      voices.length > 0
        ? `Unknown Phonon voice '${voiceId}'. Available: ${voices.join(', ')}`
        : `Unknown Phonon voice '${voiceId}': this model has no voices`,
    );
  }

  private resolveLanguage(requested?: string): string {
    if (!requested) {
      return this.language;
    }
    const language = normalizePhononLanguage(requested);
    if (language === 'none') {
      return language;
    }
    const supported = this.loadResult?.languages ?? [];
    if (!supported.includes(language)) {
      throw new PhononError(
        'ERR_PHONON_LANGUAGE',
        `Unsupported Phonon language '${requested}'. Supported: ${[...supported, 'none'].join(', ')}`,
      );
    }
    return language;
  }

  /**
   * Re-entry: cancel whatever this engine is doing and resolve once it
   * has unwound. The synchronous part (generation bump, native cancel,
   * session cancel) runs before this returns. Never rejects.
   */
  private unwind(): Promise<void> {
    const previousRun = this.activeRun;
    if (!previousRun && !this.activeStreamSession) {
      return Promise.resolve();
    }
    // stop() awaits the cancelled session's loop.
    const stopped = this.stop();
    return Promise.all([stopped, previousRun?.catch(() => {})]).then(() => {});
  }

  private createStopSignal(): {signal: Promise<null>; dispose: () => void} {
    let resolver!: () => void;
    const signal = new Promise<null>(resolve => {
      resolver = () => resolve(null);
    });
    this.stopResolvers.add(resolver);
    return {signal, dispose: () => this.stopResolvers.delete(resolver)};
  }

  private async runSynthesis(
    text: string,
    options: PhononSynthesisOptions | undefined,
    ctx: RunContext,
  ): Promise<void> {
    const utteranceId = Date.now();
    const {signal: stopSignal, dispose} = this.createStopSignal();

    const cleanText =
      options?.stripMarkdown === false ? text : stripMarkdown(text);
    const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    const chunks = TextChunker.chunkBySentences(cleanText, maxChunkSize);
    if (options?.firstChunk === 'clause') {
      splitFirstClause(chunks);
    }
    log.debug(`Split into ${chunks.length} chunks`);

    const playbackOptions = {
      ducking: options?.ducking,
      silentMode: options?.silentMode,
    };
    const stale = () => ctx.gen !== this.generation;

    // Prefetched next chunk; released if the loop ends before using it.
    let next: Promise<PhononChunk> | null = null;

    try {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        if (stale()) {
          return;
        }
        const chunk = chunks[chunkIndex] as TextChunk;

        const pending: Promise<PhononChunk> =
          next ?? this.synthesizeChunk(chunk.text, ctx);
        next = null;
        const audio = await raceWithStop(pending, stopSignal);
        if (audio === null) {
          // Stop won; synthesizeChunk releases the stale result itself.
          return;
        }
        if (stale()) {
          this.releaseChunk(audio);
          return;
        }
        if (audio.bufferId <= 0 || audio.samples <= 0) {
          log.debug(`chunk ${chunkIndex} produced no audio; skipping`);
          continue;
        }

        const nextChunk = chunks[chunkIndex + 1];
        if (nextChunk) {
          next = this.synthesizeChunk(nextChunk.text, ctx);
          // Observed when awaited; avoids an unhandled rejection on early exit.
          next.catch(() => {});
        }

        if (options?.onAudioChunk) {
          this.observeChunk(audio, options);
        }

        this.emitChunkProgress({
          id: utteranceId,
          chunkIndex,
          totalChunks: chunks.length,
          chunkText: chunk.text,
          textRange: {start: chunk.startIndex, end: chunk.endIndex},
          progress: Math.round((chunkIndex / chunks.length) * 100),
        });
        // The callbacks above may have called stop().
        if (stale()) {
          this.releaseChunk(audio);
          return;
        }

        await raceWithStop(
          this.playChunk(audio, playbackOptions, options?.volume, ctx),
          stopSignal,
        );
      }
    } finally {
      dispose();
      if (next) {
        next.then(
          c => this.releaseChunk(c),
          () => {},
        );
      }
    }
  }

  /**
   * Synthesize one chunk natively. Never rejects for a stale generation:
   * a late or failed result of a superseded call is released and comes
   * back empty.
   */
  private async synthesizeChunk(
    text: string,
    ctx: RunContext,
  ): Promise<PhononChunk> {
    const empty = (requestId = 0): PhononChunk => ({
      requestId,
      bufferId: 0,
      samples: 0,
      sampleRate: this.loadResult?.sampleRate || SAMPLE_RATE,
      durationSec: 0,
      result: null,
      chars: text.length,
    });
    const stale = () => ctx.gen !== this.generation;

    if (stale()) {
      return empty();
    }
    if (brokenError) {
      throw brokenError;
    }

    const requestId = NativePhonon.allocRequestId();
    if (requestId <= 0) {
      throw new PhononUnsupportedError(
        'not-compiled',
        'phononAllocRequestId returned no id',
      );
    }
    this.inflight.add(requestId);
    ctx.ids.add(requestId);

    let res: PhononSynthResult;
    try {
      res = await this.withWatchdog(
        NativePhonon.synthesize(
          this.handleId,
          requestId,
          text,
          ctx.voice,
          ctx.language,
        ),
        phononWatchdogMs(text),
        budget => {
          NativePhonon.cancelUpTo(requestId);
          return timeoutError(
            'synthesis',
            `request ${requestId}, ${text.length} chars, ${budget} ms`,
          );
        },
        late => {
          if (late.bufferId > 0) {
            NativePhonon.releaseBuffer(late.bufferId);
          }
        },
      );
    } catch (e) {
      if (stale()) {
        // Cancelled or released underneath (typically INVALID_HANDLE).
        log.debug(
          `ignoring error of stale request ${requestId}: ${nativeCodeOf(e) ?? e}`,
        );
        return empty(requestId);
      }
      if (isNothingToSynthesize(e)) {
        log.debug(`nothing to synthesize in ${JSON.stringify(text)}; skipping`);
        return empty(requestId);
      }
      throw toPhononError(e);
    } finally {
      this.inflight.delete(requestId);
      ctx.ids.delete(requestId);
    }

    if (res.cancelled || stale() || res.bufferId <= 0 || res.samples <= 0) {
      if (res.bufferId > 0) {
        NativePhonon.releaseBuffer(res.bufferId);
      }
      return empty(requestId);
    }

    const sampleRate =
      res.sampleRate || this.loadResult?.sampleRate || SAMPLE_RATE;
    const chunk: PhononChunk = {
      requestId,
      bufferId: res.bufferId,
      samples: res.samples,
      sampleRate,
      durationSec: res.samples / sampleRate,
      result: res,
      chars: text.length,
    };

    if (ctx.wantPcm) {
      try {
        chunk.pcm = decodePcm(await NativePhonon.copyBuffer(res.bufferId));
      } catch (e) {
        if (!stale()) {
          NativePhonon.releaseBuffer(res.bufferId);
          throw toPhononError(e);
        }
      }
      if (stale()) {
        NativePhonon.releaseBuffer(res.bufferId);
        return empty(requestId);
      }
    }
    return chunk;
  }

  /**
   * Race a native call against the watchdog. On timeout `onTimeout`
   * builds the error (and cancels what it can), the engine is marked
   * broken for the process, and a late result goes to `onLate`.
   */
  private withWatchdog<T>(
    promise: Promise<T>,
    budget: number,
    onTimeout: (budget: number) => PhononError,
    onLate: (late: T) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        const error = onTimeout(budget);
        markBroken(error);
        log.error(error.message);
        reject(error);
      }, budget);
      promise.then(
        res => {
          if (timedOut) {
            onLate(res);
            return;
          }
          clearTimeout(timer);
          resolve(res);
        },
        err => {
          if (timedOut) {
            return;
          }
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Play a chunk via the shared player (consumes the native buffer). */
  private async playChunk(
    chunk: PhononChunk,
    playbackOptions: PlaybackOptions,
    volume: number | undefined,
    ctx: RunContext,
  ): Promise<void> {
    const playStartTs = Date.now();
    try {
      const config = playConfig(chunk.sampleRate, playbackOptions, volume);
      await neuralAudioPlayer.playNative(() =>
        NativePhonon.playBuffer(chunk.bufferId, config),
      );
    } finally {
      this.recordMetrics(chunk, ctx.path, playStartTs, Date.now());
    }
  }

  /**
   * Hand the JS copy to `onAudioChunk`, right before playback and after
   * volume, so it matches what the speaker plays. Only played chunks are
   * observed.
   */
  private observeChunk(
    chunk: PhononChunk,
    options: PhononSynthesisOptions,
  ): void {
    if (!chunk.pcm || !options.onAudioChunk) {
      return;
    }
    const samples = chunk.pcm;
    const volume = options.volume;
    if (volume !== undefined && volume !== 1.0) {
      const v = Math.max(0, Math.min(1, volume));
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (s !== undefined) {
          samples[i] = Math.max(-1, Math.min(1, s * v));
        }
      }
    }
    const buffer: AudioBuffer = {
      samples,
      sampleRate: chunk.sampleRate,
      channels: 1,
      duration: chunk.durationSec,
    };
    try {
      options.onAudioChunk(buffer);
    } catch (e) {
      log.warn('onAudioChunk threw; continuing synthesis:', e);
    }
  }

  private recordMetrics(
    chunk: PhononChunk,
    path: 'synth' | 'stream',
    playStartTs: number,
    playEndTs: number,
  ): void {
    const res = chunk.result;
    const metrics: PhononChunkMetrics = {
      event: 'PHONON_CHUNK',
      path,
      requestId: chunk.requestId,
      chars: chunk.chars,
      samples: chunk.samples,
      audioSec: chunk.durationSec,
      ttfaMs: res?.ttfaMs ?? 0,
      totalMs: res?.totalMs ?? 0,
      queuedMs: res?.queuedMs ?? 0,
      startedAtMs: res?.startedAtMs ?? 0,
      finishedAtMs: res?.finishedAtMs ?? 0,
      playStartTs,
      playEndTs,
      voiceChanged: res?.voiceChanged ?? false,
    };
    this.lastMetrics = metrics;
    log.info(`[BENCH] ${JSON.stringify(metrics)}`);
    for (const listener of this.metricsListeners) {
      try {
        listener({...metrics});
      } catch (e) {
        log.warn('chunk metrics listener threw; continuing:', e);
      }
    }
  }

  private releaseChunk(chunk: PhononChunk): void {
    if (chunk.bufferId > 0) {
      NativePhonon.releaseBuffer(chunk.bufferId);
    }
  }

  /** Synchronously cancel every in-flight native request of `ids`. */
  private cancelIds(ids: ReadonlySet<number>): void {
    let max = 0;
    for (const id of ids) {
      if (id > max) {
        max = id;
      }
    }
    if (max > 0) {
      NativePhonon.cancelUpTo(max);
    }
  }

  async getAvailableVoices(language?: string): Promise<string[]> {
    return this.getVoicesWithMetadata(language).map(v => v.id);
  }

  /**
   * Voices of the loaded model, with display metadata from
   * `voicesMetadataPath` when given. Voices added to the model folder
   * after `initialize()` appear only after re-initializing.
   */
  getVoicesWithMetadata(language?: string): PhononVoice[] {
    if (!this.isInitialized || !this.loadResult) {
      throw new PhononError(
        'ERR_PHONON_NOT_INITIALIZED',
        'Phonon engine not initialized',
      );
    }
    const voices = buildVoices(
      this.loadResult.voices,
      this.catalog,
      this.language === 'none' ? undefined : this.language,
    );
    if (!language) {
      return voices;
    }
    const wanted = normalizePhononLanguage(language);
    return voices.filter(
      v => !v.language || normalizePhononLanguage(v.language) === wanted,
    );
  }

  private async loadCatalog(path: string): Promise<PhononCatalogEntry[]> {
    const url = path.startsWith('/') ? `file://${path}` : path;
    try {
      return parseVoicesJsonl(await loadAssetAsText(url));
    } catch (e) {
      log.warn('Failed to load voices metadata; using voice ids:', e);
      return [];
    }
  }

  /**
   * Stop playback and abort synthesis. The synchronous part (generation
   * bump, native cancel, stop signal, session cancel) runs before the
   * first await, so callers that do not await still stop immediately.
   * Never rejects.
   */
  async stop(): Promise<void> {
    this.generation++;
    this.cancelIds(this.inflight);
    for (const resolve of this.stopResolvers) {
      resolve();
    }
    this.stopResolvers.clear();
    const session = this.activeStreamSession;
    this.activeStreamSession = null;
    neuralAudioPlayer.stop().catch(() => {});
    if (session) {
      await session.cancel().catch(() => {});
    }
  }

  /**
   * Release the native handle; the engine can be initialized again.
   * In-flight requests are cancelled; their late results are released.
   */
  async release(): Promise<ReleaseResult> {
    if (!this.isInitialized && !this.isLoading) {
      log.debug('Engine already released, skipping');
      return {success: true, partialRelease: false, errors: []};
    }
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

    log.info('Releasing engine resources...');
    const errors: ReleaseError[] = [];
    await this.stop();
    await this.activeRun?.catch(() => {});

    const handleId = this.handleId;
    this.resetState();
    try {
      await this.destroyHandle(handleId);
    } catch (e) {
      const err = toPhononError(e);
      if (err.code !== 'ERR_PHONON_NOT_INITIALIZED') {
        log.warn('Failed to destroy native handle:', e);
        errors.push({component: 'handle', error: err});
      }
    }

    return {
      success: errors.length === 0,
      partialRelease: errors.length > 0,
      errors,
    };
  }

  /**
   * Tear down. Waits for a running initialize() first (see `lifecycle`),
   * so its handle is destroyed rather than left live and replaced.
   */
  destroy(): Promise<void> {
    return this.serialized(() => this.teardown());
  }

  private async teardown(): Promise<void> {
    await this.stop();
    await this.activeRun?.catch(() => {});
    const handleId = this.handleId;
    this.resetState();
    if (handleId > 0) {
      try {
        await this.destroyHandle(handleId);
      } catch (e) {
        log.debug('destroy: native handle already gone:', e);
      }
    }
  }

  /**
   * Once broken, native destroy queues behind the hung job and never
   * settles, so it is fired and not awaited (also if the watchdog fires
   * mid-wait).
   */
  private async destroyHandle(handleId: number): Promise<void> {
    const destroyed = NativePhonon.destroy(handleId).then(() => false);
    if (brokenError) {
      destroyed.catch(() => {});
      return;
    }
    const broken = await Promise.race([
      destroyed,
      brokenSignal.then(() => true),
    ]);
    if (broken) {
      destroyed.catch(() => {});
      log.warn(`not waiting for destroy of handle ${handleId}: engine broken`);
    }
  }

  private resetState(): void {
    this.isInitialized = false;
    this.handleId = 0;
    this.loadResult = null;
    this.config = null;
    this.catalog = [];
    this.language = DEFAULT_LANGUAGE;
    this.initError = null;
  }
}

function raceWithStop<T>(
  promise: Promise<T>,
  stopSignal: Promise<null>,
): Promise<T | null> {
  return Promise.race([promise, stopSignal]);
}

/**
 * `firstChunk: 'clause'` for the non-stream path: split the first chunk
 * at its first clause boundary so audio starts sooner.
 */
function splitFirstClause(chunks: TextChunk[]): void {
  const first = chunks[0];
  if (!first) {
    return;
  }
  const end = findFirstClauseEnd(first.text);
  if (end <= 0 || first.text.slice(end).trim().length === 0) {
    return;
  }
  const head = first.text.slice(0, end);
  const tail = first.text.slice(end);
  chunks.splice(
    0,
    1,
    {
      text: head,
      startIndex: first.startIndex,
      endIndex: first.startIndex + head.length,
    },
    {
      text: tail,
      startIndex: first.startIndex + head.length,
      endIndex: first.endIndex,
    },
  );
}

/** @internal Test-only: clear the process-wide broken flag. */
export function __resetPhononBrokenStateForTests(): void {
  brokenError = null;
  brokenSignal = newBrokenSignal();
}
