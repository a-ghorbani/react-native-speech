/**
 * I115 evidence harness (throwaway, do not merge). Deep link:
 *   speechexample://evidence/i115?label=X&engine=supertonic|kokoro|kitten
 *     &ver=v3|v2 (kokoro: quantized|full|fp16|q8)&eps=default|cpu|cml:<hex flags>&steps=5&voice=F1
 * One run per fresh process. Samples phys_footprint (what jetsam counts) every
 * 150 ms and appends every line to Documents/i115-trace.log right away, so the
 * last samples survive a jetsam kill.
 */
import * as RNFS from '@dr.pogodin/react-native-fs';
import Speech, {TTSEngine} from '@pocketpalai/react-native-speech';
import type {ExecutionProvider} from '@pocketpalai/react-native-speech';
import {NeuralAudioPlayer} from '../../src/engines/NeuralAudioPlayer';
import {SupertonicEngine} from '../../src/engines/supertonic/SupertonicEngine';
import {KokoroEngine} from '../../src/engines/kokoro/KokoroEngine';
import {KittenEngine} from '../../src/engines/kitten/KittenEngine';
import RNBenchmark from './benchmark/NativeBenchmark';
import {supertonicModelManager} from './utils/SupertonicModelManager';
import {kokoroModelManager} from './utils/ModelManager';
import {kittenModelManager} from './utils/KittenModelManager';
import {phonemizerDictManager} from './utils/PhonemizerDictManager';
import {ENGLISH_DEFAULT_TEXT} from './utils/sampleText';

const FILE = `${RNFS.DocumentDirectoryPath}/i115-trace.log`;
let queue = Promise.resolve();
const log = (line: string) => {
  const text = `[I115] ${Date.now()} ${line}`;
  console.log(text);
  queue = queue
    .then(() => RNFS.appendFile(FILE, text + '\n', 'utf8'))
    .catch(() => {});
};
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const q = (url: string, k: string) => {
  const m = new RegExp('[?&]' + k + '=([^&]*)').exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
};

export const isI115EvidenceUrl = (url: string | null | undefined) =>
  !!url && url.startsWith('speechexample://evidence/i115');

let phase = 'idle';
const peaks: Record<string, number> = {};
let t0 = 0;
let firstPlay = 0;
let synthMs = 0;
let audioS = 0;
let chunks = 0;

function wrapSynth(proto: any, name: string) {
  const orig = proto[name];
  proto[name] = async function (...args: unknown[]) {
    const s = Date.now();
    const buf = await orig.apply(this, args);
    const ms = Date.now() - s;
    const sec = buf?.samples ? buf.samples.length / buf.sampleRate : 0;
    synthMs += ms;
    audioS += sec;
    chunks++;
    log(`SYNTH n=${chunks} ms=${ms} audio_s=${sec.toFixed(3)}`);
    return buf;
  };
}
wrapSynth(SupertonicEngine.prototype, 'synthesizeChunk');
wrapSynth(KokoroEngine.prototype, 'synthesizeTextChunk');
wrapSynth(KittenEngine.prototype, 'synthesizeTextChunk');

const origPlay = NeuralAudioPlayer.prototype.play;
NeuralAudioPlayer.prototype.play = async function (buffer, options, ...rest) {
  if (!firstPlay && t0) {
    firstPlay = Date.now();
    log(`FIRST_AUDIO ms=${firstPlay - t0}`);
  }
  return (origPlay as any).call(this, buffer, options, ...rest);
};

function parseEps(eps: string): ExecutionProvider[] | undefined {
  if (eps === 'default') return undefined;
  if (eps === 'cpu') return ['xnnpack', 'cpu'];
  if (eps === 'cpuonly') return ['cpu'];
  if (eps.startsWith('cml:')) {
    return [
      {name: 'coreml', coreMlFlags: parseInt(eps.slice(4), 16)},
      'xnnpack',
      'cpu',
    ];
  }
  throw new Error(`bad eps ${eps}`);
}

