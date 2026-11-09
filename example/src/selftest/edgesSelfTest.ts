/**
 * Playback-edges device suite (issue #45): resolve timing, stop, pause in
 * the tail, interruptions, route changes, mic reopen, fuzz and soak.
 *
 * Deep link:
 *   speechexample://selftest?suite=edges&engine=kitten&scenarios=stop,fuzz&seed=7
 *
 * Query parameters (all optional):
 *   engine=kitten|kokoro|supertonic|phonon|current   (default kitten)
 *   scenarios=cold,resolve,stop,pause_tail,interrupt,duck,route,mic,fuzz,soak
 *   seed=1  iterations=200  fuzzIter=<i> (replay one fuzz iteration)
 *   soak=500  runs=3  tolMs=50  settleTimeoutMs=20000  memGrowthMb=100
 *   reinit=1 (release + initialize the engine; 0 keeps an initialized one)
 *   download=1 (Kitten/Phonon: download the model when missing)
 *   variant=nano-int8 (Kitten)  accel=xnnpack|cpu  ducking=0  runId=<id>
 *
 * Logs `[SelfTest] <name> PASS|FAIL|SKIP <detail>`, one compact
 * `[SelfTest] EDGE {...}` line per run, and ends with
 * `[SelfTest] SELFTEST DONE suite=edges engine=<id> passed=N failed=N skipped=N`.
 * Full per-run JSON (every event timestamp, per-chunk PCM duration, output
 * latency) goes to edges-evidence/<runId>/runs.jsonl under the app's
 * external files dir (Android) or Documents (iOS).
 */
import {Platform, TurboModuleRegistry} from 'react-native';
import Speech, {
  TTSEngine,
  engineManager,
  onAudioInterruption,
  type EngineId,
  type ExecutionProvider,
} from '@pocketpalai/react-native-speech';
import {
  PhononEngine,
  PHONON,
  type PhononChunkMetrics,
} from '@pocketpalai/react-native-speech-phonon';
import * as RNFS from '@dr.pogodin/react-native-fs';
import Benchmark from '../benchmark/NativeBenchmark';
import {emitBenchmark} from '../benchmark/BenchmarkLogger';
import {
  kittenModelManager,
  type KittenVersion,
} from '../utils/KittenModelManager';
import {kokoroModelManager} from '../utils/ModelManager';
import {supertonicModelManager} from '../utils/SupertonicModelManager';
import {phononModelManager} from '../utils/PhononModelManager';
import {phonemizerDictManager} from '../utils/PhonemizerDictManager';
import {ChunkCollector} from '../utils/phononChunks';
import {
  emitSelfTestDone,
  intParam,
  parseQuery,
  type SelfTestTab,
} from './phononSelfTest';
import Probe, {
  type FocusProbeResult,
  type OutputInfo,
} from './NativePlaybackProbe';
import {isPlaybackTapInstalled, onPlayCall, type PlayCall} from './playbackTap';
import {
  checkEventOrder,
  classifyColdRun,
  formatOps,
  genFuzzOps,
  iterationSeed,
  median,
  randInt,
  seededRng,
  tailOffsetMs,
  trackPromise,
  unsettled,
  vmRssMb,
  type ColdRunShape,
  type FuzzOp,
  type Rng,
  type TimedEvent,
  type TrackedPromise,
} from './edgesCore';

export const EDGE_SCENARIOS = [
  'cold',
  'resolve',
  'stop',
  'pause_tail',
  'interrupt',
  'duck',
  'route',
  'mic',
  'fuzz',
  'soak',
] as const;
export type EdgeScenario = (typeof EDGE_SCENARIOS)[number];

type EdgeEngine = 'kitten' | 'kokoro' | 'supertonic' | 'phonon' | 'current';

export interface EdgesParams {
  engine: EdgeEngine;
  scenarios: ReadonlySet<EdgeScenario>;
  seed: number;
  iterations: number;
  fuzzIter?: number;
  soak: number;
  runs: number;
  tolMs: number;
  settleTimeoutMs: number;
  memGrowthMb: number;
  reinit: boolean;
  download: boolean;
  variant: KittenVersion;
  accel: 'xnnpack' | 'cpu';
  ducking: boolean;
  runId: string;
}

export type EdgeStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface EdgeResult {
  name: string;
  status: EdgeStatus;
  detail: string;
}

export interface EdgesSummary {
  engine: string;
  passed: number;
  failed: number;
  skipped: number;
  results: EdgeResult[];
  dir: string;
}

const SHORT = 'The quick brown fox jumps over the lazy dog.';
const PREVIEW =
  'Hello, this is a preview of the selected voice. It should sound clear and natural.';
const LONG =
  'Sure, here is a quick overview of how the whole process works. ' +
  'First you open the settings screen and pick a model. ' +
  'Then you start a chat and wait for the answer to stream in.';
const FUZZ_TEXTS = [SHORT, PREVIEW, LONG, 'Okay.'];
const SOAK_TEXTS = ['Okay.', 'Item ready.', 'Done.', 'Next one.', 'Got it.'];

const KITTEN_VARIANTS: readonly KittenVersion[] = [
  'micro',
  'nano-int8',
  'nano-fp32',
  'mini',
];

