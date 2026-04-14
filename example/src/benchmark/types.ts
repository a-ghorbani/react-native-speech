import type {
  TTSEngine,
  SynthesisOptions,
  ExecutionProviderPreset,
} from '@pocketpalai/react-native-speech';

export interface EngineTestConfig {
  engine: TTSEngine;
  label: string;
  variant?: string;
  getInitConfig: () => Record<string, any>;
  voiceId: string;
  speakOptions?: SynthesisOptions;
}

export interface BenchmarkConfig {
  engines: EngineTestConfig[];
  iterations: number;
  testPhrase: string;
  provider: ExecutionProviderPreset;
  /** Number of warm-up iterations to discard (default 1) */
  warmupIterations?: number;
}

export interface MemorySnapshot {
  nativeHeapMB: number;
  jsHeapUsedMB: number;
  totalMemoryMB: number;
  availableMemoryMB: number;
  timestamp: number;
}

export interface BenchmarkResult {
  engine: string;
  variant: string;
  iteration: number;
  isWarmup: boolean;
  initMs: number;
  ttfaMs: number;
  totalSpeakMs: number;
  releaseMs: number;
  memoryBaseline: MemorySnapshot;
  memoryPostInit: MemorySnapshot;
  memoryPostSpeak: MemorySnapshot;
  memoryPostRelease: MemorySnapshot;
  /** Peak native heap MB during init phase (from memory polling) */
  peakInitMemoryMB?: number;
  /** Peak native heap MB during speak phase (from memory polling) */
  peakSpeakMemoryMB?: number;
}

export interface PercentileStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
}

export interface BenchmarkSummary {
  engine: string;
  variant: string;
  iterations: BenchmarkResult[];
  warmupIterations: BenchmarkResult[];
  averages: {
    initMs: number;
    ttfaMs: number;
    totalSpeakMs: number;
    releaseMs: number;
    /** Memory added by model load (post_init - baseline) */
    modelMemoryMB: number;
    /** Additional memory during inference (post_speak - post_init) */
    inferMemoryMB: number;
    /** Memory freed after release (post_init - post_release) */
    memoryReleasedMB: number;
  };
  stats: {
    initMs: PercentileStats;
    ttfaMs: PercentileStats;
    totalSpeakMs: PercentileStats;
    releaseMs: PercentileStats;
    modelMemoryMB: PercentileStats;
    inferMemoryMB: PercentileStats;
    /** Average peak memory during init phase (from polling) */
    peakInitMemoryMB?: number;
    /** Average peak memory during speak phase (from polling) */
    peakSpeakMemoryMB?: number;
  };
}

export type BenchmarkPhase =
  | 'idle'
  | 'warmup'
  | 'baseline'
  | 'initializing'
  | 'speaking'
  | 'releasing'
  | 'complete';

export interface BenchmarkProgress {
  engine: string;
  variant: string;
  iteration: number;
  totalIterations: number;
  phase: BenchmarkPhase;
  engineIndex: number;
  totalEngines: number;
  isWarmup: boolean;
}