async function configFor(engine: string, ver: string) {
  if (engine === 'supertonic') {
    const v = ver as 'v2' | 'v3';
    if (!(await supertonicModelManager.isModelInstalled(v))) {
      log(`DOWNLOAD supertonic ${v}`);
      await supertonicModelManager.downloadModel(undefined, v);
    }
    return {
      engine: TTSEngine.SUPERTONIC,
      ...supertonicModelManager.getDownloadedModelConfig(v),
      maxChunkSize: 200,
    };
  }
  if (engine === 'kokoro') {
    // ver = Kokoro variant: quantized (int8) | full (fp32) | fp16 | q8 (q8f16).
    const variant = (
      ['full', 'fp16', 'q8'].includes(ver) ? ver : 'quantized'
    ) as 'quantized' | 'full' | 'fp16' | 'q8';
    await kokoroModelManager.scanInstalledModels();
    if (
      !kokoroModelManager.getInstalledModels().some(x => x.variant === variant)
    ) {
      log(`DOWNLOAD kokoro ${variant}`);
      await kokoroModelManager.downloadModel(variant);
      await kokoroModelManager.scanInstalledModels();
    }
    const m = kokoroModelManager
      .getInstalledModels()
      .find(x => x.variant === variant)!;
    log(`MODEL kokoro ${m.version}-${m.variant}`);
    return {
      engine: TTSEngine.KOKORO,
      ...kokoroModelManager.getDownloadedModelConfig(m.version, m.variant),
      dictPath: await phonemizerDictManager.ensureDict('en-us'),
      phonemizerType: 'js' as const,
      maxChunkSize: 100,
    };
  }
  await kittenModelManager.scanInstalledModel();
  if (!kittenModelManager.getInstalledModel()) {
    log('DOWNLOAD kitten');
    await kittenModelManager.downloadModel();
    await kittenModelManager.scanInstalledModel();
  }
  log(`MODEL kitten ${kittenModelManager.getInstalledModel()?.variant}`);
  return {
    engine: TTSEngine.KITTEN,
    ...kittenModelManager.getDownloadedModelConfig(),
    dictPath: await phonemizerDictManager.ensureDict('en-us'),
    maxChunkSize: 500,
  };
}

export async function runI115Evidence(url: string): Promise<void> {
  const label = q(url, 'label') ?? 'x';
  const engine = q(url, 'engine') ?? 'supertonic';
  const ver = q(url, 'ver') ?? 'v3';
  const eps = q(url, 'eps') ?? 'default';
  const steps = Number(q(url, 'steps') ?? '5');
  const voiceArg = q(url, 'voice');
  const initOnly = q(url, 'mode') === 'init';
  let limitMB = 0;
  const sampler = setInterval(async () => {
    try {
      const m = await RNBenchmark.getMemoryStats();
      const foot = m.nativeHeapAllocatedMB;
      if (!limitMB) limitMB = foot + m.availableMemoryMB;
      peaks[phase] = Math.max(peaks[phase] ?? 0, foot);
      log(
        `MEM phase=${phase} foot_mb=${foot.toFixed(0)} avail_mb=${m.availableMemoryMB.toFixed(0)}`,
      );
    } catch {}
  }, 150);
  try {
    log(`START label=${label} engine=${engine} ver=${ver} eps=${eps}`);
    // The example initializes its own engine at launch; let it finish, then
    // release it so the baseline holds no model.
    await wait(8000);
    await Speech.release();
    await wait(1500);
    phase = 'baseline';
    await wait(1500);
    const config = await configFor(engine, ver);
    const executionProviders = parseEps(eps);
    log(`EPS ${JSON.stringify(executionProviders ?? 'library default')}`);
    phase = 'init';
    const i0 = Date.now();
    let initMs = 0;
    await Speech.initialize({
      ...config,
      silentMode: 'ignore',
      ...(executionProviders ? {executionProviders} : {}),
    } as any);
    initMs = Date.now() - i0;
    log(`INIT_DONE ms=${initMs}`);
    phase = 'postinit';
    await wait(1000);
    if (initOnly) {
      log(
        `SUMMARY label=${label} ok=1 init_only=1 init_ms=${initMs} limit_mb=${limitMB.toFixed(0)} peaks=${JSON.stringify(peaks)}`,
      );
      return;
    }
    const voices = await Speech.getVoices();
    const voice =
      voiceArg ?? (engine === 'supertonic' ? 'F1' : voices[0]) ?? '';
    phase = 'speak';
    t0 = Date.now();
    log(`SPEAK voice=${voice} steps=${steps}`);
    await Speech.speak(ENGLISH_DEFAULT_TEXT, voice, {
      inferenceSteps: steps,
    } as any);
    log(`SPEAK_RESOLVED ms=${Date.now() - t0}`);
    phase = 'done';
    await wait(1500);
    const rtf = audioS ? synthMs / 1000 / audioS : NaN;
    log(
      `SUMMARY label=${label} ok=1 init_ms=${initMs} first_audio_ms=${firstPlay ? firstPlay - t0 : -1} ` +
        `synth_ms=${synthMs} audio_s=${audioS.toFixed(2)} rtf=${rtf.toFixed(3)} chunks=${chunks} ` +
        `limit_mb=${limitMB.toFixed(0)} peaks=${JSON.stringify(
          Object.fromEntries(
            Object.entries(peaks).map(([k, v]) => [k, Math.round(v)]),
          ),
        )}`,
    );
  } catch (e) {
    log(`ERROR ${String(e)}`);
  } finally {
    clearInterval(sampler);
    log('DONE');
  }
}
