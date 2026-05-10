/**
 * Benchmark Runner
 *
 * Orchestrates engine lifecycle benchmarks:
 * - Cycles through configured engines and iterations
 * - Supports warm-up iterations (discarded from stats)
 * - Records timing (init, TTFA, total synthesis, release)
 * - Captures memory snapshots via native getMemoryStats()
 * - Tracks peak memory via high-frequency native polling
 * - Emits native os_signpost/Trace markers for Instruments/Perfetto
 * - Emits structured [BENCH] log markers for external collection
 * - Computes percentile statistics (min, max, median, p90)
 */

import {Platform} from 'react-native';
import Speech, {type TTSEngine} from '@pocketpalai/react-native-speech';
import Benchmark from './NativeBenchmark';
import {emitBenchmark, generateRunId} from './BenchmarkLogger';
import type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkSummary,
  BenchmarkProgress,
  MemorySnapshot,
  PercentileStats,
} from './types';

type ProgressCallback = (progress: BenchmarkProgress) => void;

const MEMORY_POLL_INTERVAL_MS = 100;

/**
 * Get JS heap stats from Hermes runtime (if available)
 */
function getJSHeapMB(): number {
  try {
    const hermes = (global as any).HermesInternal;
    if (hermes && typeof hermes.getRuntimeProperties === 'function') {
      const props = hermes.getRuntimeProperties();
      const heapSize =
        props.js_heapSize ||
        props['Heap size'] ||
        props['Allocated bytes'] ||
        0;
      return Number(heapSize) / (1024 * 1024);
    }
  } catch {
    // Hermes not available
  }
  return 0;
}

/**
 * Take a memory snapshot combining native and JS heap data
 */
async function takeMemorySnapshot(): Promise<MemorySnapshot> {
  try {
    const native = await Benchmark.getMemoryStats();
    return {
      nativeHeapMB: native.nativeHeapAllocatedMB,
      jsHeapUsedMB: getJSHeapMB(),
      totalMemoryMB: native.totalMemoryMB,
      availableMemoryMB: native.availableMemoryMB,
      timestamp: Date.now(),
    };
  } catch {
    return {
      nativeHeapMB: 0,
      jsHeapUsedMB: getJSHeapMB(),
      totalMemoryMB: 0,
      availableMemoryMB: 0,
      timestamp: Date.now(),
    };
  }
}

/**
 * Wait for a specified duration
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Compute percentile statistics from a list of values
 */
