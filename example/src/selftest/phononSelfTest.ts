/**
 * Phonon device self-test, for automated evidence runs (design §6, §8.3).
 *
 * Triggered by the deep link
 *   speechexample://selftest/phonon?runs=5&threads=4&spin=200
 * (or the PHONON button in the self-test panel). Follows the panel's
 * `[SelfTest] <name> PASS|FAIL <detail>` convention, emits every metric
 * as a `[BENCH]` line (native log, survives release builds), and writes
 * the evidence set into `Documents/phonon-evidence/<runId>/`:
 *   bench.jsonl     one JSON object per line (chunk metrics + results)
 *   selftest.json   summary (device, support, load, every scenario)
 *   sample.wav      S10 capture
 *   screenshots/    demo/benchmark/streaming PNGs (when the native
 *                   capture is available; `SCREENSHOT_READY` markers let a
 *                   host take its own with adb/simctl either way)
 * and ends with `[SelfTest] SELFTEST_DONE ...`.
 *
 * Query parameters (all optional):
 *   runs=5           S3 short speaks
 *   threads=0        PhononConfig.numThreads (Android)
 *   spin=<n>         PhononConfig.spinBudget (Android)
 *   unit=neuralEngine|cpu   PhononConfig.computeUnit (iOS)
 *   cycles=10        S8 init/release cycles
 *   scenarios=s1,s3,s6      subset (s1 and the init always run)
 *   runId=<id>       evidence folder name (default: timestamp)
 *   model=<path>     model folder to use instead of the model manager's
 *   download=1       download the default model if none is installed
 *   mirrorRepo=<org/name>, mirrorRev=<rev>   iOS Core ML mirror override
 *
 * On unsupported devices it records the support probe, the direct
 * `Speech.initialize({engine: PHONON})` rejection code,
 * `libraryLoaded:false`, an OS-native speak smoke, and exits.
 */

import {Platform} from 'react-native';
import Speech, {
  TTSEngine,
  PhononEngine,
  engineManager,
  type AudioBuffer,
  type PhononChunkMetrics,
  type PhononDiagnostics,
  type PhononLoadResult,
  type PhononSupportInfo,
} from '@pocketpalai/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {emitBenchmark} from '../benchmark/BenchmarkLogger';
import Benchmark from '../benchmark/NativeBenchmark';
import {phononModelManager} from '../utils/PhononModelManager';
import {saveChunksAsWav} from '../utils/wavWriter';
import {ChunkCollector, chunksStartedAfter} from '../utils/phononChunks';

export type SelfTestTab = 'demo' | 'streaming' | 'benchmark';

export const PHONON_SCENARIOS = [
  's1',
  's2',
  's3',
  's4',
  's5',
  's6',
  's7',
  's9',
  's10',
  's8',
  's12',
] as const;
export type PhononScenario = (typeof PHONON_SCENARIOS)[number];

export interface PhononSelfTestParams {
  runs: number;
  threads: number;
  spin?: number;
  computeUnit?: 'neuralEngine' | 'cpu';
  cycles: number;
  scenarios: ReadonlySet<PhononScenario>;
  runId: string;
  modelPath?: string;
  download: boolean;
  mirrorRepo?: string;
  mirrorRev?: string;
}

export interface SelfTestResult {
  name: string;
  pass: boolean;
  detail: string;
  data?: Record<string, unknown>;
}

export interface SelfTestSummary {
  runId: string;
  dir: string;
  passed: number;
  failed: number;
  supported: boolean;
  results: SelfTestResult[];
}

export interface SelfTestDeps {
  /** Switch the visible tab (for screenshots). */
  showTab?: (tab: SelfTestTab) => void;
  /** Delay implementation (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

const DEEP_LINK_SCHEME = 'speechexample:';

const SHORT_TEXT = 'The quick brown fox jumps over the lazy dog.';
const LONG_TEXT =
  'Phonon runs entirely on the device. ' +
  'Each sentence is synthesized while the previous one plays. ' +
  'That keeps the gaps between sentences short. ' +
  'The engine never sends audio through JavaScript. ' +
  'Buffers stay in native memory until they play. ' +
  'This is the last sentence of the long test.';
const STREAM_TEXT =
  'Sure, here is a quick overview of how the whole process works, step by step, so you can follow along. ' +
  'First you open the settings screen and pick a model that fits your device. ' +
  'Then you start a chat, type a question, and wait for the answer to stream in. ' +
  'The voice starts speaking before the answer is complete, which feels fast.';

const SPEAK_TIMEOUT_MS = 90_000;
const STOP_AT_MS = 1000;
const THRESHOLDS = {
  rtfMedian: 0.35,
  firstAudioMedianMs: 800,
  stopMs: 150,
  gapMs: 150,
  memGrowthMb: 40,
};

// ============================================================
// Pure helpers (unit-tested)
// ============================================================

function intParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null || value.trim() === '') {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Minimal query-string parser (URLSearchParams is incomplete in RN). */
function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of query.split('&')) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    out.set(decode(rawKey), decode(rawValue));
  }
  return out;
}

