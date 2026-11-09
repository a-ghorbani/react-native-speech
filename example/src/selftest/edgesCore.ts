/* eslint-disable no-bitwise */
/**
 * Pure helpers of the playback-edges suite (edgesSelfTest.ts): seeded RNG,
 * fuzz op generation, event-order invariants, PCM and /proc parsing.
 */

export type Rng = () => number;

/** mulberry32: deterministic [0, 1) floats from a 32-bit seed. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed of one fuzz iteration, so `fuzzIter=` replays it alone. */
export function iterationSeed(seed: number, iteration: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ iteration, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

export type FuzzOp =
  | {op: 'speak'; text: number; delayMs: number}
  | {op: 'stream'; text: number; delayMs: number}
  | {op: 'pause'; delayMs: number}
  | {op: 'resume'; delayMs: number}
  | {op: 'stop'; delayMs: number};

const OP_WEIGHTS: ReadonlyArray<[FuzzOp['op'], number]> = [
  ['speak', 3],
  ['stream', 2],
  ['pause', 2],
  ['resume', 2],
  ['stop', 2],
];

/** 2..maxOps ops, each preceded by a 0..maxDelayMs wait. */
export function genFuzzOps(
  rng: Rng,
  textCount: number,
  maxOps = 6,
  maxDelayMs = 1500,
): FuzzOp[] {
  const total = OP_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  const n = randInt(rng, 2, maxOps);
  const ops: FuzzOp[] = [];
  for (let i = 0; i < n; i++) {
    let r = rng() * total;
    let kind: FuzzOp['op'] = 'speak';
    for (const [k, w] of OP_WEIGHTS) {
      if (r < w) {
        kind = k;
        break;
      }
      r -= w;
    }
    // Front-load short delays so many ops land while audio is starting.
    const delayMs = Math.round(rng() ** 2 * maxDelayMs);
    ops.push(
      kind === 'speak' || kind === 'stream'
        ? {op: kind, text: randInt(rng, 0, textCount - 1), delayMs}
        : {op: kind, delayMs},
    );
  }
  return ops;
}

export function formatOps(ops: readonly FuzzOp[]): string {
  return ops
    .map(o => `+${o.delayMs}:${o.op}${'text' in o ? `(${o.text})` : ''}`)
    .join(' ');
}

export type NativeEventKind =
  | 'start'
  | 'finish'
  | 'stopped'
  | 'pause'
  | 'resume';

export interface TimedEvent {
  /** ms since the run's t0 */
  t: number;
  kind: string;
  id?: number;
  [extra: string]: unknown;
}

export interface OrderViolation {
  id: number;
  t: number;
  rule: string;
}

/**
 * Per-utterance-id order of native playback events. Violations break the
 * contract; `stopped` events for an id that already ended are counted
 * separately (`stopAudio()` reports the last id whether or not it plays).
 */
export function checkEventOrder(events: readonly TimedEvent[]): {
  violations: OrderViolation[];
  lateStopped: number;
} {
  const state = new Map<number, 'playing' | 'paused' | 'ended'>();
  const violations: OrderViolation[] = [];
  let lateStopped = 0;
  for (const e of events) {
    if (e.id === undefined) {
      continue;
    }
    const s = state.get(e.id);
    const bad = (rule: string) => violations.push({id: e.id!, t: e.t, rule});
    switch (e.kind) {
      case 'start':
        if (s !== undefined) bad('start after start');
        state.set(e.id, 'playing');
        break;
      case 'finish':
        if (s === undefined) bad('finish without start');
        else if (s === 'ended') bad('finish after end');
        else if (s === 'paused') bad('finish while paused');
        state.set(e.id, 'ended');
        break;
      case 'stopped':
        if (s === 'ended') lateStopped++;
        state.set(e.id, 'ended');
        break;
      case 'pause':
        if (s !== 'playing') bad(`pause while ${s ?? 'idle'}`);
        else state.set(e.id, 'paused');
        break;
      case 'resume':
        if (s !== 'paused') bad(`resume while ${s ?? 'idle'}`);
        else state.set(e.id, 'playing');
        break;
    }
  }
  return {violations, lateStopped};
}

export interface TrackedPromise {
  label: string;
  issuedAt: number;
  settledAt?: number;
  settles: number;
  outcome?: 'resolved' | 'rejected';
  error?: string;
}

/** Wraps `p` so its settle count and time land in `rec`. */
export function trackPromise(
  label: string,
  p: Promise<unknown>,
  now: () => number,
): {rec: TrackedPromise; done: Promise<void>} {
  const rec: TrackedPromise = {label, issuedAt: now(), settles: 0};
  const done = p.then(
    () => {
      rec.settles++;
      rec.settledAt ??= now();
      rec.outcome ??= 'resolved';
    },
    e => {
      rec.settles++;
      rec.settledAt ??= now();
      rec.outcome ??= 'rejected';
      rec.error ??= String(e);
    },
  );
  return {rec, done};
}

export function unsettled(recs: readonly TrackedPromise[]): TrackedPromise[] {
  return recs.filter(r => r.settles !== 1);
}

/** Decoded byte count of a base64 string. */
export function base64Bytes(b64: string): number {
  const len = b64.replace(/\s/g, '').length;
  if (len === 0) {
    return 0;
  }
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

/** Duration in ms of `bytes` of 16-bit PCM. */
export function pcm16Ms(bytes: number, sampleRate: number, channels: number) {
  const frames = Math.floor(bytes / (2 * Math.max(1, channels)));
  return sampleRate > 0 ? (frames / sampleRate) * 1000 : 0;
}

/** VmRSS in MB from /proc/self/status, or null. */
export function vmRssMb(status: string): number | null {
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  return m ? Number(m[1]) / 1024 : null;
}

/**
 * Pause/stop offsets inside a chunk of `pcmMs`: `tail` (ms before the end),
 * clamped to land after the chunk started.
 */
export function tailOffsetMs(pcmMs: number, tailMs: number): number {
  return Math.max(0, pcmMs - tailMs);
}

export type ColdClass =
  | 'consistent'
  | 'different_chunking'
  | 'different_pcm'
  | 'late_start'
  | 'early_finish';

export interface ColdRunShape {
  /** first onStart → last onFinish */
  spanMs: number;
  chunks: number;
  pcmMs: number;
  /** speak call → first onStart */
  startDelayMs: number;
  /** per chunk: (onFinish − onStart) − pcmMs, min over chunks */
  minFinishMarginMs: number;
}

/**
 * Explains a cold run that differs from the warm median: chunk count, then
 * total PCM, then an onFinish earlier than its PCM, then a late onStart.
 */
export function classifyColdRun(
  cold: ColdRunShape,
  warm: ColdRunShape,
  tolMs: number,
): ColdClass {
  if (cold.chunks !== warm.chunks) return 'different_chunking';
  if (Math.abs(cold.pcmMs - warm.pcmMs) > tolMs) return 'different_pcm';
  if (cold.minFinishMarginMs < warm.minFinishMarginMs - tolMs) {
    return 'early_finish';
  }
  if (
    cold.spanMs < warm.spanMs - tolMs &&
    cold.startDelayMs > warm.startDelayMs + tolMs
  ) {
    return 'late_start';
  }
  return 'consistent';
}

export function median(values: readonly number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
