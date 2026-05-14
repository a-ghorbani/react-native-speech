/**
 * Node-side port of the Supertonic inference pipeline.
 *
 * Mirrors `src/engines/supertonic/SupertonicInference.ts` and
 * `src/engines/supertonic/UnicodeProcessor.ts` but uses
 * `onnxruntime-node` directly and reads model assets from the local
 * filesystem. Used only by `scripts/verify-supertonic-multilingual.ts`.
 *
 * Deliberately self-contained — no imports from `src/` — so this lives
 * in `scripts/` without dragging the RN runtime into Node.
 */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';

// ---------------------------------------------------------------------------
// Constants (mirror SUPERTONIC_CONSTANTS in src/engines/supertonic/constants.ts)
// ---------------------------------------------------------------------------
const SAMPLE_RATE = 44100;
const EFFECTIVE_LATENT_DIM = 144; // 24 * 6
const CHUNK_SIZE = 3072; // 512 * 6
const STYLE_DP_SIZE = 128; // [8, 16]
const STYLE_TTL_SIZE = 12800; // [50, 256]
const SPEED_OFFSET = 0.05;

// ---------------------------------------------------------------------------
// Text normalization (mirror UnicodeProcessor.normalizeText)
// ---------------------------------------------------------------------------
function normalizeText(
  text: string,
  lang: string,
  addLanguageTags: boolean,
): string {
  let n = text.normalize('NFKD');

  // Emoji ranges — same set as the RN engine.
  n = n.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    '',
  );

  const replacements: Record<string, string> = {
    '–': '-',
    '‑': '-',
    '—': '-',
    _: ' ',
    '“': '"',
    '”': '"',
    '‘': "'",
    '’': "'",
    '´': "'",
    '`': "'",
    '[': ' ',
    ']': ' ',
    '|': ' ',
    '/': ' ',
    '#': ' ',
    '→': ' ',
    '←': ' ',
  };
  for (const [k, v] of Object.entries(replacements)) {
    n = n.split(k).join(v);
  }
  n = n.replace(/[♥☆♡©\\]/g, '');
  n = n.replace(/@/g, ' at ');
  n = n.replace(/e\.g\.,/g, 'for example, ');
  n = n.replace(/i\.e\.,/g, 'that is, ');
  n = n.replace(/ ,/g, ',');
  n = n.replace(/ \./g, '.');
  n = n.replace(/ !/g, '!');
  n = n.replace(/ \?/g, '?');
  n = n.replace(/ ;/g, ';');
  n = n.replace(/ :/g, ':');
  n = n.replace(/ '/g, "'");

  while (n.includes('""')) n = n.replace('""', '"');
  while (n.includes("''")) n = n.replace("''", "'");
  while (n.includes('``')) n = n.replace('``', '`');
  n = n.replace(/\s+/g, ' ').trim();

  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(n)) n += '.';

  if (addLanguageTags) {
    n = `<${lang}>${n}</${lang}>`;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tokenization (mirror UnicodeProcessor.textToUnicodeIds)
// ---------------------------------------------------------------------------
function textToIds(text: string, indexer: number[]): BigInt64Array {
  const ids = new BigInt64Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) ?? 0;
    const id = cp < indexer.length ? (indexer[cp] ?? -1) : -1;
    ids[i] = BigInt(id >= 0 ? id : 0);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Voice style loading (mirror StyleLoader.toFloat32Array)
// ---------------------------------------------------------------------------
function flattenDeep(arr: unknown, out: number[] = []): number[] {
  if (Array.isArray(arr)) {
    for (const x of arr) flattenDeep(x, out);
  } else if (typeof arr === 'number') {
    out.push(arr);
  }
  return out;
}

function toFloat32Array(data: unknown): Float32Array {
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    'data' in (data as object)
  ) {
    const inner = (data as {data: unknown}).data;
    if (Array.isArray(inner)) return new Float32Array(flattenDeep(inner));
  }
  if (Array.isArray(data)) {
    if (data.length > 0 && Array.isArray(data[0]))
      return new Float32Array(flattenDeep(data));
    return new Float32Array(data as number[]);
  }
  throw new Error('Unknown voice style format');
}

export interface VoiceStyle {
  styleDp: Float32Array; // 128 floats
  styleTtl: Float32Array; // 12800 floats
}