function computePercentiles(values: number[]): PercentileStats {
  if (values.length === 0) {
    return {min: 0, max: 0, mean: 0, median: 0, p90: 0};
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const median =
    n % 2 === 0
      ? Math.round((sorted[n / 2 - 1]! + sorted[n / 2]!) / 2)
      : sorted[Math.floor(n / 2)]!;
  const p90Index = Math.min(Math.ceil(n * 0.9) - 1, n - 1);

  return {
    min: Math.round(sorted[0]!),
    max: Math.round(sorted[n - 1]!),
    mean: Math.round(sum / n),
    median,
    p90: Math.round(sorted[p90Index]!),
  };
}

/**
 * Round to one decimal place
 */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Run a full benchmark suite
 */
export async function runBenchmark(
  config: BenchmarkConfig,
  onProgress: ProgressCallback,
): Promise<BenchmarkSummary[]> {
  const runId = generateRunId();
  const warmupCount = config.warmupIterations ?? 1;
  const totalRuns = warmupCount + config.iterations;
  const allResults: Map<string, BenchmarkResult[]> = new Map();

  // Clear any markers from previous runs (used for file-based collection on iOS devices)
  Benchmark.clearMarkers();

  emitBenchmark('SUITE_START', {
    runId,
    platform: Platform.OS,
    engines: config.engines.map(e => ({
      engine: e.engine,
      label: e.label,
      variant: e.variant,
    })),
    iterations: config.iterations,
    warmupIterations: warmupCount,
    textLength: config.testPhrase.length,
    provider: config.providerLabel,
    providers: config.providers,
  });

  for (let ei = 0; ei < config.engines.length; ei++) {
    const engineConfig = config.engines[ei]!;
    const engineKey = `${engineConfig.engine}:${engineConfig.variant || 'default'}`;
    const traceTag = engineConfig.variant
      ? `${engineConfig.engine}:${engineConfig.variant}`
      : engineConfig.engine;

    if (!allResults.has(engineKey)) {
      allResults.set(engineKey, []);
    }

    for (let run = 1; run <= totalRuns; run++) {
      const isWarmup = run <= warmupCount;
      const displayIter = isWarmup ? run : run - warmupCount;

      onProgress({
        engine: engineConfig.label,
        variant: engineConfig.variant || '',
        iteration: displayIter,
        totalIterations: isWarmup ? warmupCount : config.iterations,
        phase: isWarmup ? 'warmup' : 'baseline',
        engineIndex: ei + 1,
        totalEngines: config.engines.length,
        isWarmup,
      });

      emitBenchmark('RUN_START', {
        runId,
        engine: engineConfig.engine,
        variant: engineConfig.variant,
        iteration: run,
        isWarmup,
      });

      // Baseline memory (before anything loads)
      const memBaseline = await takeMemorySnapshot();
      emitBenchmark('MEMORY', {
        runId,
        phase: 'baseline',
        engine: engineConfig.engine,
        ...memBaseline,
      });

      // --- INITIALIZE ---
      onProgress({
        engine: engineConfig.label,
        variant: engineConfig.variant || '',
        iteration: displayIter,
        totalIterations: isWarmup ? warmupCount : config.iterations,
        phase: 'initializing',
        engineIndex: ei + 1,
        totalEngines: config.engines.length,
        isWarmup,
      });

      // Start memory polling + native trace
      Benchmark.startMemoryPolling(MEMORY_POLL_INTERVAL_MS);
      Benchmark.beginTraceInterval(`init:${traceTag}`);

      emitBenchmark('INIT_START', {runId, engine: engineConfig.engine});
      const initStart = performance.now();

      const initConfig = engineConfig.getInitConfig();
      // Benchmark loop iterates engines dynamically; cast to the union once
      // the engine discriminant is bound at the outer scope.
      await Speech.initialize({
        engine: engineConfig.engine as TTSEngine,
        ...initConfig,
        silentMode: 'obey',
        ducking: false,
        executionProviders: config.providers,
      } as Parameters<typeof Speech.initialize>[0]);

      const initMs = performance.now() - initStart;

      Benchmark.endTraceInterval(`init:${traceTag}`);
      const initPeak = await Benchmark.stopMemoryPolling();

      emitBenchmark('INIT_END', {
        runId,
        engine: engineConfig.engine,
        durationMs: Math.round(initMs),
        peakNativeHeapMB: round1(initPeak.peakNativeHeapMB),
        memorySamples: initPeak.sampleCount,
      });

      // Resolve voice ID: use provided one, or auto-detect first available voice
      let voiceId = engineConfig.voiceId;
      if (!voiceId) {
        try {
          const voices = await Speech.getVoices();
          if (voices.length > 0) {
            voiceId = voices[0]!;
          }
        } catch {
          // Fall through with empty voiceId
        }
      }

      // Memory after init
      const memPostInit = await takeMemorySnapshot();
      emitBenchmark('MEMORY', {
        runId,
        phase: 'post_init',
        engine: engineConfig.engine,
        ...memPostInit,
      });

      // --- SPEAK (TTFA + total) ---
      onProgress({
        engine: engineConfig.label,
        variant: engineConfig.variant || '',
        iteration: displayIter,
        totalIterations: isWarmup ? warmupCount : config.iterations,
        phase: 'speaking',
        engineIndex: ei + 1,
        totalEngines: config.engines.length,
        isWarmup,
      });

      // Start memory polling + native trace for speak
      Benchmark.startMemoryPolling(MEMORY_POLL_INTERVAL_MS);
      Benchmark.beginTraceInterval(`speak:${traceTag}`);

      emitBenchmark('SPEAK_START', {
        runId,
        engine: engineConfig.engine,
        textLength: config.testPhrase.length,
      });

      const speakStart = performance.now();

      // Set up one-shot listeners for TTFA and completion
      const {ttfaMs, totalSpeakMs} = await new Promise<{
        ttfaMs: number;
        totalSpeakMs: number;
      }>((resolve, reject) => {
        let ttfa = -1;
        let startUnsub: {remove: () => void} | null = null;
        let finishUnsub: {remove: () => void} | null = null;
        let errorUnsub: {remove: () => void} | null = null;

        const cleanup = () => {
          startUnsub?.remove();
          finishUnsub?.remove();
          errorUnsub?.remove();
        };

        startUnsub = Speech.onStart(() => {
          ttfa = performance.now() - speakStart;
          emitBenchmark('AUDIO_START', {
            runId,
            engine: engineConfig.engine,
            ttfaMs: Math.round(ttfa),
          });
        });

        finishUnsub = Speech.onFinish(() => {
          const total = performance.now() - speakStart;
          cleanup();
          resolve({ttfaMs: ttfa, totalSpeakMs: total});
        });

        errorUnsub = Speech.onError(() => {
          cleanup();
          reject(
            new Error(
              `Speech error during benchmark of ${engineConfig.engine}`,
            ),
          );
        });

        // Fire speak
        Speech.speak(
          config.testPhrase,
          voiceId || undefined,
          engineConfig.speakOptions,
        ).catch(err => {
          cleanup();
          reject(err);
        });
      });

      Benchmark.endTraceInterval(`speak:${traceTag}`);
      const speakPeak = await Benchmark.stopMemoryPolling();

      emitBenchmark('SPEAK_END', {
        runId,
        engine: engineConfig.engine,
        ttfaMs: Math.round(ttfaMs),
        totalMs: Math.round(totalSpeakMs),
        peakNativeHeapMB: round1(speakPeak.peakNativeHeapMB),
        memorySamples: speakPeak.sampleCount,
      });

      // Memory after speak
      const memPostSpeak = await takeMemorySnapshot();
      emitBenchmark('MEMORY', {
        runId,
        phase: 'post_speak',
        engine: engineConfig.engine,
        ...memPostSpeak,
      });

      // --- RELEASE ---
      onProgress({
        engine: engineConfig.label,
        variant: engineConfig.variant || '',
        iteration: displayIter,
        totalIterations: isWarmup ? warmupCount : config.iterations,
        phase: 'releasing',
        engineIndex: ei + 1,
        totalEngines: config.engines.length,
        isWarmup,
      });

      Benchmark.beginTraceInterval(`release:${traceTag}`);
      emitBenchmark('RELEASE_START', {runId, engine: engineConfig.engine});
      const releaseStart = performance.now();
      await Speech.release();
      const releaseMs = performance.now() - releaseStart;
      Benchmark.endTraceInterval(`release:${traceTag}`);

      emitBenchmark('RELEASE_END', {
        runId,
        engine: engineConfig.engine,
        durationMs: Math.round(releaseMs),
      });

      // Memory after release
      const memPostRelease = await takeMemorySnapshot();
      emitBenchmark('MEMORY', {
        runId,
        phase: 'post_release',
        engine: engineConfig.engine,
        ...memPostRelease,
      });

      // Collect result
      const result: BenchmarkResult = {
        engine: engineConfig.engine,
        variant: engineConfig.variant || 'default',
        iteration: run,
        isWarmup,
        initMs: Math.round(initMs),
        ttfaMs: Math.round(ttfaMs),
        totalSpeakMs: Math.round(totalSpeakMs),
        releaseMs: Math.round(releaseMs),
        memoryBaseline: memBaseline,
        memoryPostInit: memPostInit,
        memoryPostSpeak: memPostSpeak,
        memoryPostRelease: memPostRelease,
        peakInitMemoryMB: round1(initPeak.peakNativeHeapMB),
        peakSpeakMemoryMB: round1(speakPeak.peakNativeHeapMB),
      };

      allResults.get(engineKey)!.push(result);

      emitBenchmark('RUN_END', {
        runId,
        ...result,
      });

      // Brief pause between iterations to let GC settle
      await delay(1000);
    }

    // Pause between engines
    await delay(2000);
  }

  // Build summaries
  const summaries: BenchmarkSummary[] = [];

  for (const [key, results] of allResults) {
    const [engine, variant] = key.split(':');

    const warmups = results.filter(r => r.isWarmup);
    const measured = results.filter(r => !r.isWarmup);

    // Averages (from measured results only)
    const avg = (fn: (r: BenchmarkResult) => number) => {
      if (measured.length === 0) return 0;
      const vals = measured.map(fn);
      return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    };

    const modelMemVals = measured.map(
      r => r.memoryPostInit.nativeHeapMB - r.memoryBaseline.nativeHeapMB,
    );
    const inferMemVals = measured.map(
      r => r.memoryPostSpeak.nativeHeapMB - r.memoryPostInit.nativeHeapMB,
    );

    const avgModelMemory =
      modelMemVals.length > 0
        ? modelMemVals.reduce((a, b) => a + b, 0) / modelMemVals.length
        : 0;
    const avgInferMemory =
      inferMemVals.length > 0
        ? inferMemVals.reduce((a, b) => a + b, 0) / inferMemVals.length
        : 0;
    const avgMemoryReleased = avg(
      r => r.memoryPostInit.nativeHeapMB - r.memoryPostRelease.nativeHeapMB,
    );

    // Peak memory averages (from polling)
    const initPeaks = measured
      .filter(r => r.peakInitMemoryMB != null)
      .map(r => r.peakInitMemoryMB!);
    const speakPeaks = measured
      .filter(r => r.peakSpeakMemoryMB != null)
      .map(r => r.peakSpeakMemoryMB!);
    const avgPeakInit =
      initPeaks.length > 0
        ? round1(initPeaks.reduce((a, b) => a + b, 0) / initPeaks.length)
        : undefined;
    const avgPeakSpeak =
      speakPeaks.length > 0
        ? round1(speakPeaks.reduce((a, b) => a + b, 0) / speakPeaks.length)
        : undefined;

    // Percentile stats (from measured results only)
    const stats = {
      initMs: computePercentiles(measured.map(r => r.initMs)),
      ttfaMs: computePercentiles(measured.map(r => r.ttfaMs)),
      totalSpeakMs: computePercentiles(measured.map(r => r.totalSpeakMs)),
      releaseMs: computePercentiles(measured.map(r => r.releaseMs)),
      modelMemoryMB: computePercentiles(modelMemVals),
      inferMemoryMB: computePercentiles(inferMemVals),
      peakInitMemoryMB: avgPeakInit,
      peakSpeakMemoryMB: avgPeakSpeak,
    };

    summaries.push({
      engine: engine!,
      variant: variant!,
      iterations: measured,
      warmupIterations: warmups,
      averages: {
        initMs: avg(r => r.initMs),
        ttfaMs: avg(r => r.ttfaMs),
        totalSpeakMs: avg(r => r.totalSpeakMs),
        releaseMs: avg(r => r.releaseMs),
        modelMemoryMB: round1(avgModelMemory),
        inferMemoryMB: round1(avgInferMemory),
        memoryReleasedMB: round1(avgMemoryReleased),
      },
      stats,
    });
  }

  emitBenchmark('SUITE_COMPLETE', {
    runId,
    summaries: summaries.map(s => ({
      engine: s.engine,
      variant: s.variant,
      averages: s.averages,
      stats: s.stats,
    })),
  });

  return summaries;
}
