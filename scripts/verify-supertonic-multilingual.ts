/**
 * Verify Supertonic v3 multilingual output by ASR round-trip.
 *
 * Pipeline per language:
 *   1. Synthesize the canonical test sentence with the Node port of the
 *      engine (`scripts/lib/supertonic-node.ts`).
 *   2. Write the float32 audio to a 16-bit PCM WAV at
 *      `scripts/out/<lang>.wav`.
 *   3. Run whisper.cpp (`whisper-cli`) with `--language <lang>` and
 *      `--output-json` to transcribe.
 *   4. Compute character-level similarity between the transcript and
 *      input sentence; flag mismatches.
 *
 * Final report at `scripts/out/report.md` lists every language with
 * status, similarity, duration, transcript.
 *
 * Run with: yarn tsx scripts/verify-supertonic-multilingual.ts
 *
 * CLI options:
 *   --langs en,ko,ja     limit to a subset (default: all 31)
 *   --voice F1           voice ID to use (default: F1)
 *   --steps 8            diffusion steps (default: 8 — v3 native value)
 *   --skip-whisper       just synthesize + write WAVs, no ASR
 */
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {SupertonicNode} from './lib/supertonic-node.js';
import {TEST_SENTENCES, ALL_LANGS} from './lib/multilingual-test-sentences.js';
import {writeWavMono16} from './lib/wav.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CACHE = path.join(REPO_ROOT, 'scripts/.cache/supertonic-3');
const ONNX = path.join(CACHE, 'onnx');
const VOICES = path.join(CACHE, 'voice_styles');
const OUT_DIR = path.join(REPO_ROOT, 'scripts/out');
const WHISPER_BIN = '/opt/homebrew/bin/whisper-cli';
const WHISPER_MODEL = path.join(
  REPO_ROOT,
  'scripts/.cache/whisper/ggml-large-v3.bin',
);