function loadVoiceStyle(voicePath: string): VoiceStyle {
  const raw = JSON.parse(readFileSync(voicePath, 'utf8')) as {
    style_dp?: unknown;
    style_ttl?: unknown;
  };
  if (!raw.style_dp || !raw.style_ttl) {
    throw new Error(`Voice file missing style_dp or style_ttl: ${voicePath}`);
  }
  const styleDp = toFloat32Array(raw.style_dp);
  const styleTtl = toFloat32Array(raw.style_ttl);
  if (styleDp.length !== STYLE_DP_SIZE) {
    throw new Error(
      `style_dp size mismatch: expected ${STYLE_DP_SIZE}, got ${styleDp.length}`,
    );
  }
  if (styleTtl.length !== STYLE_TTL_SIZE) {
    throw new Error(
      `style_ttl size mismatch: expected ${STYLE_TTL_SIZE}, got ${styleTtl.length}`,
    );
  }
  return {styleDp, styleTtl};
}

// ---------------------------------------------------------------------------
// Noise + masks
// ---------------------------------------------------------------------------
function gaussianNoise(size: number): Float32Array {
  const noise = new Float32Array(size);
  for (let i = 0; i < size; i += 2) {
    const u1 = Math.random();
    const u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    noise[i] = r * Math.cos(theta);
    if (i + 1 < size) noise[i + 1] = r * Math.sin(theta);
  }
  return noise;
}

function maskNoise(
  noise: Float32Array,
  latentDim: number,
  latentLen: number,
  mask: Float32Array,
): void {
  for (let d = 0; d < latentDim; d++) {
    for (let t = 0; t < latentLen; t++) {
      const idx = d * latentLen + t;
      noise[idx] = (noise[idx] ?? 0) * (mask[t] ?? 0);
    }
  }
}

function onesFloat(n: number): Float32Array {
  const a = new Float32Array(n);
  a.fill(1);
  return a;
}