function defaultRunId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}

/**
 * Parse `speechexample://selftest/phonon?...`. Returns null for any other
 * URL, so App can ignore unrelated links.
 */
export function parseSelfTestUrl(
  url: string,
  now: Date = new Date(),
): PhononSelfTestParams | null {
  if (!url || !url.toLowerCase().startsWith(DEEP_LINK_SCHEME)) {
    return null;
  }
  const rest = url.slice(DEEP_LINK_SCHEME.length).replace(/^\/+/, '');
  const qIndex = rest.indexOf('?');
  const path = (qIndex < 0 ? rest : rest.slice(0, qIndex)).replace(/\/+$/, '');
  if (path.toLowerCase() !== 'selftest/phonon') {
    return null;
  }
  const q = parseQuery(qIndex < 0 ? '' : rest.slice(qIndex + 1));
  const get = (k: string) => q.get(k) ?? null;

  let scenarios: Set<PhononScenario> = new Set(PHONON_SCENARIOS);
  const list = get('scenarios');
  if (list) {
    const wanted = list
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter((s): s is PhononScenario =>
        (PHONON_SCENARIOS as readonly string[]).includes(s),
      );
    scenarios = new Set<PhononScenario>(['s1', 's2', ...wanted]);
  }

  const unit = get('unit');
  const spin = get('spin');
  const runId = (get('runId') ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  return {
    runs: intParam(get('runs'), 5, 1, 50),
    threads: intParam(get('threads'), 0, 0, 16),
    spin:
      spin === null || spin.trim() === ''
        ? undefined
        : intParam(spin, 0, 0, 1_000_000),
    computeUnit: unit === 'cpu' || unit === 'neuralEngine' ? unit : undefined,
    cycles: intParam(get('cycles'), 10, 1, 50),
    scenarios,
    runId: runId || defaultRunId(now),
    modelPath: get('model') || undefined,
    download: get('download') === '1' || get('download') === 'true',
    mirrorRepo: get('mirrorRepo') || undefined,
    mirrorRev: get('mirrorRev') || undefined,
  };
}

export interface Stats {
  n: number;
  min: number;
  max: number;
  median: number;
  p90: number;
}

export function summarize(values: readonly number[]): Stats | null {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) {
    return null;
  }
  const median =
    n % 2 === 0 ? (v[n / 2 - 1]! + v[n / 2]!) / 2 : v[Math.floor(n / 2)]!;
  return {
    n,
    min: v[0]!,
    max: v[n - 1]!,
    median,
    p90: v[Math.min(n - 1, Math.ceil(n * 0.9) - 1)]!,
  };
}

/** Gaps between consecutive chunks: next playStartTs − previous playEndTs. */
export function playbackGaps(
  metrics: readonly Pick<PhononChunkMetrics, 'playStartTs' | 'playEndTs'>[],
): number[] {
  const sorted = [...metrics].sort((a, b) => a.playStartTs - b.playStartTs);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i]!.playStartTs - sorted[i - 1]!.playEndTs);
  }
  return gaps;
}

/** Real-time factor: synthesis time over audio duration. */
export function realTimeFactor(totalMs: number, audioSec: number): number {
  return audioSec > 0 ? totalMs / (audioSec * 1000) : Number.NaN;
}

/** RMS of captured audio, to tell speech from silence. */
export function rms(chunks: readonly AudioBuffer[]): number {
  let sum = 0;
  let n = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.samples.length; i++) {
      const s = c.samples[i]!;
      sum += s * s;
    }
    n += c.samples.length;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

export function errorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const code = (e as {code?: unknown}).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return 'none';
}

// ============================================================
// Runtime helpers
// ============================================================

function realSleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

let sleepImpl: (ms: number) => Promise<void> = realSleep;