// ---------------------------------------------------------------------------
// CLI parsing (no external dep — minimal)
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): {
  langs: string[];
  voice: string;
  steps: number;
  skipWhisper: boolean;
} {
  const out = {
    langs: ALL_LANGS,
    voice: 'F1',
    steps: 8,
    skipWhisper: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--langs' && argv[i + 1]) {
      out.langs = argv[++i]!.split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else if (a === '--voice' && argv[i + 1]) {
      out.voice = argv[++i]!;
    } else if (a === '--steps' && argv[i + 1]) {
      out.steps = parseInt(argv[++i]!, 10);
    } else if (a === '--skip-whisper') {
      out.skipWhisper = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Similarity — Sørensen-Dice on character bigrams. Tolerates punctuation
// drift, word-order shuffles, and minor ASR errors; gives 1.0 only for
// near-identical strings. Range [0, 1].
// ---------------------------------------------------------------------------
function bigrams(s: string): Set<string> {
  const cleaned = s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');
  const set = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) {
    set.add(cleaned.slice(i, i + 2));
  }
  return set;
}

function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 && B.size === 0) return 1.0;
  if (A.size === 0 || B.size === 0) return 0.0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// ---------------------------------------------------------------------------
// Whisper invocation
// ---------------------------------------------------------------------------
interface WhisperRun {
  language: string | null;
  transcript: string;
}

function whisperOnce(
  wavPath: string,
  langFlag: string,
  outSuffix: string,
): WhisperRun {
  const baseOut = wavPath.replace(/\.wav$/, outSuffix);
  execFileSync(
    WHISPER_BIN,
    [
      '-m',
      WHISPER_MODEL,
      '-f',
      wavPath,
      '-l',
      langFlag,
      '-oj',
      '-of',
      baseOut,
      '--no-prints',
    ],
    {stdio: ['ignore', 'ignore', 'pipe']},
  );
  const raw = JSON.parse(readFileSync(`${baseOut}.json`, 'utf8')) as {
    result?: {language?: string};
    transcription?: Array<{text?: string}>;
  };
  return {
    language: raw.result?.language ?? null,
    transcript: (raw.transcription ?? [])
      .map(s => (s.text ?? '').trim())
      .filter(Boolean)
      .join(' '),
  };
}

interface WhisperResult {
  detectedLang: string | null; // result of auto-detect pass
  transcript: string; // best transcript (forced-lang if auto missed)
  forcedFallback: boolean;
}

function runWhisper(wavPath: string, expectedLang: string): WhisperResult {
  // 1) Auto-detect — catches gross synthesis failures (model spoke
  //    wrong language). Whisper is unreliable here on short utterances
  //    of close-neighbor languages (et/es, sl/hr, sk/cs), so:
  // 2) If auto-detect picked the wrong language, retry with the
  //    expected language forced. That run's transcript is what we score
  //    against the input — it's the true measure of synthesis quality
  //    independent of ASR's language-id quirks.
  const auto = whisperOnce(wavPath, 'auto', '');
  if (auto.language === expectedLang) {
    return {
      detectedLang: auto.language,
      transcript: auto.transcript,
      forcedFallback: false,
    };
  }
  const forced = whisperOnce(wavPath, expectedLang, '-forced');
  return {
    detectedLang: auto.language, // keep the auto-detect result for visibility
    transcript: forced.transcript,
    forcedFallback: true,
  };
}

// ---------------------------------------------------------------------------
// RMS check — silent / clipped audio is a synthesis failure.
// ---------------------------------------------------------------------------
function audioStats(samples: Float32Array): {rms: number; peak: number} {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
    const av = Math.abs(v);
    if (av > peak) peak = av;
  }
  return {rms: Math.sqrt(sum / samples.length), peak};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
interface Row {
  lang: string;
  input: string;
  durationSec: number;
  rms: number;
  peak: number;
  detectedLang: string | null;
  langMatch: boolean | null;
  forcedFallback: boolean;
  transcript: string;
  similarity: number | null;
  pass: boolean | null;
  error?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, {recursive: true});

  console.log(
    `Verifying Supertonic v3 across ${args.langs.length} languages with voice ${args.voice}, ${args.steps} steps.`,
  );

  const engine = new SupertonicNode();
  console.log('Loading ONNX sessions...');
  const initStart = Date.now();
  await engine.init(
    {
      durationPredictor: path.join(ONNX, 'duration_predictor.onnx'),
      textEncoder: path.join(ONNX, 'text_encoder.onnx'),
      vectorEstimator: path.join(ONNX, 'vector_estimator.onnx'),
      vocoder: path.join(ONNX, 'vocoder.onnx'),
      unicodeIndexer: path.join(ONNX, 'unicode_indexer.json'),
    },
    VOICES,
  );
  console.log(`  loaded in ${Date.now() - initStart}ms`);

  const rows: Row[] = [];
  for (const lang of args.langs) {
    const sentence = TEST_SENTENCES[lang];
    if (!sentence) {
      console.warn(`[${lang}] no test sentence; skipping`);
      continue;
    }
    const wavPath = path.join(OUT_DIR, `${lang}.wav`);
    process.stdout.write(`[${lang}] `);

    try {
      const synthStart = Date.now();
      const {samples, sampleRate} = await engine.synthesize(sentence, {
        language: lang,
        voiceId: args.voice,
        speed: 1.0,
        inferenceSteps: args.steps,
      });
      const synthMs = Date.now() - synthStart;
      writeWavMono16(wavPath, samples, sampleRate);
      const durationSec = samples.length / sampleRate;
      const {rms, peak} = audioStats(samples);
      process.stdout.write(
        `synth=${synthMs}ms dur=${durationSec.toFixed(2)}s rms=${rms.toFixed(3)} `,
      );

      if (args.skipWhisper) {
        rows.push({
          lang,
          input: sentence,
          durationSec,
          rms,
          peak,
          detectedLang: null,
          langMatch: null,
          forcedFallback: false,
          transcript: '',
          similarity: null,
          pass: null,
        });
        process.stdout.write('(whisper skipped)\n');
        continue;
      }

      const asrStart = Date.now();
      const {detectedLang, transcript, forcedFallback} = runWhisper(
        wavPath,
        lang,
      );
      const asrMs = Date.now() - asrStart;
      const langMatch = detectedLang === lang;
      const sim = similarity(sentence, transcript);
      // Pass criteria: transcript content close enough AND audio non-silent.
      // We DON'T require Whisper auto-detect to land on the right language
      // — it confuses close-neighbor pairs (et/es, sl/hr, sk/cs) on short
      // utterances. The forced-language retry's transcript is the real
      // signal that synthesis produced the right sounds.
      const pass = sim >= 0.6 && rms > 0.01;
      rows.push({
        lang,
        input: sentence,
        durationSec,
        rms,
        peak,
        detectedLang,
        langMatch,
        forcedFallback,
        transcript,
        similarity: sim,
        pass,
      });
      const flag = forcedFallback ? '⚑' : '';
      process.stdout.write(
        `whisper=${asrMs}ms detected=${detectedLang ?? '?'}${flag} sim=${sim.toFixed(2)} ${pass ? '✓' : '✗'}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({
        lang,
        input: sentence,
        durationSec: 0,
        rms: 0,
        peak: 0,
        detectedLang: null,
        langMatch: null,
        forcedFallback: false,
        transcript: '',
        similarity: null,
        pass: false,
        error: msg,
      });
      process.stdout.write(`ERROR ${msg}\n`);
    }
  }

  // ---------- Markdown report ----------
  const reportPath = path.join(OUT_DIR, 'report.md');
  const lines: string[] = [];
  lines.push(`# Supertonic v3 multilingual verification`);
  lines.push('');
  lines.push(
    `Voice: \`${args.voice}\` · Steps: ${args.steps} · ${rows.length} languages`,
  );
  lines.push('');
  const passed = rows.filter(r => r.pass === true).length;
  const failed = rows.filter(r => r.pass === false).length;
  const skipped = rows.filter(r => r.pass === null).length;
  lines.push(
    `**Summary:** ${passed} passed, ${failed} failed, ${skipped} skipped.`,
  );
  lines.push('');
  const fallbacks = rows.filter(r => r.forcedFallback).length;
  if (fallbacks > 0) {
    lines.push(
      `⚑ = Whisper auto-detect picked the wrong language; transcript reflects forced-language retry. ${fallbacks} language${fallbacks === 1 ? '' : 's'} hit this fallback.`,
    );
    lines.push('');
  }
  lines.push(
    '| Lang | Pass | Detected (auto) | Sim | Dur (s) | RMS | Input | Transcript |',
  );
  lines.push(
    '|------|------|-----------------|-----|---------|------|-------|------------|',
  );
  for (const r of rows) {
    const pass = r.error
      ? '⚠️ ERR'
      : r.pass === true
        ? '✅'
        : r.pass === false
          ? '❌'
          : '–';
    const det = r.detectedLang
      ? r.forcedFallback
        ? `${r.detectedLang} ⚑`
        : r.detectedLang
      : '?';
    lines.push(
      `| ${r.lang} | ${pass} | ${det} | ${
        r.similarity !== null ? r.similarity.toFixed(2) : '–'
      } | ${r.durationSec.toFixed(2)} | ${r.rms.toFixed(3)} | ${r.input.replace(/\|/g, '\\|')} | ${r.transcript.replace(/\|/g, '\\|') || (r.error ?? '')} |`,
    );
  }
  writeFileSync(reportPath, lines.join('\n') + '\n');
  console.log(`\nReport: ${reportPath}`);
  console.log(`WAVs:   ${OUT_DIR}/<lang>.wav`);

  if (failed > 0 && !args.skipWhisper) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