// ---------------------------------------------------------------------------
// Output key dispatch (mirror engine's `.duration || .dur_onnx || ...`)
// ---------------------------------------------------------------------------
function pickOutput(
  results: ort.InferenceSession.OnnxValueMapType,
  keys: string[],
): ort.Tensor {
  for (const k of keys) {
    const t = results[k];
    if (t) return t as ort.Tensor;
  }
  throw new Error(
    `None of expected keys present: [${keys.join(', ')}]. Available: [${Object.keys(results).join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export interface ModelPaths {
  durationPredictor: string;
  textEncoder: string;
  vectorEstimator: string;
  vocoder: string;
  unicodeIndexer: string;
}

export interface SynthOptions {
  language: string;
  voiceId: string; // e.g. "F1"
  speed?: number;
  inferenceSteps?: number;
}

export class SupertonicNode {
  private duration!: ort.InferenceSession;
  private textEncoder!: ort.InferenceSession;
  private vectorEstimator!: ort.InferenceSession;
  private vocoder!: ort.InferenceSession;
  private indexer!: number[];
  private supportsLangTags = false;
  private voicesDir!: string;
  private voiceCache = new Map<string, VoiceStyle>();

  async init(paths: ModelPaths, voicesDir: string): Promise<void> {
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
    };
    const [d, t, v, vo] = await Promise.all([
      ort.InferenceSession.create(paths.durationPredictor, opts),
      ort.InferenceSession.create(paths.textEncoder, opts),
      ort.InferenceSession.create(paths.vectorEstimator, opts),
      ort.InferenceSession.create(paths.vocoder, opts),
    ]);
    this.duration = d;
    this.textEncoder = t;
    this.vectorEstimator = v;
    this.vocoder = vo;

    this.indexer = JSON.parse(
      readFileSync(paths.unicodeIndexer, 'utf8'),
    ) as number[];

    // Same detection rule the RN engine uses: indexer maps `<` and `>` only
    // in v2/v3 (the multilingual models).
    this.supportsLangTags =
      (this.indexer[60] ?? -1) >= 0 && (this.indexer[62] ?? -1) >= 0;

    this.voicesDir = voicesDir;
  }

  private getVoice(voiceId: string): VoiceStyle {
    let v = this.voiceCache.get(voiceId);
    if (!v) {
      v = loadVoiceStyle(path.join(this.voicesDir, `${voiceId}.json`));
      this.voiceCache.set(voiceId, v);
    }
    return v;
  }

  async synthesize(
    text: string,
    options: SynthOptions,
  ): Promise<{samples: Float32Array; sampleRate: number}> {
    const speed = options.speed ?? 1.0;
    const steps = options.inferenceSteps ?? 8;
    const voice = this.getVoice(options.voiceId);

    const normalized = normalizeText(
      text,
      options.language,
      this.supportsLangTags,
    );
    const textIds = textToIds(normalized, this.indexer);
    const seqLen = textIds.length;
    const textMask = onesFloat(seqLen);

    // ---- Step 1: duration predictor -> scalar seconds ----
    const durRes = await this.duration.run({
      text_ids: new ort.Tensor('int64', textIds, [1, seqLen]),
      style_dp: new ort.Tensor('float32', voice.styleDp, [1, 8, 16]),
      text_mask: new ort.Tensor('float32', textMask, [1, 1, seqLen]),
    });
    const durTensor = pickOutput(durRes, [
      'duration',
      'dur_onnx',
      'durations',
      'output',
    ]);
    const rawDuration = Number((durTensor.data as Float32Array)[0]);
    const factor = 1 / (speed + SPEED_OFFSET);
    const durationSeconds = Math.max(0.1, rawDuration * factor);
    const wavLength = durationSeconds * SAMPLE_RATE;
    const latentLen = Math.ceil(wavLength / CHUNK_SIZE);

    // ---- Step 2: text encoder ----
    const encRes = await this.textEncoder.run({
      text_ids: new ort.Tensor('int64', textIds, [1, seqLen]),
      text_mask: new ort.Tensor('float32', textMask, [1, 1, seqLen]),
      style_ttl: new ort.Tensor('float32', voice.styleTtl, [1, 50, 256]),
    });
    const textEmbTensor = pickOutput(encRes, [
      'text_emb_onnx',
      'text_emb',
      'output',
    ]);
    const textEmb = new Float32Array(textEmbTensor.data as Float32Array);
    const embDim = textEmbTensor.dims[1] as number;

    // ---- Step 3: vector estimator (flow-matching loop) ----
    const latentMask = onesFloat(latentLen);
    const latentShape = [1, EFFECTIVE_LATENT_DIM, latentLen];
    let latent = gaussianNoise(EFFECTIVE_LATENT_DIM * latentLen);
    maskNoise(latent, EFFECTIVE_LATENT_DIM, latentLen, latentMask);

    for (let step = 0; step < steps; step++) {
      const res = await this.vectorEstimator.run({
        noisy_latent: new ort.Tensor('float32', latent, latentShape),
        text_emb: new ort.Tensor('float32', textEmb, [1, embDim, seqLen]),
        style_ttl: new ort.Tensor('float32', voice.styleTtl, [1, 50, 256]),
        text_mask: new ort.Tensor('float32', textMask, [1, 1, seqLen]),
        latent_mask: new ort.Tensor('float32', latentMask, [1, 1, latentLen]),
        current_step: new ort.Tensor('float32', new Float32Array([step]), [1]),
        total_step: new ort.Tensor('float32', new Float32Array([steps]), [1]),
      });
      const xt = pickOutput(res, ['denoised_latent', 'xt', 'latent', 'output']);
      latent = new Float32Array(xt.data as Float32Array);
    }

    // ---- Step 4: vocoder ----
    const vocRes = await this.vocoder.run({
      latent: new ort.Tensor('float32', latent, latentShape),
    });
    const wavTensor = pickOutput(vocRes, [
      'wav_tts',
      'wav',
      'audio',
      'waveform',
      'output',
    ]);
    let samples = new Float32Array(wavTensor.data as Float32Array);

    // Trim to predicted duration (vocoder usually returns a few samples extra).
    const expected = Math.ceil(durationSeconds * SAMPLE_RATE);
    if (samples.length > expected) samples = samples.slice(0, expected);

    return {samples, sampleRate: SAMPLE_RATE};
  }
}

export const SUPERTONIC_NODE_SAMPLE_RATE = SAMPLE_RATE;