function wait(ms: number): Promise<void> {
  return sleepImpl(ms);
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Writes the evidence folder; every write is best effort. */
class Evidence {
  readonly dir: string;
  private benchLines: string[] = [];

  constructor(runId: string) {
    this.dir = `${RNFS.DocumentDirectoryPath}/phonon-evidence/${runId}`;
  }

  async init(): Promise<void> {
    try {
      await RNFS.mkdir(`${this.dir}/screenshots`);
      await RNFS.writeFile(`${this.dir}/bench.jsonl`, '', 'utf8');
    } catch (e) {
      console.warn('[SelfTest] evidence dir failed:', e);
    }
  }

  /** One bench.jsonl line plus a native `[BENCH]` marker. */
  async bench(event: string, data: Record<string, unknown>): Promise<void> {
    emitBenchmark(event, data);
    const line = JSON.stringify({event, timestamp: Date.now(), ...data});
    this.benchLines.push(line);
    try {
      await RNFS.appendFile(`${this.dir}/bench.jsonl`, `${line}\n`, 'utf8');
    } catch {
      // Logged natively already.
    }
  }

  async json(name: string, data: unknown): Promise<void> {
    try {
      await RNFS.writeFile(
        `${this.dir}/${name}`,
        JSON.stringify(data, null, 2),
        'utf8',
      );
    } catch (e) {
      console.warn(`[SelfTest] writing ${name} failed:`, e);
    }
  }
}

function report(
  results: SelfTestResult[],
  name: string,
  pass: boolean,
  detail: string,
  data?: Record<string, unknown>,
): SelfTestResult {
  console.log(`[SelfTest] ${name} ${pass ? 'PASS' : 'FAIL'} ${detail}`);
  const result = {name, pass, detail, data};
  results.push(result);
  return result;
}

function phononEngine(): PhononEngine | null {
  try {
    return engineManager.getEngine(TTSEngine.PHONON) as unknown as PhononEngine;
  } catch {
    return null;
  }
}

/** Speak and time first audio (speak call → native onStart). */
async function timedSpeak(
  text: string,
  voiceId?: string,
  options?: Parameters<typeof Speech.speak>[2],
): Promise<{firstAudioMs: number; totalMs: number}> {
  const t0 = Date.now();
  let firstAudioMs = -1;
  const sub = Speech.onStart(() => {
    if (firstAudioMs < 0) {
      firstAudioMs = Date.now() - t0;
    }
  });
  try {
    await withTimeout(
      Speech.speak(text, voiceId, options),
      SPEAK_TIMEOUT_MS,
      'speak',
    );
  } finally {
    sub.remove();
  }
  return {firstAudioMs, totalMs: Date.now() - t0};
}

async function diagnostics(): Promise<PhononDiagnostics | null> {
  return PhononEngine.getDiagnostics();
}

let running = false;

/** Engines around a self-test run, for views that track their own engine. */
export interface SelfTestDoneEvent {
  /** `Speech.getCurrentEngine()` when the run started */
  engineBefore: TTSEngine;
  /** `Speech.getCurrentEngine()` when it ended (Phonon stays loaded) */
  engineAfter: TTSEngine;
}

const doneListeners = new Set<(e: SelfTestDoneEvent) => void>();

/**
 * Called after every self-test run (deep link or panel). The run drives
 * `Speech` directly, so a view holding its own selected/initialized
 * engine re-initializes from this (RootView does).
 */
export function onPhononSelfTestDone(
  listener: (e: SelfTestDoneEvent) => void,
): () => void {
  doneListeners.add(listener);
  return () => {
    doneListeners.delete(listener);
  };
}

/** True while a self-test runs (App ignores a second deep link). */
export function isPhononSelfTestRunning(): boolean {
  return running;
}

// ============================================================
// Runner
// ============================================================

export async function runPhononSelfTest(
  params: PhononSelfTestParams,
  deps: SelfTestDeps = {},
): Promise<SelfTestSummary> {
  if (running) {
    throw new Error('Phonon self-test already running');
  }
  running = true;
  const engineBefore = Speech.getCurrentEngine();
  sleepImpl = deps.sleep ?? realSleep;
  const results: SelfTestResult[] = [];
  const evidence = new Evidence(params.runId);
  const startedAt = new Date().toISOString();
  let support: PhononSupportInfo | null = null;
  let load: PhononLoadResult | null = null;

  const screenshot = async (name: SelfTestTab) => {
    deps.showTab?.(name);
    await wait(1200);
    const file = `${evidence.dir}/screenshots/${name}.png`;
    let saved = 'none';
    try {
      if (typeof Benchmark.captureScreen === 'function') {
        saved = await Benchmark.captureScreen(file);
      }
    } catch (e) {
      console.warn(`[SelfTest] captureScreen(${name}) failed:`, e);
    }
    // Hosts that take their own screenshot wait for this marker.
    console.log(`[SelfTest] SCREENSHOT_READY name=${name} file=${saved}`);
    await evidence.bench('SCREENSHOT_READY', {name, file: saved});
    await wait(1500);
  };

  const has = (s: PhononScenario) => params.scenarios.has(s);

  try {
    await evidence.init();
    console.log(
      `[SelfTest] START phonon runId=${params.runId} dir=${evidence.dir}`,
    );
    await evidence.bench('SELFTEST_START', {
      runId: params.runId,
      platform: Platform.OS,
      params: {...params, scenarios: [...params.scenarios]},
    });

    // ---- S1 support ----
    support = await PhononEngine.getSupport();
    const engineSupport = await Speech.getEngineSupport(TTSEngine.PHONON);
    report(
      results,
      'S1_support',
      true,
      `supported=${support.supported} reason=${support.reason} abi=${support.abi} pageSize=${support.pageSize}`,
      {support, engineSupport},
    );
    await evidence.bench('PHONON_SUPPORT', {...support});

    if (!support.supported) {
      await runUnsupported(results, evidence, support);
      await screenshot('demo');
      await screenshot('benchmark');
      deps.showTab?.('demo');
      return await finish();
    }

    // ---- model ----
    if (params.mirrorRepo || params.mirrorRev) {
      phononModelManager.setIosMirror({
        ...(params.mirrorRepo ? {repo: params.mirrorRepo} : {}),
        ...(params.mirrorRev ? {revision: params.mirrorRev} : {}),
      });
    }
    let modelPath = params.modelPath;
    let voicesMetadataPath: string | undefined;
    if (!modelPath) {
      await phononModelManager.scanInstalledModel();
      if (!phononModelManager.getInstalledModel() && params.download) {
        console.log('[SelfTest] downloading Phonon model...');
        await phononModelManager.downloadModel('31m-en');
      }
      if (phononModelManager.getInstalledModel()) {
        const cfg = phononModelManager.getDownloadedModelConfig();
        modelPath = cfg.modelPath;
        voicesMetadataPath = cfg.voicesMetadataPath;
      }
    }
    if (!modelPath) {
      report(
        results,
        'S2_init',
        false,
        'no Phonon model installed (pass download=1 or model=<path>)',
      );
      return await finish();
    }

    const initConfig: Parameters<typeof Speech.initialize>[0] = {
      engine: TTSEngine.PHONON,
      modelPath,
      voicesMetadataPath,
      language: 'en',
      numThreads: params.threads,
      spinBudget: params.spin,
      computeUnit: params.computeUnit,
      silentMode: 'obey',
      ducking: false,
    };

    // ---- S2 init ----
    const needsCompile = await PhononEngine.needsCompile(modelPath);
    await Speech.release().catch(() => undefined);
    const diagBefore = await diagnostics();
    const initStart = Date.now();
    try {
      await Speech.initialize(initConfig);
      load = phononEngine()?.getLoadInfo() ?? null;
      const diagAfter = await diagnostics();
      report(
        results,
        'S2_init',
        !!load && load.handleId > 0,
        `initMs=${Date.now() - initStart} loadMs=${load?.loadMs} compiled=${load?.compiled} ` +
          `threads=${load?.numThreads} unit=${load?.computeUnit} voices=${load?.voices.length} ` +
          `default=${JSON.stringify(load?.defaultVoice)}`,
        {
          initMs: Date.now() - initStart,
          needsCompile,
          load,
          diagBefore,
          diagAfter,
        },
      );
      await evidence.bench('PHONON_INIT', {
        initMs: Date.now() - initStart,
        needsCompile,
        ...load,
      });
    } catch (e) {
      report(
        results,
        'S2_init',
        false,
        `initialize rejected code=${errorCode(e)} ${String(e)}`,
      );
      return await finish();
    }

    await screenshot('demo');

    const collector = new ChunkCollector(m => {
      evidence.bench('PHONON_CHUNK', {...m});
    });
    const voices = load?.voices ?? [];

    // ---- S3 short speak × runs ----
    if (has('s3')) {
      const runs: Array<Record<string, number>> = [];
      let ok = true;
      for (let i = 0; i < params.runs; i++) {
        collector.start();
        try {
          const t = await timedSpeak(SHORT_TEXT);
          const chunks = collector.flush();
          const c = chunks[0];
          const run = {
            run: i + 1,
            firstAudioMs: t.firstAudioMs,
            speakMs: t.totalMs,
            ttfaMs: c?.ttfaMs ?? -1,
            totalMs: c?.totalMs ?? -1,
            queuedMs: c?.queuedMs ?? -1,
            samples: chunks.reduce((a, m) => a + m.samples, 0),
            audioSec: r2(chunks.reduce((a, m) => a + m.audioSec, 0)),
            rtf: c ? r2(realTimeFactor(c.totalMs, c.audioSec)) : -1,
          };
          runs.push(run);
          ok = ok && run.samples > 0 && run.firstAudioMs >= 0;
          await evidence.bench('PHONON_S3_RUN', run);
        } catch (e) {
          collector.flush();
          ok = false;
          runs.push({run: i + 1, error: 1});
          console.warn(`[SelfTest] S3 run ${i + 1} failed:`, e);
        }
        await wait(300);
      }
      const firstAudio = summarize(runs.map(r => r.firstAudioMs ?? NaN));
      const rtf = summarize(runs.map(r => r.rtf ?? NaN));
      report(
        results,
        'S3_short_speak',
        ok,
        `runs=${runs.length} firstAudio.median=${firstAudio?.median} p90=${firstAudio?.p90} ` +
          `rtf.median=${rtf?.median}`,
        {
          runs,
          firstAudioMs: firstAudio,
          ttfaMs: summarize(runs.map(r => r.ttfaMs ?? NaN)),
          totalMs: summarize(runs.map(r => r.totalMs ?? NaN)),
          queuedMs: summarize(runs.map(r => r.queuedMs ?? NaN)),
          rtf,
          withinThresholds:
            !!firstAudio &&
            !!rtf &&
            firstAudio.median <= THRESHOLDS.firstAudioMedianMs &&
            rtf.median <= THRESHOLDS.rtfMedian,
        },
      );
    }

    // ---- S4 long speak ----
    if (has('s4')) {
      collector.start();
      const progress: number[] = [];
      const unsub = Speech.onChunkProgress(e => progress.push(e.chunkIndex));
      try {
        const t = await timedSpeak(LONG_TEXT);
        const chunks = collector.flush();
        const gaps = playbackGaps(chunks);
        const inOrder = progress.every(
          (v, i) => i === 0 || v > progress[i - 1]!,
        );
        const maxGap = gaps.length ? Math.max(...gaps) : 0;
        report(
          results,
          'S4_long_speak',
          chunks.length > 0 && inOrder,
          `chunks=${chunks.length} inOrder=${inOrder} maxGapMs=${maxGap} firstAudioMs=${t.firstAudioMs}`,
          {
            chunks: chunks.length,
            progress,
            gapsMs: gaps,
            maxGapMs: maxGap,
            firstAudioMs: t.firstAudioMs,
            withinThresholds: maxGap <= THRESHOLDS.gapMs,
          },
        );
      } catch (e) {
        collector.flush();
        report(results, 'S4_long_speak', false, `threw ${String(e)}`);
      } finally {
        unsub();
      }
    }

    // ---- S5 stream (30 tok/s simulated LLM) ----
    if (has('s5')) {
      for (const firstChunk of ['clause', 'sentence'] as const) {
        collector.start();
        try {
          const stream = Speech.createSpeechStream(undefined, {firstChunk});
          const t0 = Date.now();
          let firstAudioMs = -1;
          const sub = Speech.onStart(() => {
            if (firstAudioMs < 0) {
              firstAudioMs = Date.now() - t0;
            }
          });
          const text = STREAM_TEXT.slice(0, 400);
          for (const tok of text.match(/\S+\s*/g) ?? []) {
            stream.append(tok);
            await wait(1000 / 30);
          }
          await withTimeout(stream.finalize(), SPEAK_TIMEOUT_MS, 'finalize');
          sub.remove();
          const chunks = collector.flush();
          const gaps = playbackGaps(chunks);
          const maxGap = gaps.length ? Math.max(...gaps) : 0;
          report(
            results,
            `S5_stream_${firstChunk}`,
            chunks.length > 0 && firstAudioMs >= 0,
            `chunks=${chunks.length} firstAudioMs=${firstAudioMs} maxGapMs=${maxGap}`,
            {
              firstChunk,
              chars: text.length,
              firstAudioMs,
              gapsMs: gaps,
              maxGapMs: maxGap,
              withinThresholds: maxGap <= THRESHOLDS.gapMs,
            },
          );
        } catch (e) {
          collector.flush();
          report(
            results,
            `S5_stream_${firstChunk}`,
            false,
            `threw ${String(e)}`,
          );
        }
        await wait(500);
      }
    }

    // ---- S6 stop at t=1.0 s ----
    if (has('s6')) {
      await runStop(results, evidence, collector);
    }

    // ---- S7 voice switch ----
    if (has('s7')) {
      const picks = voices.slice(0, 3);
      if (picks.length < 2) {
        report(
          results,
          'S7_voice_switch',
          true,
          `skipped: ${picks.length} voice(s) installed`,
        );
      } else {
        const order = [picks[0]!, picks[0]!, ...picks.slice(1)];
        const rows: Array<Record<string, unknown>> = [];
        try {
          for (const voice of order) {
            collector.start();
            await timedSpeak(SHORT_TEXT, voice);
            const c = collector.flush()[0];
            rows.push({
              voice,
              ttfaMs: c?.ttfaMs ?? -1,
              voiceChanged: c?.voiceChanged ?? false,
            });
            await evidence.bench('PHONON_S7', rows[rows.length - 1]!);
          }
          const same = rows[1]?.ttfaMs as number;
          const switches = rows.slice(2);
          const ok =
            rows[1]?.voiceChanged === false &&
            switches.every(r => r.voiceChanged === true);
          report(
            results,
            'S7_voice_switch',
            ok,
            `voices=${order.join(',')} switchCostMs=${switches
              .map(r => (r.ttfaMs as number) - same)
              .join(',')}`,
            {rows},
          );
        } catch (e) {
          collector.flush();
          report(results, 'S7_voice_switch', false, `threw ${String(e)}`);
        }
      }
    }

    // ---- S9 pause / resume ----
    if (has('s9')) {
      try {
        const speaking = Speech.speak(LONG_TEXT);
        await wait(1500);
        const paused = await Speech.pause();
        await wait(600);
        const resumed = await Speech.resume();
        await withTimeout(speaking, SPEAK_TIMEOUT_MS, 'speak');
        report(
          results,
          'S9_pause_resume',
          paused && resumed,
          `pause=${paused} resume=${resumed}`,
        );
      } catch (e) {
        await Speech.stop().catch(() => undefined);
        report(results, 'S9_pause_resume', false, `threw ${String(e)}`);
      }
    }

    // ---- S10 audio capture ----
    if (has('s10')) {
      const captured: AudioBuffer[] = [];
      try {
        await withTimeout(
          Speech.speak(SHORT_TEXT, undefined, {
            onAudioChunk: buf => {
              captured.push({
                samples: new Float32Array(buf.samples),
                sampleRate: buf.sampleRate,
                channels: buf.channels,
                duration: buf.duration,
              });
            },
          }),
          SPEAK_TIMEOUT_MS,
          'speak',
        );
        const level = rms(captured);
        const saved = await saveChunksAsWav(
          captured,
          `phonon-evidence/${params.runId}/sample.wav`,
        );
        // ±30 % around a speaking-rate estimate (~2.7 words/s).
        const expectedSec = SHORT_TEXT.split(/\s+/).length / 2.7;
        const durationOk =
          saved.durationSec >= expectedSec * 0.7 &&
          saved.durationSec <= expectedSec * 1.3;
        report(
          results,
          'S10_capture',
          level > 1e-3 && durationOk,
          `rms=${level.toFixed(4)} durationSec=${saved.durationSec.toFixed(2)} ` +
            `expectedSec=${expectedSec.toFixed(2)} file=${saved.path}`,
          {rms: level, ...saved, expectedSec, durationOk},
        );
      } catch (e) {
        report(results, 'S10_capture', false, `threw ${String(e)}`);
      }
    }

    // ---- S8 init/release cycles ----
    if (has('s8')) {
      await runInitRelease(results, evidence, initConfig, params.cycles);
    }

    // ---- S12 peak memory ----
    if (has('s12')) {
      const d = await diagnostics();
      report(
        results,
        'S12_peak_memory',
        !!d,
        `peakMemKb=${d?.peakMemKb} memKb=${d?.memKb} threads=${d?.threads}`,
        {diagnostics: d},
      );
    }

    if (params.scenarios.size > 2) {
      await screenshot('streaming');
      await screenshot('benchmark');
    }
    deps.showTab?.('demo');
    return await finish();
  } catch (e) {
    report(results, 'selftest', false, `threw ${String(e)}`);
    return await finish();
  } finally {
    running = false;
    sleepImpl = realSleep;
    const done: SelfTestDoneEvent = {
      engineBefore,
      engineAfter: Speech.getCurrentEngine(),
    };
    doneListeners.forEach(l => {
      try {
        l(done);
      } catch (e) {
        console.warn('[SelfTest] done listener threw:', e);
      }
    });
  }

  async function finish(): Promise<SelfTestSummary> {
    const failed = results.filter(r => !r.pass).length;
    const summary: SelfTestSummary = {
      runId: params.runId,
      dir: evidence.dir,
      passed: results.length - failed,
      failed,
      supported: support?.supported === true,
      results,
    };
    const constants = (Platform.constants ?? {}) as Record<string, unknown>;
    await evidence.json('selftest.json', {
      runId: params.runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      platform: Platform.OS,
      osVersion: String(Platform.Version),
      device: {
        model: constants.Model ?? null,
        brand: constants.Brand ?? null,
        manufacturer: constants.Manufacturer ?? null,
      },
      params: {...params, scenarios: [...params.scenarios]},
      support,
      load,
      passed: summary.passed,
      failed,
      results,
    });
    await evidence.bench('SELFTEST_DONE', {
      runId: params.runId,
      passed: summary.passed,
      failed,
    });
    console.log(
      `[SelfTest] SELFTEST_DONE passed=${summary.passed} failed=${failed} dir=${evidence.dir}`,
    );
    return summary;
  }
}

/** U1/U2/U3/F1: the engine must stay hidden and inert. */
async function runUnsupported(
  results: SelfTestResult[],
  evidence: Evidence,
  support: PhononSupportInfo,
): Promise<void> {
  const before = Speech.getCurrentEngine();
  let code = 'none';
  try {
    await Speech.initialize({
      engine: TTSEngine.PHONON,
      modelPath: phononModelManager.getVariantDirectory(),
    });
  } catch (e) {
    code = errorCode(e);
  }
  const after = Speech.getCurrentEngine();
  report(
    results,
    'U_direct_init',
    code === 'ERR_PHONON_UNSUPPORTED' && after === before,
    `code=${code} currentEngine ${before}->${after}`,
    {code, before, after},
  );

  const d = await diagnostics();
  report(
    results,
    'U_library_not_loaded',
    !!d && d.libraryLoaded === false,
    `libraryLoaded=${d?.libraryLoaded}`,
    {diagnostics: d},
  );

  try {
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
    await withTimeout(
      Speech.speak('Self test. The system voice still works.'),
      30_000,
      'os speak',
    );
    report(results, 'U_os_native_speak', true, 'ok');
  } catch (e) {
    report(results, 'U_os_native_speak', false, `threw ${String(e)}`);
  }
  await evidence.bench('PHONON_UNSUPPORTED', {
    reason: support.reason,
    detail: support.detail,
    initCode: code,
    libraryLoaded: d?.libraryLoaded ?? null,
  });
}

/**
 * S6: stop 1.0 s after speak; nothing plays afterwards; buffers freed.
 * Judged by the engine's own playback timestamps (`playStartTs` of every
 * chunk of the stopped call): a JS `onStart` emitted before stop() can be
 * delivered after it, so the `onStart` count is recorded but not judged.
 */
async function runStop(
  results: SelfTestResult[],
  evidence: Evidence,
  collector: ChunkCollector,
): Promise<void> {
  const starts: number[] = [];
  let stoppedAt = -1;
  const startSub = Speech.onStart(() => {
    starts.push(Date.now());
  });
  const stoppedSub = Speech.onStopped(() => {
    if (stoppedAt < 0) {
      stoppedAt = Date.now();
    }
  });
  collector.start();
  try {
    const speakStart = Date.now();
    const speaking = Speech.speak(`${LONG_TEXT} ${LONG_TEXT}`).catch(
      () => undefined,
    );
    await wait(STOP_AT_MS);
    const jsStartedBeforeStop = starts.length > 0;
    const stopAt = Date.now();
    await Speech.stop();
    const stopCallMs = Date.now() - stopAt;
    await withTimeout(speaking, 10_000, 'speak after stop');
    await wait(1000);
    const chunks = collector.flush();
    const stopMs = stoppedAt >= 0 ? stoppedAt - stopAt : -1;
    const jsStartsAfter = starts.filter(t => t > stopAt).length;
    const lateChunks = chunksStartedAfter(chunks, stopAt);
    const nativeStartedBeforeStop = chunks.some(c => c.playStartTs <= stopAt);
    const audioStarted = jsStartedBeforeStop || nativeStartedBeforeStop;
    const d = await diagnostics();
    const liveBuffers = d?.liveBuffers ?? -1;

    // Next speak works.
    let nextOk = false;
    try {
      const t = await timedSpeak(SHORT_TEXT);
      nextOk = t.firstAudioMs >= 0;
    } catch {
      nextOk = false;
    }
    const data = {
      speakToStopMs: stopAt - speakStart,
      audioStartedBeforeStop: audioStarted,
      jsStartedBeforeStop,
      nativeStartedBeforeStop,
      stopCallMs,
      stopToStoppedMs: stopMs,
      // JS delivery time; informational (see above).
      onStartAfterStop: jsStartsAfter,
      // Native: chunks whose playback was requested after stop().
      chunksPlayedAfterStop: lateChunks.length,
      lateChunks: lateChunks.map(c => ({
        requestId: c.requestId,
        playStartAfterStopMs: c.playStartTs - stopAt,
        playMs: c.playEndTs - c.playStartTs,
      })),
      chunks: chunks.length,
      liveBuffers,
      orphanBuffers: d?.orphanBuffers ?? -1,
      nextSpeakOk: nextOk,
      withinThresholds: stopMs >= 0 && stopMs <= THRESHOLDS.stopMs,
    };
    await evidence.bench('PHONON_S6', data);
    // onStopped is only meaningful when audio was playing at stop time.
    const stoppedOk = !audioStarted || stopMs >= 0;
    report(
      results,
      'S6_stop',
      stoppedOk && lateChunks.length === 0 && liveBuffers === 0 && nextOk,
      `stopToStoppedMs=${stopMs} chunksPlayedAfterStop=${lateChunks.length} ` +
        `onStartAfterStop=${jsStartsAfter} liveBuffers=${liveBuffers} next=${nextOk}`,
      data,
    );
  } catch (e) {
    collector.flush();
    report(results, 'S6_stop', false, `threw ${String(e)}`);
  } finally {
    startSub.remove();
    stoppedSub.remove();
  }
}

/** S8: memory and thread count stay bounded over init/release cycles. */
async function runInitRelease(
  results: SelfTestResult[],
  evidence: Evidence,
  initConfig: Parameters<typeof Speech.initialize>[0],
  cycles: number,
): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  try {
    await Speech.release();
    const first = await diagnostics();
    let afterFirstInitThreads = -1;
    for (let i = 0; i < cycles; i++) {
      await Speech.initialize(initConfig);
      await timedSpeak('Cycle check.');
      const mid = await diagnostics();
      if (i === 0) {
        afterFirstInitThreads = mid?.threads ?? -1;
      }
      await Speech.release();
      const after = await diagnostics();
      const row = {
        cycle: i + 1,
        memKbLoaded: mid?.memKb,
        threadsLoaded: mid?.threads,
        memKbReleased: after?.memKb,
        threadsReleased: after?.threads,
        liveBuffers: after?.liveBuffers,
      };
      rows.push(row);
      await evidence.bench('PHONON_S8', row);
    }
    const last = await diagnostics();
    const growthMb = ((last?.memKb ?? 0) - (first?.memKb ?? 0)) / 1024;
    // A couple of short-lived platform threads come and go.
    const threadsFlat = rows.every(
      r => Math.abs((r.threadsLoaded as number) - afterFirstInitThreads) <= 2,
    );
    const ok =
      growthMb <= THRESHOLDS.memGrowthMb &&
      threadsFlat &&
      (last?.liveBuffers ?? 0) === 0;
    report(
      results,
      'S8_init_release',
      ok,
      `cycles=${cycles} memGrowthMb=${growthMb.toFixed(1)} threadsFlat=${threadsFlat} liveBuffers=${last?.liveBuffers}`,
      {rows, memGrowthMb: growthMb, threadsFlat, first, last},
    );
  } catch (e) {
    report(results, 'S8_init_release', false, `threw ${String(e)}`);
  } finally {
    // Leave the engine loaded for whoever uses the app next.
    await Speech.initialize(initConfig).catch(() => undefined);
  }
}