function boolParam(value: string | null, fallback: boolean): boolean {
  if (value === null || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/** `speechexample://selftest?suite=edges&...` or `speechexample://selftest/edges?...`. */
export function parseEdgesUrl(
  url: string,
  now: Date = new Date(),
): EdgesParams | null {
  if (!url || !url.toLowerCase().startsWith('speechexample:')) return null;
  const rest = url.slice('speechexample:'.length).replace(/^\/+/, '');
  const qIndex = rest.indexOf('?');
  const path = (qIndex < 0 ? rest : rest.slice(0, qIndex))
    .replace(/\/+$/, '')
    .toLowerCase();
  const q = parseQuery(qIndex < 0 ? '' : rest.slice(qIndex + 1));
  const get = (k: string) => q.get(k) ?? null;
  const isEdges =
    path === 'selftest/edges' ||
    (path === 'selftest' && get('suite')?.toLowerCase() === 'edges');
  if (!isEdges) return null;

  const list = get('scenarios');
  const scenarios = list
    ? new Set(
        list
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter((s): s is EdgeScenario =>
            (EDGE_SCENARIOS as readonly string[]).includes(s),
          ),
      )
    : new Set<EdgeScenario>(EDGE_SCENARIOS);
  const engine = (get('engine') ?? 'kitten').toLowerCase();
  const variant = get('variant') as KittenVersion | null;
  const fuzzIter = get('fuzzIter');
  return {
    engine: (['kitten', 'kokoro', 'supertonic', 'phonon', 'current'].includes(
      engine,
    )
      ? engine
      : 'kitten') as EdgeEngine,
    scenarios,
    seed: intParam(get('seed'), 1, 0, 2 ** 31 - 1),
    iterations: intParam(get('iterations'), 200, 1, 10_000),
    fuzzIter:
      fuzzIter === null || fuzzIter === ''
        ? undefined
        : intParam(fuzzIter, 0, 0, 1_000_000),
    soak: intParam(get('soak'), 500, 1, 5000),
    runs: intParam(get('runs'), 3, 1, 50),
    tolMs: intParam(get('tolMs'), 50, 0, 5000),
    settleTimeoutMs: intParam(get('settleTimeoutMs'), 20_000, 1000, 300_000),
    memGrowthMb: intParam(get('memGrowthMb'), 100, 1, 4096),
    reinit: boolParam(get('reinit'), true),
    download: boolParam(get('download'), false),
    variant:
      variant && KITTEN_VARIANTS.includes(variant) ? variant : 'nano-int8',
    accel: get('accel') === 'cpu' ? 'cpu' : 'xnnpack',
    ducking: boolParam(get('ducking'), false),
    runId:
      (get('runId') ?? '').replace(/[^A-Za-z0-9._-]/g, '') ||
      now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, ''),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}

interface RawAudio {
  isAudioPlaying?: () => Promise<boolean>;
}

async function isAudioPlaying(): Promise<boolean | null> {
  try {
    const mod = TurboModuleRegistry.get(
      'RNSpeech',
    ) as unknown as RawAudio | null;
    return mod?.isAudioPlaying ? await mod.isAudioPlaying() : null;
  } catch {
    return null;
  }
}

/** Polls native playing state until idle; false if it stays playing. */
async function settlesIdle(ms = 1500): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const playing = await isAudioPlaying();
    if (playing !== true) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

interface ChunkRow {
  i: number;
  pcmMs: number;
  frames: number;
  sampleRate: number;
  callT: number;
  settleT?: number;
  startT?: number;
  endT?: number;
  end?: 'finish' | 'stopped';
  id?: number;
  text?: string;
}

/** Every playback event, play call and chunk metric of one run. */
class Recorder {
  readonly t0 = Date.now();
  readonly events: TimedEvent[] = [];
  readonly plays: PlayCall[] = [];
  private readonly offs: Array<() => void> = [];

  constructor(private readonly phononCollector: ChunkCollector | null) {
    const on = (kind: string) => (e: {id?: number}) => {
      this.events.push({t: this.now(), kind, id: e?.id});
    };
    for (const [kind, sub] of [
      ['start', Speech.onStart],
      ['finish', Speech.onFinish],
      ['stopped', Speech.onStopped],
      ['pause', Speech.onPause],
      ['resume', Speech.onResume],
      ['error', Speech.onError],
    ] as const) {
      const s = sub(on(kind));
      this.offs.push(() => s.remove());
    }
    const intr = onAudioInterruption(e => {
      this.events.push({
        t: this.now(),
        kind: `interruption_${e.type}`,
        shouldResume: e.shouldResume,
      });
    });
    this.offs.push(() => intr.remove());
    this.offs.push(
      Speech.onChunkProgress(e =>
        this.events.push({
          t: this.now(),
          kind: 'chunk',
          index: e.chunkIndex,
          text: e.chunkText,
        }),
      ),
    );
    this.offs.push(
      onPlayCall((call, phase) => {
        if (phase === 'call') this.plays.push(call);
      }),
    );
    if (phononCollector) {
      phononCollector.start();
      this.offs.push(() => {
        phononCollector.flush();
      });
    }
  }

  get phonon(): readonly PhononChunkMetrics[] {
    return this.phononCollector?.chunks ?? [];
  }

  now(): number {
    return Date.now() - this.t0;
  }

  mark(kind: string, extra: Record<string, unknown> = {}): number {
    const t = this.now();
    this.events.push({t, kind, ...extra});
    return t;
  }

  /** The first native start at or after `t`, with its PCM once known. */
  async waitStart(afterT: number, ms: number): Promise<TimedEvent | null> {
    let found: TimedEvent | null = null;
    await waitUntil(() => {
      found =
        this.events.find(e => e.kind === 'start' && e.t >= afterT) ?? null;
      return !!found;
    }, ms);
    return found;
  }

  /** Starts after `t` that never got an onStopped: audio that outlived a stop(). */
  leakedStartsAfter(t: number): TimedEvent[] {
    return this.events.filter(
      e =>
        e.kind === 'start' &&
        e.t > t &&
        !this.events.some(
          x => x.id === e.id && x.kind === 'stopped' && x.t >= e.t,
        ),
    );
  }

  count(kind: string, fromT = 0, toT = Infinity): number {
    return this.events.filter(
      e => e.kind === kind && e.t >= fromT && e.t <= toT,
    ).length;
  }

  chunks(): ChunkRow[] {
    const rows: ChunkRow[] =
      this.phonon.length > 0
        ? this.phonon.map((m, i) => ({
            i,
            pcmMs: m.audioSec * 1000,
            frames: m.samples,
            sampleRate: m.audioSec > 0 ? Math.round(m.samples / m.audioSec) : 0,
            callT: m.playStartTs - this.t0,
            settleT: m.playEndTs - this.t0,
          }))
        : this.plays.map((p, i) => ({
            i,
            pcmMs: p.pcmMs,
            frames: Math.floor(p.bytes / (2 * p.channels)),
            sampleRate: p.sampleRate,
            callT: p.calledAt - this.t0,
            settleT:
              p.settledAt === undefined ? undefined : p.settledAt - this.t0,
          }));
    const used = new Set<TimedEvent>();
    const texts = this.events.filter(e => e.kind === 'chunk');
    rows.forEach((row, k) => {
      const nextCall = rows[k + 1]?.callT ?? Infinity;
      const start = this.events.find(
        e =>
          e.kind === 'start' &&
          !used.has(e) &&
          e.t >= row.callT - 5 &&
          e.t < nextCall,
      );
      if (start) {
        used.add(start);
        row.startT = start.t;
        row.id = start.id;
        const end = this.events.find(
          e =>
            (e.kind === 'finish' || e.kind === 'stopped') &&
            e.id === start.id &&
            e.t >= start.t,
        );
        if (end) {
          row.endT = end.t;
          row.end = end.kind as 'finish' | 'stopped';
        }
      }
      row.text = texts[k]?.text as string | undefined;
    });
    return rows;
  }

  stop(): void {
    this.offs.splice(0).forEach(f => f());
  }

  toJSON() {
    return {t0: this.t0, events: this.events, chunks: this.chunks()};
  }
}

function phononCollectorFor(engine: EngineId): ChunkCollector | null {
  return engine === PHONON ? new ChunkCollector() : null;
}

class Evidence {
  readonly dir: string;

  constructor(runId: string) {
    const ext = (RNFS as {ExternalDirectoryPath?: string})
      .ExternalDirectoryPath;
    const base =
      Platform.OS === 'android' && ext ? ext : RNFS.DocumentDirectoryPath;
    this.dir = `${base}/edges-evidence/${runId}`;
  }

  async init(): Promise<void> {
    try {
      await RNFS.mkdir(this.dir);
      await RNFS.writeFile(`${this.dir}/runs.jsonl`, '', 'utf8');
    } catch (e) {
      console.warn('[SelfTest] edges evidence dir failed:', e);
    }
  }

  async run(data: Record<string, unknown>): Promise<void> {
    try {
      await RNFS.appendFile(
        `${this.dir}/runs.jsonl`,
        `${JSON.stringify(data)}\n`,
        'utf8',
      );
    } catch {
      // The compact log line still has the verdict.
    }
  }

  async json(name: string, data: unknown): Promise<void> {
    try {
      await RNFS.writeFile(
        `${this.dir}/${name}`,
        JSON.stringify(data, null, 2),
        'utf8',
      );
    } catch {
      // Best effort.
    }
  }
}

interface Ctx {
  params: EdgesParams;
  engine: EngineId;
  evidence: Evidence;
  output: OutputInfo | null;
  results: EdgeResult[];
}

/** Android: the probe's head-vs-presented gap; iOS: AVAudioSession.outputLatency. */
function latencyMs(out: OutputInfo | null): number {
  if (!out) return 0;
  if (out.probeLatencyMs >= 0) return out.probeLatencyMs;
  return Math.max(0, out.outputLatencyMs);
}

async function readOutput(): Promise<OutputInfo | null> {
  try {
    return Probe ? await Probe.getOutputInfo() : null;
  } catch (e) {
    console.warn('[SelfTest] getOutputInfo failed:', e);
    return null;
  }
}

function r1(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v * 10) / 10;
}

const resultListeners = new Set<
  (r: EdgeResult[], done: string | null) => void
>();

/** Live results for the self-test panel. */
export function onEdgesProgress(
  listener: (results: EdgeResult[], summary: string | null) => void,
): () => void {
  resultListeners.add(listener);
  return () => {
    resultListeners.delete(listener);
  };
}

function report(ctx: Ctx, name: string, status: EdgeStatus, detail: string) {
  console.log(`[SelfTest] ${name} ${status} ${detail}`);
  emitBenchmark('EDGE_RESULT', {name, status, detail});
  ctx.results.push({name, status, detail});
  resultListeners.forEach(l => l([...ctx.results], null));
}

async function logRun(
  ctx: Ctx,
  data: Record<string, unknown>,
  compact: Record<string, unknown>,
) {
  console.log(`[SelfTest] EDGE ${JSON.stringify(compact)}`);
  await ctx.evidence.run({
    engine: ctx.engine,
    platform: Platform.OS,
    latencyMs: latencyMs(ctx.output),
    output: ctx.output,
    ...data,
  });
}

async function speakTracked(text: string, rec: Recorder) {
  rec.mark('speak_call');
  return trackPromise('speak', Speech.speak(text), () => rec.now());
}

function streamTracked(text: string, rec: Recorder) {
  rec.mark('stream_call');
  const stream = Speech.createSpeechStream(undefined, {stripMarkdown: false});
  stream.append(text);
  return trackPromise('finalize', stream.finalize(), () => rec.now());
}

async function settleWithin(recs: TrackedPromise[], ms: number) {
  return waitUntil(() => recs.every(r => r.settles > 0), ms);
}

/** A short speak after a scenario: resolves and plays (start + finish). */
async function nextSpeakWorks(
  ctx: Ctx,
): Promise<{ok: boolean; detail: string}> {
  const rec = new Recorder(phononCollectorFor(ctx.engine));
  try {
    const {rec: p} = await speakTracked(SHORT, rec);
    const settled = await settleWithin([p], ctx.params.settleTimeoutMs);
    const ok =
      settled &&
      p.outcome === 'resolved' &&
      rec.count('start') > 0 &&
      rec.count('finish') > 0;
    return {
      ok,
      detail: `next=${ok ? 'ok' : `settled:${settled} outcome:${p.outcome} start:${rec.count('start')} finish:${rec.count('finish')}`}`,
    };
  } finally {
    rec.stop();
  }
}

// --- E1 / cold: resolve timing ------------------------------------------------

interface TimingCheck {
  rows: ChunkRow[];
  minFinishMarginMs: number;
  minSettleMarginMs: number;
  finalMarginMs: number;
  spanMs: number;
  startDelayMs: number;
  pcmMs: number;
  ok: boolean;
}

function timingCheck(
  rec: Recorder,
  settledAt: number | undefined,
  lat: number,
  tolMs: number,
): TimingCheck {
  const rows = rec.chunks();
  const finishMargins = rows
    .filter(r => r.startT !== undefined && r.end === 'finish')
    .map(r => r.endT! - r.startT! - (r.pcmMs + lat));
  const settleMargins = rows
    .filter(r => r.settleT !== undefined)
    .map(r => r.settleT! - r.callT - (r.pcmMs + lat));
  const last = rows[rows.length - 1];
  const finalMarginMs =
    last?.startT !== undefined && settledAt !== undefined
      ? settledAt - (last.startT + last.pcmMs + lat)
      : Number.NaN;
  const starts = rows.filter(r => r.startT !== undefined);
  const finishes = rows.filter(r => r.end === 'finish');
  const spanMs =
    starts.length && finishes.length
      ? finishes[finishes.length - 1]!.endT! - starts[0]!.startT!
      : Number.NaN;
  const call = rec.events.find(
    e => e.kind === 'speak_call' || e.kind === 'stream_call',
  );
  const minFinishMarginMs = finishMargins.length
    ? Math.min(...finishMargins)
    : Number.NaN;
  const minSettleMarginMs = settleMargins.length
    ? Math.min(...settleMargins)
    : Number.NaN;
  const ok =
    rows.length > 0 &&
    finishes.length === rows.length &&
    minFinishMarginMs >= -tolMs &&
    (Number.isNaN(minSettleMarginMs) || minSettleMarginMs >= -tolMs) &&
    finalMarginMs >= -tolMs;
  return {
    rows,
    minFinishMarginMs,
    minSettleMarginMs,
    finalMarginMs,
    spanMs,
    startDelayMs:
      starts.length && call ? starts[0]!.startT! - call.t : Number.NaN,
    pcmMs: rows.reduce((a, r) => a + r.pcmMs, 0),
    ok,
  };
}

async function timedRun(ctx: Ctx, mode: 'speak' | 'stream', text: string) {
  const rec = new Recorder(phononCollectorFor(ctx.engine));
  try {
    const {rec: p} =
      mode === 'speak'
        ? await speakTracked(text, rec)
        : streamTracked(text, rec);
    await settleWithin([p], ctx.params.settleTimeoutMs * 3);
    await sleep(150);
    rec.stop();
    return {
      rec,
      p,
      check: timingCheck(
        rec,
        p.settledAt,
        latencyMs(ctx.output),
        ctx.params.tolMs,
      ),
    };
  } finally {
    rec.stop();
  }
}

function compactTiming(c: TimingCheck) {
  return {
    chunks: c.rows.length,
    pcmMs: r1(c.pcmMs),
    spanMs: c.spanMs,
    startDelayMs: c.startDelayMs,
    minFinishMarginMs: r1(c.minFinishMarginMs),
    minSettleMarginMs: r1(c.minSettleMarginMs),
    finalMarginMs: r1(c.finalMarginMs),
    perChunk: c.rows.map(r => ({
      pcm: r1(r.pcmMs),
      start: r.startT,
      end: r.endT,
      endKind: r.end,
      call: r.callT,
      settle: r.settleT,
    })),
  };
}

async function scenarioResolve(ctx: Ctx) {
  const cases: Array<[string, 'speak' | 'stream', string]> = [
    ['speak_short', 'speak', SHORT],
    ['speak_two', 'speak', PREVIEW],
    ['stream_long', 'stream', LONG],
  ];
  for (const [name, mode, text] of cases) {
    const checks: TimingCheck[] = [];
    for (let run = 1; run <= ctx.params.runs; run++) {
      const {rec, p, check} = await timedRun(ctx, mode, text);
      checks.push(check);
      await logRun(
        ctx,
        {
          scenario: 'resolve',
          case: name,
          run,
          ok: check.ok,
          promise: p,
          ...rec.toJSON(),
        },
        {
          scenario: 'resolve',
          case: name,
          run,
          ok: check.ok,
          ...compactTiming(check),
        },
      );
      await sleep(300);
    }
    const ok = checks.every(c => c.ok);
    report(
      ctx,
      `E1_resolve_${name}`,
      ok ? 'PASS' : 'FAIL',
      `runs=${checks.length} latencyMs=${r1(latencyMs(ctx.output))} tolMs=${ctx.params.tolMs} ` +
        `minFinishMarginMs=${r1(Math.min(...checks.map(c => c.minFinishMarginMs)))} ` +
        `minSettleMarginMs=${r1(Math.min(...checks.map(c => c.minSettleMarginMs)))} ` +
        `minFinalMarginMs=${r1(Math.min(...checks.map(c => c.finalMarginMs)))} ` +
        `chunks=${checks.map(c => c.rows.length).join('/')}`,
    );
  }
}

function shape(c: TimingCheck): ColdRunShape {
  return {
    spanMs: c.spanMs,
    chunks: c.rows.length,
    pcmMs: c.pcmMs,
    startDelayMs: c.startDelayMs,
    minFinishMarginMs: c.minFinishMarginMs,
  };
}

/** First speak after engine init, then warm repeats of the same text. */
async function scenarioCold(ctx: Ctx) {
  const cold = await timedRun(ctx, 'speak', PREVIEW);
  await logRun(
    ctx,
    {
      scenario: 'cold',
      run: 0,
      cold: true,
      promise: cold.p,
      ...cold.rec.toJSON(),
    },
    {scenario: 'cold', run: 0, cold: true, ...compactTiming(cold.check)},
  );
  const warm: TimingCheck[] = [];
  for (let run = 1; run <= 5; run++) {
    await sleep(300);
    const w = await timedRun(ctx, 'speak', PREVIEW);
    warm.push(w.check);
    await logRun(
      ctx,
      {scenario: 'cold', run, cold: false, promise: w.p, ...w.rec.toJSON()},
      {scenario: 'cold', run, cold: false, ...compactTiming(w.check)},
    );
  }
  const warmShape: ColdRunShape = {
    spanMs: median(warm.map(w => w.spanMs)),
    chunks: Math.round(median(warm.map(w => w.rows.length))),
    pcmMs: median(warm.map(w => w.pcmMs)),
    startDelayMs: median(warm.map(w => w.startDelayMs)),
    minFinishMarginMs: median(warm.map(w => w.minFinishMarginMs)),
  };
  const cls = classifyColdRun(
    shape(cold.check),
    warmShape,
    Math.max(ctx.params.tolMs, 100),
  );
  const spanDelta = cold.check.spanMs - warmShape.spanMs;
  report(
    ctx,
    'E1_cold_first_run',
    cls === 'consistent' && cold.check.ok ? 'PASS' : 'FAIL',
    `class=${cls} coldSpanMs=${cold.check.spanMs} warmSpanMs=${warmShape.spanMs} deltaMs=${spanDelta} ` +
      `chunks=${cold.check.rows.length}/${warmShape.chunks} pcmMs=${r1(cold.check.pcmMs)}/${r1(warmShape.pcmMs)} ` +
      `startDelayMs=${cold.check.startDelayMs}/${warmShape.startDelayMs} ` +
      `minFinishMarginMs=${r1(cold.check.minFinishMarginMs)}/${r1(warmShape.minFinishMarginMs)}`,
  );
}

// --- E2: stop ----------------------------------------------------------------

type StopWhere = 'before_audio' | 'mid_chunk' | 'last_200ms';

async function stopRun(
  ctx: Ctx,
  rng: Rng,
  mode: 'speak' | 'stream',
  where: StopWhere,
) {
  const rec = new Recorder(phononCollectorFor(ctx.engine));
  try {
    const text = mode === 'speak' ? SHORT : PREVIEW;
    const {rec: p} =
      mode === 'speak'
        ? await speakTracked(text, rec)
        : streamTracked(text, rec);
    let offsetMs = 0;
    if (where === 'before_audio') {
      offsetMs = randInt(rng, 0, 60);
      await sleep(offsetMs);
    } else {
      const start = await rec.waitStart(0, 30_000);
      if (!start) throw new Error('no onStart within 30 s');
      await waitUntil(() => rec.chunks().length > 0, 2000);
      const pcm = rec.chunks()[0]?.pcmMs ?? 1000;
      offsetMs =
        where === 'mid_chunk'
          ? Math.round(pcm * (0.2 + rng() * 0.6))
          : Math.round(tailOffsetMs(pcm, randInt(rng, 0, 200)));
      await sleep(start.t + offsetMs - rec.now());
    }
    const stopT = rec.mark('stop_call', {where, offsetMs});
    const startedBefore = rec.count('start', 0, stopT);
    await Speech.stop();
    rec.mark('stop_settle');
    const settled = await settleWithin([p], 5000);
    await sleep(500);
    rec.stop();
    const startsAfter = rec.events.filter(
      e => e.kind === 'start' && e.t > stopT,
    );
    const leakedStarts = rec.leakedStartsAfter(stopT).length;
    const finishAfter = rec.events.filter(
      e => e.kind === 'finish' && e.t > stopT,
    );
    // A chunk that ended on its own just before the native stop ran.
    const raceFinish = finishAfter.filter(
      e => !startsAfter.some(s => s.id === e.id),
    ).length;
    const stoppedAfter = rec.count('stopped', stopT);
    const order = checkEventOrder(rec.events);
    const ok =
      settled &&
      p.settles === 1 &&
      leakedStarts === 0 &&
      (where === 'last_200ms' || raceFinish === 0) &&
      order.violations.length === 0;
    const data = {
      mode,
      where,
      offsetMs,
      startedBefore,
      startsAfter: startsAfter.length,
      leakedStarts,
      finishAfter: finishAfter.length,
      raceFinish,
      stoppedAfter,
      settled,
      settleAfterStopMs: p.settledAt === undefined ? null : p.settledAt - stopT,
      outcome: p.outcome,
      violations: order.violations,
    };
    await logRun(
      ctx,
      {scenario: 'stop', ...data, ok, promise: p, ...rec.toJSON()},
      {scenario: 'stop', ...data, ok},
    );
    return {ok, data};
  } finally {
    rec.stop();
  }
}

async function scenarioStop(ctx: Ctx) {
  const rng = seededRng(iterationSeed(ctx.params.seed, 2));
  for (const mode of ['speak', 'stream'] as const) {
    for (const where of ['before_audio', 'mid_chunk', 'last_200ms'] as const) {
      const fails: string[] = [];
      let nextFails = 0;
      const notes: string[] = [];
      for (let run = 1; run <= ctx.params.runs; run++) {
        try {
          const {ok, data} = await stopRun(ctx, rng, mode, where);
          if (!ok) fails.push(`run${run}:${JSON.stringify(data)}`);
          notes.push(
            `+${data.offsetMs}ms:stopped=${data.stoppedAfter},finish=${data.finishAfter},settle=${data.settleAfterStopMs}`,
          );
        } catch (e) {
          fails.push(`run${run}:threw ${String(e)}`);
        }
        const next = await nextSpeakWorks(ctx);
        if (!next.ok) nextFails++;
        await sleep(300);
      }
      report(
        ctx,
        `E2_stop_${mode}_${where}`,
        fails.length === 0 && nextFails === 0 ? 'PASS' : 'FAIL',
        `runs=${ctx.params.runs} ${notes.join(' ')} nextSpeakFails=${nextFails}` +
          (fails.length ? ` FAILS ${fails.join(' | ')}` : ''),
      );
    }
  }
}

// --- E3: pause in the tail ---------------------------------------------------

async function pauseTailRun(
  ctx: Ctx,
  mode: 'speak' | 'stream',
  tailMs: number,
) {
  const rec = new Recorder(phononCollectorFor(ctx.engine));
  try {
    const {rec: p} =
      mode === 'speak'
        ? await speakTracked(SHORT, rec)
        : streamTracked(PREVIEW, rec);
    const start = await rec.waitStart(0, 30_000);
    if (!start) throw new Error('no onStart within 30 s');
    await waitUntil(() => rec.chunks().length > 0, 2000);
    const pcm = rec.chunks()[0]?.pcmMs ?? 1000;
    await sleep(start.t + tailOffsetMs(pcm, tailMs) - rec.now());
    const pauseT = rec.mark('pause_call', {tailMs});
    const paused = await Speech.pause();
    rec.mark('pause_settle', {paused});
    await sleep(2000);
    const resumeT = rec.mark('resume_call');
    const finishWhilePaused = rec.count('finish', pauseT, resumeT);
    const startWhilePaused = rec.count('start', pauseT, resumeT);
    const settledWhilePaused =
      p.settledAt !== undefined &&
      p.settledAt >= pauseT &&
      p.settledAt <= resumeT;
    const resumed = await Speech.resume();
    rec.mark('resume_settle', {resumed});
    const settled = await settleWithin([p], ctx.params.settleTimeoutMs);
    await sleep(200);
    rec.stop();
    const finishAfterResume = rec.count('finish', resumeT);
    const startsAfterResume = rec.count('start', resumeT);
    const chunks = rec.chunks();
    const order = checkEventOrder(rec.events);
    // A pause that landed after the chunk ended returns false: nothing to hold.
    const ok = paused
      ? finishWhilePaused === 0 &&
        startWhilePaused === 0 &&
        !settledWhilePaused &&
        settled &&
        finishAfterResume > 0 &&
        (mode === 'speak' || startsAfterResume > 0) &&
        order.violations.length === 0
      : settled && order.violations.length === 0;
    const data = {
      mode,
      tailMs,
      pcmMs: r1(pcm),
      paused,
      resumed,
      pauseAtMs: pauseT - start.t,
      finishWhilePaused,
      startWhilePaused,
      settledWhilePaused,
      finishAfterResume,
      startsAfterResume,
      chunks: chunks.length,
      settled,
      violations: order.violations,
    };
    await logRun(
      ctx,
      {scenario: 'pause_tail', ...data, ok, promise: p, ...rec.toJSON()},
      {scenario: 'pause_tail', ...data, ok},
    );
    return {ok, data};
  } finally {
    rec.stop();
  }
}

async function scenarioPauseTail(ctx: Ctx) {
  for (const mode of ['speak', 'stream'] as const) {
    for (const tailMs of [50, 100, 200]) {
      const fails: string[] = [];
      const notes: string[] = [];
      for (let run = 1; run <= ctx.params.runs; run++) {
        try {
          const {ok, data} = await pauseTailRun(ctx, mode, tailMs);
          notes.push(
            `${data.paused ? 'held' : 'missed'}@${data.pauseAtMs}/${data.pcmMs}`,
          );
          if (!ok) fails.push(`run${run}:${JSON.stringify(data)}`);
        } catch (e) {
          fails.push(`run${run}:threw ${String(e)}`);
          await Speech.resume().catch(() => false);
          await Speech.stop().catch(() => undefined);
        }
        await sleep(300);
      }
      report(
        ctx,
        `E3_pause_tail_${mode}_${tailMs}ms`,
        fails.length === 0 ? 'PASS' : 'FAIL',
        `runs=${ctx.params.runs} ${notes.join(' ')}` +
          (fails.length ? ` FAILS ${fails.join(' | ')}` : ''),
      );
    }
  }
}

// --- E4 / E5: interruption and route change ------------------------------------

type Disruption = {kind: string; run: (holdMs: number) => Promise<unknown>};

async function disruptRun(
  ctx: Ctx,
  scenario: 'interrupt' | 'route',
  d: Disruption,
  where: 'mid' | 'tail',
) {
  const rec = new Recorder(phononCollectorFor(ctx.engine));
  let resumeCalls = 0;
  const intr = onAudioInterruption(e => {
    if (e.type === 'ended' && e.shouldResume) {
      resumeCalls++;
      rec.mark('app_resume_call');
      Speech.resume().catch(() => false);
    }
  });
  try {
    const {rec: p} = streamTracked(PREVIEW, rec);
    const start = await rec.waitStart(0, 30_000);
    if (!start) throw new Error('no onStart within 30 s');
    await waitUntil(() => rec.chunks().length > 0, 2000);
    const pcm = rec.chunks()[0]?.pcmMs ?? 1000;
    const at = where === 'mid' ? pcm * 0.4 : tailOffsetMs(pcm, 100);
    await sleep(start.t + at - rec.now());
    const t = rec.mark(`${scenario}_call`, {kind: d.kind, where});
    let probeResult: unknown = null;
    let probeError = '';
    try {
      probeResult = await d.run(1500);
    } catch (e) {
      probeError = String(e);
    }
    const endT = rec.mark(`${scenario}_end`);
    const settled = await settleWithin([p], ctx.params.settleTimeoutMs);
    if (!settled) {
      rec.mark('rescue_resume');
      await Speech.resume().catch(() => false);
    }
    const settledAfterRescue = settled || (await settleWithin([p], 5000));
    if (!settledAfterRescue) {
      await Speech.stop().catch(() => undefined);
      await settleWithin([p], 5000);
    }
    await sleep(300);
    const idle = await settlesIdle();
    rec.stop();
    const chunks = rec.chunks();
    const order = checkEventOrder(rec.events);
    const data = {
      kind: d.kind,
      where,
      atMs: Math.round(at),
      probeResult,
      probeError,
      settled,
      settledAfterRescue,
      settleAfterDisruptMs:
        p.settledAt === undefined ? null : p.settledAt - endT,
      outcome: p.outcome,
      chunks: chunks.length,
      chunkEnds: chunks.map(c => c.end ?? 'none'),
      silentSettles: chunks.filter(
        c => c.settleT !== undefined && c.end === undefined,
      ).length,
      secondChunkStarted: chunks.length > 1 && chunks[1]!.startT !== undefined,
      startsDuringDisruption: rec.count('start', t + 1, endT),
      resumeCalls,
      idle,
      violations: order.violations,
    };
    const ok =
      settled &&
      idle &&
      order.violations.length === 0 &&
      (scenario === 'interrupt' || data.secondChunkStarted);
    await logRun(
      ctx,
      {scenario, ...data, ok, promise: p, ...rec.toJSON()},
      {scenario, ...data, ok},
    );
    return {ok, data};
  } finally {
    intr.remove();
    rec.stop();
  }
}

async function scenarioDisrupt(ctx: Ctx, scenario: 'interrupt' | 'route') {
  if (!Probe) {
    report(
      ctx,
      `E${scenario === 'interrupt' ? 4 : 5}_${scenario}`,
      'SKIP',
      'RNPlaybackProbe missing',
    );
    return;
  }
  const probe = Probe;
  const kinds: Disruption[] =
    scenario === 'route'
      ? [
          {
            kind:
              Platform.OS === 'ios'
                ? 'speaker_override'
                : 'mode_in_communication',
            run: ms => probe.routeChange(ms),
          },
        ]
      : Platform.OS === 'ios'
        ? [
            {
              kind: 'notification',
              run: ms => probe.interrupt('notification', ms),
            },
          ]
        : (['transient', 'duck', 'gain'] as const).map(kind => ({
            kind: `focus_${kind}`,
            run: (ms: number) => probe.interrupt(kind, ms),
          }));
  for (const d of kinds) {
    for (const where of ['mid', 'tail'] as const) {
      let detail = '';
      let ok = false;
      try {
        const r = await disruptRun(ctx, scenario, d, where);
        ok = r.ok;
        const x = r.data;
        detail =
          `settled=${x.settled} rescued=${!x.settled && x.settledAfterRescue} settleAfterMs=${x.settleAfterDisruptMs} ` +
          `chunkEnds=${x.chunkEnds.join(',')} silentSettles=${x.silentSettles} ` +
          `secondChunk=${x.secondChunkStarted} startsDuring=${x.startsDuringDisruption} ` +
          `resumeCalls=${x.resumeCalls} idle=${x.idle} violations=${x.violations.length}` +
          (x.probeError ? ` probeError=${x.probeError}` : '');
      } catch (e) {
        detail = `threw ${String(e)}`;
        await Speech.stop().catch(() => undefined);
      }
      const next = await nextSpeakWorks(ctx);
      report(
        ctx,
        `E${scenario === 'interrupt' ? 4 : 5}_${scenario}_${d.kind}_${where}`,
        ok && next.ok ? 'PASS' : 'FAIL',
        `${detail} ${next.detail}`,
      );
      await sleep(500);
    }
  }
  if (scenario === 'route') ctx.output = await readOutput();
}

// --- E4b: notification ducking -------------------------------------------------

type DuckKind = 'focus_notification' | 'real_notification';

/**
 * A notification-style MAY_DUCK focus request 1 s into playback. The app
 * never resumes: speech is expected to keep playing (ducked at most).
 */
async function duckRun(ctx: Ctx, mode: 'speak' | 'stream', kind: DuckKind) {
  const probe = Probe!;
  const rec = new Recorder(phononCollectorFor(ctx.engine));
  try {
    const {rec: p} =
      mode === 'speak'
        ? await speakTracked(SHORT, rec)
        : streamTracked(PREVIEW, rec);
    const start = await rec.waitStart(0, 30_000);
    if (!start) throw new Error('no onStart within 30 s');
    await sleep(start.t + 1000 - rec.now());
    const t = rec.mark('duck_call', {kind});
    const r: FocusProbeResult =
      kind === 'focus_notification'
        ? await probe.interrupt('notification', 1000)
        : await probe.postNotification!(1500);
    const endT = rec.mark('duck_end');
    const settled = await settleWithin([p], 12_000);
    let rescued = false;
    if (!settled) {
      rescued = true;
      rec.mark('rescue_resume');
      await Speech.resume().catch(() => false);
      if (!(await settleWithin([p], ctx.params.settleTimeoutMs))) {
        await Speech.stop().catch(() => undefined);
        await settleWithin([p], 5000);
      }
    }
    await sleep(200);
    rec.stop();
    const chunks = rec.chunks();
    const first = chunks[0];
    const states = (r.samples ?? []).flatMap(x => x.players);
    const data = {
      mode,
      kind,
      probe: {...r, samples: undefined},
      pausedSamples: states.filter(x => x === 3).length,
      startedSamples: states.filter(x => x === 2).length,
      samples: (r.samples ?? [])
        .map(x => `${x.t}:${x.players.join('/')}`)
        .join(' '),
      pauses: rec.count('pause'),
      began: rec.count('interruption_began'),
      ended: rec.count('interruption_ended'),
      resumes: rec.count('resume'),
      settled,
      rescued,
      firstChunkExtraMs:
        first?.settleT !== undefined
          ? Math.round(first.settleT - first.callT - first.pcmMs)
          : null,
      chunkEnds: chunks.map(c => c.end ?? 'none'),
      duckAtMs: t - start.t,
      duckMs: endT - t,
      timeline: rec.events
        .filter(e => e.kind !== 'chunk')
        .map(e => `${e.t}:${e.kind}${e.id !== undefined ? `#${e.id}` : ''}`)
        .join(' '),
    };
    const ok =
      data.pauses === 0 &&
      data.began === 0 &&
      settled &&
      (data.firstChunkExtraMs ?? 0) < 500;
    await logRun(
      ctx,
      {scenario: 'duck', ...data, ok, promise: p, ...rec.toJSON()},
      {scenario: 'duck', ...data, ok},
    );
    return {ok, data};
  } finally {
    rec.stop();
  }
}

async function scenarioDuck(ctx: Ctx) {
  if (Platform.OS !== 'android' || !Probe) {
    report(ctx, 'E4b_duck', 'SKIP', 'Android focus probe only');
    return;
  }
  const kinds: DuckKind[] = Probe.postNotification
    ? ['focus_notification', 'real_notification']
    : ['focus_notification'];
  for (const kind of kinds) {
    for (const mode of ['speak', 'stream'] as const) {
      let passes = 0;
      const notes: string[] = [];
      for (let run = 1; run <= ctx.params.runs; run++) {
        try {
          const {ok, data} = await duckRun(ctx, mode, kind);
          if (ok) passes++;
          notes.push(
            `run${run}:pause=${data.pauses},began=${data.began},ended=${data.ended},` +
              `pausedSamples=${data.pausedSamples}/${data.pausedSamples + data.startedSamples},` +
              `extraMs=${data.firstChunkExtraMs},rescued=${data.rescued}`,
          );
        } catch (e) {
          notes.push(`run${run}:threw ${String(e)}`);
          await Speech.resume().catch(() => false);
          await Speech.stop().catch(() => undefined);
        }
        await sleep(500);
      }
      report(
        ctx,
        `E4b_duck_${kind}_${mode}`,
        passes === ctx.params.runs ? 'PASS' : 'FAIL',
        `pass=${passes}/${ctx.params.runs} ${notes.join(' ')}`,
      );
    }
  }
}

// --- E6: mic reopen ------------------------------------------------------------

async function scenarioMic(ctx: Ctx) {
  if (!Probe) {
    report(ctx, 'E6_mic_reopen', 'SKIP', 'RNPlaybackProbe missing');
    return;
  }
  for (const after of ['finish', 'stop'] as const) {
    const lines: string[] = [];
    let ok = true;
    let skipped = false;
    for (let run = 1; run <= ctx.params.runs; run++) {
      const rec = new Recorder(phononCollectorFor(ctx.engine));
      try {
        if (after === 'finish') {
          const {rec: p} = await speakTracked(SHORT, rec);
          await settleWithin([p], ctx.params.settleTimeoutMs);
        } else {
          const {rec: p} = await speakTracked(PREVIEW, rec);
          await rec.waitStart(0, 30_000);
          await sleep(400);
          await Speech.stop();
          await settleWithin([p], 5000);
        }
        const t = rec.mark('record_call');
        const r = await Probe.recordProbe(500);
        rec.mark('record_settle', {...r});
        if (r.error === 'no_permission') {
          skipped = true;
          break;
        }
        const runOk = r.started && !r.error && r.bytes > 0;
        ok = ok && runOk;
        lines.push(
          `run${run}:started=${r.started} bytes=${r.bytes}${r.error ? ` error=${r.error}` : ''}`,
        );
        await logRun(
          ctx,
          {
            scenario: 'mic',
            after,
            run,
            ok: runOk,
            recordAt: t,
            result: r,
            ...rec.toJSON(),
          },
          {scenario: 'mic', after, run, ok: runOk, ...r},
        );
      } catch (e) {
        ok = false;
        lines.push(`run${run}:threw ${String(e)}`);
      } finally {
        rec.stop();
      }
      await sleep(300);
    }
    if (skipped) {
      report(
        ctx,
        `E6_mic_after_${after}`,
        'SKIP',
        'RECORD_AUDIO not granted (adb shell pm grant speech.example android.permission.RECORD_AUDIO)',
      );
      continue;
    }
    const next = await nextSpeakWorks(ctx);
    report(
      ctx,
      `E6_mic_after_${after}`,
      ok && next.ok ? 'PASS' : 'FAIL',
      `${lines.join(' ')} ${next.detail}`,
    );
  }
}

// --- E7: fuzz ------------------------------------------------------------------

async function runOp(
  op: FuzzOp,
  rec: Recorder,
  tracked: TrackedPromise[],
  waits: Promise<void>[],
) {
  const push = (t: {rec: TrackedPromise; done: Promise<void>}) => {
    tracked.push(t.rec);
    waits.push(t.done);
  };
  switch (op.op) {
    case 'speak':
      push(await speakTracked(FUZZ_TEXTS[op.text]!, rec));
      break;
    case 'stream':
      push(streamTracked(FUZZ_TEXTS[op.text]!, rec));
      break;
    case 'pause':
      rec.mark('pause_call');
      push(trackPromise('pause', Speech.pause(), () => rec.now()));
      break;
    case 'resume':
      rec.mark('resume_call');
      push(trackPromise('resume', Speech.resume(), () => rec.now()));
      break;
    case 'stop':
      rec.mark('stop_call');
      push(trackPromise('stop', Speech.stop(), () => rec.now()));
      break;
  }
}

async function fuzzIteration(ctx: Ctx, it: number) {
  const seed = iterationSeed(ctx.params.seed, it);
  const ops = genFuzzOps(seededRng(seed), FUZZ_TEXTS.length);
  const opsText = formatOps(ops);
  console.log(
    `[SelfTest] FUZZ_ITER it=${it} seed=${ctx.params.seed} ops=${opsText}`,
  );
  const rec = new Recorder(phononCollectorFor(ctx.engine));
  const tracked: TrackedPromise[] = [];
  const waits: Promise<void>[] = [];
  try {
    for (const op of ops) {
      await sleep(op.delayMs);
      await runOp(op, rec, tracked, waits);
    }
    await sleep(randInt(seededRng(seed + 1), 0, 800));
    const finalStopT = rec.mark('final_stop_call');
    const finalStop = trackPromise('final_stop', Speech.stop(), () =>
      rec.now(),
    );
    tracked.push(finalStop.rec);
    const settled = await settleWithin(tracked, ctx.params.settleTimeoutMs);
    let rescued = false;
    if (!settled) {
      rescued = true;
      rec.mark('rescue');
      await Speech.resume().catch(() => false);
      await Speech.stop().catch(() => undefined);
      await settleWithin(tracked, 5000);
    }
    await sleep(300);
    const idle = await settlesIdle();
    rec.stop();
    const order = checkEventOrder(rec.events);
    const hung = unsettled(tracked);
    const startsAfterFinalStop = rec.count('start', finalStopT + 1);
    const leaked = rec
      .leakedStartsAfter(finalStopT)
      .map(e => `#${e.id}@+${e.t - finalStopT}ms`);
    const ok =
      settled &&
      idle &&
      hung.length === 0 &&
      order.violations.length === 0 &&
      leaked.length === 0;
    const summary = {
      it,
      seed: ctx.params.seed,
      iterSeed: seed,
      ops: opsText,
      ok,
      settled,
      rescued,
      idle,
      hung: hung.map(h => `${h.label}@${h.issuedAt}`),
      violations: order.violations,
      lateStopped: order.lateStopped,
      startsAfterFinalStop,
      leaked,
      rejected: tracked
        .filter(t => t.outcome === 'rejected')
        .map(t => `${t.label}:${t.error}`),
    };
    if (!ok) {
      await logRun(
        ctx,
        {scenario: 'fuzz', ...summary, promises: tracked, ...rec.toJSON()},
        {
          scenario: 'fuzz',
          ...summary,
          repro: `speechexample://selftest?suite=edges&engine=${ctx.params.engine}&scenarios=fuzz&seed=${ctx.params.seed}&fuzzIter=${it}`,
          timeline: rec.events
            .map(e => `${e.t}:${e.kind}${e.id !== undefined ? `#${e.id}` : ''}`)
            .join(' '),
        },
      );
    } else {
      await ctx.evidence.run({scenario: 'fuzz', ...summary});
    }
    return summary;
  } finally {
    rec.stop();
  }
}

async function scenarioFuzz(ctx: Ctx) {
  const iters =
    ctx.params.fuzzIter !== undefined
      ? [ctx.params.fuzzIter]
      : Array.from({length: ctx.params.iterations}, (_, i) => i);
  const failed: number[] = [];
  let lateStopped = 0;
  let rejected = 0;
  let stoppedRaces = 0;
  const t0 = Date.now();
  for (const it of iters) {
    try {
      const s = await fuzzIteration(ctx, it);
      if (!s.ok) failed.push(it);
      lateStopped += s.lateStopped;
      rejected += s.rejected.length;
      stoppedRaces += s.startsAfterFinalStop - s.leaked.length;
    } catch (e) {
      failed.push(it);
      console.log(`[SelfTest] FUZZ_ITER it=${it} threw ${String(e)}`);
      await Speech.stop().catch(() => undefined);
    }
    await sleep(250);
  }
  const next = await nextSpeakWorks(ctx);
  report(
    ctx,
    'E7_fuzz',
    failed.length === 0 && next.ok ? 'PASS' : 'FAIL',
    `seed=${ctx.params.seed} iterations=${iters.length} failed=${failed.length}` +
      (failed.length ? ` failedIters=${failed.slice(0, 20).join(',')}` : '') +
      ` lateStopped=${lateStopped} stoppedRaces=${stoppedRaces} rejected=${rejected} wallS=${Math.round((Date.now() - t0) / 1000)} ${next.detail}`,
  );
}

// --- E8: soak ------------------------------------------------------------------

async function memorySample(): Promise<{
  rssMb: number | null;
  footprintMb: number | null;
}> {
  let rssMb: number | null = null;
  if (Platform.OS === 'android') {
    try {
      rssMb = vmRssMb(await RNFS.readFile('/proc/self/status', 'utf8'));
    } catch {
      rssMb = null;
    }
  }
  let footprintMb: number | null = null;
  try {
    footprintMb = (await Benchmark.getMemoryStats()).nativeHeapAllocatedMB;
  } catch {
    footprintMb = null;
  }
  return {rssMb, footprintMb};
}

async function scenarioSoak(ctx: Ctx) {
  const n = ctx.params.soak;
  const mem: Array<{
    i: number;
    rssMb: number | null;
    footprintMb: number | null;
  }> = [];
  let hung = 0;
  let stuck = 0;
  let missingEvents = 0;
  let rejected = 0;
  const failures: string[] = [];
  const t0 = Date.now();
  mem.push({i: 0, ...(await memorySample())});
  for (let i = 1; i <= n; i++) {
    const rec = new Recorder(phononCollectorFor(ctx.engine));
    try {
      const {rec: p} = await speakTracked(
        SOAK_TEXTS[i % SOAK_TEXTS.length]!,
        rec,
      );
      const settled = await settleWithin([p], ctx.params.settleTimeoutMs);
      if (!settled) {
        hung++;
        failures.push(`i=${i}:hung`);
        await Speech.stop().catch(() => undefined);
      }
      if (p.outcome === 'rejected') {
        rejected++;
        failures.push(`i=${i}:rejected ${p.error}`);
      }
      if (!(await settlesIdle(1000))) {
        stuck++;
        failures.push(`i=${i}:stuck_playing`);
      }
      await sleep(50);
      if (rec.count('start') === 0 || rec.count('finish') === 0) {
        missingEvents++;
      }
    } finally {
      rec.stop();
    }
    if (i % 50 === 0 || i === n) {
      const m = await memorySample();
      mem.push({i, ...m});
      console.log(
        `[SelfTest] SOAK i=${i}/${n} rssMb=${r1(m.rssMb ?? undefined)} footprintMb=${r1(m.footprintMb ?? undefined)} hung=${hung} stuck=${stuck}`,
      );
    }
  }
  const series = mem
    .map(m => m.rssMb ?? m.footprintMb)
    .filter((v): v is number => v !== null);
  const base = series.length > 2 ? series[1]! : series[0];
  const growth =
    base !== undefined && series.length ? series[series.length - 1]! - base : 0;
  const ok =
    hung === 0 &&
    stuck === 0 &&
    rejected === 0 &&
    growth <= ctx.params.memGrowthMb;
  await logRun(
    ctx,
    {scenario: 'soak', n, hung, stuck, rejected, missingEvents, mem, failures},
    {
      scenario: 'soak',
      n,
      hung,
      stuck,
      rejected,
      missingEvents,
      growthMb: r1(growth),
    },
  );
  report(
    ctx,
    'E8_soak',
    ok ? 'PASS' : 'FAIL',
    `speaks=${n} hung=${hung} stuck=${stuck} rejected=${rejected} missingEvents=${missingEvents} ` +
      `memGrowthMb=${r1(growth)} (limit ${ctx.params.memGrowthMb}, from i=50) wallS=${Math.round((Date.now() - t0) / 1000)}` +
      (failures.length ? ` first=${failures.slice(0, 5).join(',')}` : ''),
  );
}

// --- engine --------------------------------------------------------------------

async function initEngine(
  p: EdgesParams,
): Promise<{engine: EngineId; info: string}> {
  if (p.engine === 'current') {
    const engine = Speech.getCurrentEngineId();
    if (!engineManager.isEngineInitialized(engine))
      throw new Error(`${engine} not initialized`);
    return {engine, info: 'current'};
  }
  const target: EngineId =
    p.engine === 'phonon'
      ? PHONON
      : p.engine === 'kokoro'
        ? TTSEngine.KOKORO
        : p.engine === 'supertonic'
          ? TTSEngine.SUPERTONIC
          : TTSEngine.KITTEN;
  // At app start the SYS tab initializes its engine; let it finish first.
  await waitUntil(
    () => engineManager.isEngineInitialized(Speech.getCurrentEngineId()),
    15_000,
  );
  if (
    !p.reinit &&
    Speech.getCurrentEngineId() === target &&
    engineManager.isEngineInitialized(target)
  ) {
    return {engine: target, info: 'kept'};
  }
  const providers: ExecutionProvider[] =
    p.accel === 'xnnpack' ? ['xnnpack', 'cpu'] : ['cpu'];
  const common = {silentMode: 'obey' as const, ducking: p.ducking};
  await Speech.release().catch(() => undefined);
  if (target === TTSEngine.KITTEN) {
    await kittenModelManager.scanInstalledModel();
    if (!(await kittenModelManager.isModelInstalled(p.variant)) && p.download) {
      console.log(`[SelfTest] downloading Kitten ${p.variant}...`);
      await kittenModelManager.downloadModel(undefined, p.variant);
    }
    const version = (await kittenModelManager.isModelInstalled(p.variant))
      ? p.variant
      : (kittenModelManager.getInstalledModel()?.version as
          | KittenVersion
          | undefined);
    if (!version) throw new Error('no Kitten model (pass download=1)');
    const dictPath = await phonemizerDictManager.ensureDict('en-us');
    await Speech.initialize({
      engine: TTSEngine.KITTEN,
      ...kittenModelManager.getDownloadedModelConfig(version),
      dictPath,
      maxChunkSize: 500,
      executionProviders: providers,
      ...common,
    });
    return {engine: target, info: `variant=${version}`};
  }
  if (target === TTSEngine.KOKORO) {
    await kokoroModelManager.scanInstalledModels();
    const model = kokoroModelManager.getInstalledModels()[0];
    if (!model) throw new Error('no Kokoro model installed');
    const dictPath = await phonemizerDictManager.ensureDict('en-us');
    await Speech.initialize({
      engine: TTSEngine.KOKORO,
      ...kokoroModelManager.getDownloadedModelConfig(
        model.version,
        model.variant,
      ),
      dictPath,
      phonemizerType: 'js',
      maxChunkSize: 100,
      executionProviders: providers,
      ...common,
    });
    return {engine: target, info: `model=${model.version}/${model.variant}`};
  }
  if (target === TTSEngine.SUPERTONIC) {
    await supertonicModelManager.scanInstalledModel();
    const model = supertonicModelManager.getInstalledModel();
    if (!model) throw new Error('no Supertonic model installed');
    await Speech.initialize({
      engine: TTSEngine.SUPERTONIC,
      ...supertonicModelManager.getDownloadedModelConfig(),
      maxChunkSize: 200,
      executionProviders: providers,
      ...common,
    });
    return {engine: target, info: `model=${model.version}`};
  }
  const support = await PhononEngine.getSupport();
  if (!support.supported)
    throw new Error(`phonon unsupported: ${support.reason}`);
  await phononModelManager.scanInstalledModel();
  if (!phononModelManager.getInstalledModel() && p.download) {
    await phononModelManager.downloadModel('31m-en');
  }
  if (!phononModelManager.getInstalledModel())
    throw new Error('no Phonon model (pass download=1)');
  await Speech.initialize({
    engine: PHONON,
    ...phononModelManager.getDownloadedModelConfig(),
    ...common,
  });
  return {engine: target, info: 'phonon'};
}

let running = false;

export function isEdgesSelfTestRunning(): boolean {
  return running;
}

export async function runEdgesSelfTest(
  params: EdgesParams,
  deps: {showTab?: (tab: SelfTestTab) => void} = {},
): Promise<EdgesSummary> {
  if (running) throw new Error('edges self-test already running');
  running = true;
  const engineBefore = Speech.getCurrentEngineId();
  const evidence = new Evidence(params.runId);
  const ctx: Ctx = {
    params,
    engine: engineBefore,
    evidence,
    output: null,
    results: [],
  };
  const has = (s: EdgeScenario) => params.scenarios.has(s);
  try {
    deps.showTab?.('streaming');
    await evidence.init();
    console.log(
      `[SelfTest] START suite=edges runId=${params.runId} engine=${params.engine} ` +
        `scenarios=${[...params.scenarios].join(',')} seed=${params.seed} pcmTap=${isPlaybackTapInstalled()} ` +
        `probe=${!!Probe} dir=${evidence.dir}`,
    );
    let initInfo = '';
    const initStart = Date.now();
    try {
      const r = await initEngine(params);
      ctx.engine = r.engine;
      initInfo = r.info;
      console.log(
        `[SelfTest] ENGINE ${r.engine} ${r.info} initMs=${Date.now() - initStart}`,
      );
    } catch (e) {
      report(ctx, 'E0_engine', 'FAIL', `init failed: ${String(e)}`);
      return await finish();
    }
    // Before the latency probe: the cold run must be the first audio after init.
    if (has('cold')) await guard('E1_cold_first_run', () => scenarioCold(ctx));
    ctx.output = await readOutput();
    console.log(
      `[SelfTest] OUTPUT ${JSON.stringify(ctx.output)} latencyMs=${r1(latencyMs(ctx.output))}`,
    );
    await evidence.json('setup.json', {
      params: {...params, scenarios: [...params.scenarios]},
      engine: ctx.engine,
      initInfo,
      output: ctx.output,
      platform: Platform.OS,
      version: Platform.Version,
    });
    if (has('resolve')) await guard('E1_resolve', () => scenarioResolve(ctx));
    if (has('stop')) await guard('E2_stop', () => scenarioStop(ctx));
    if (has('pause_tail'))
      await guard('E3_pause_tail', () => scenarioPauseTail(ctx));
    if (has('interrupt'))
      await guard('E4_interrupt', () => scenarioDisrupt(ctx, 'interrupt'));
    if (has('duck')) await guard('E4b_duck', () => scenarioDuck(ctx));
    if (has('route'))
      await guard('E5_route', () => scenarioDisrupt(ctx, 'route'));
    if (has('mic')) await guard('E6_mic', () => scenarioMic(ctx));
    if (has('fuzz')) await guard('E7_fuzz', () => scenarioFuzz(ctx));
    if (has('soak')) await guard('E8_soak', () => scenarioSoak(ctx));
    return await finish();
  } finally {
    running = false;
    emitSelfTestDone(engineBefore);
  }

  async function guard(name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      report(ctx, name, 'FAIL', `threw ${String(e)}`);
      await Speech.resume().catch(() => false);
      await Speech.stop().catch(() => undefined);
    }
  }

  async function finish(): Promise<EdgesSummary> {
    const count = (s: EdgeStatus) =>
      ctx.results.filter(r => r.status === s).length;
    const summary: EdgesSummary = {
      engine: ctx.engine,
      passed: count('PASS'),
      failed: count('FAIL'),
      skipped: count('SKIP'),
      results: ctx.results,
      dir: evidence.dir,
    };
    await evidence.json('summary.json', summary);
    const line =
      `SELFTEST DONE suite=edges engine=${ctx.engine} passed=${summary.passed} ` +
      `failed=${summary.failed} skipped=${summary.skipped}`;
    console.log(`[SelfTest] ${line} dir=${evidence.dir}`);
    emitBenchmark('EDGE_DONE', {line, dir: evidence.dir});
    resultListeners.forEach(l => l([...ctx.results], line));
    return summary;
  }
}
