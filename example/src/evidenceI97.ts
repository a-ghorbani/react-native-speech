/**
 * I97 evidence harness (not committed). Deep link:
 *   speechexample://evidence/i97?label=base|branch&engine=kitten|kokoro-fp32&mode=<m>&runs=N&delay=1200
 * modes:
 *   speakstop     speak(A), <delay> ms after A's first onStart: await Speech.stop(), speak(B)
 *   streamstop    stream(A), same, then await Speech.stop(), speak(B)
 *   streamreplace stream(A), same, then a new stream(B) (no stop)
 *   gaps          stream(A) alone to the end (inter-chunk gaps, #93)
 *   idle          speak(B) with nothing running (first audio from idle)
 *   release       speak(A), <delay> ms after A's first onStart: Speech.release(), initialize again, speak(B) (#59)
 * abort=0|1: I97 prototype off/on (globalThis.__i97abort, see abort-patch.py)
 * Logs run markers and native events; the probe patch (probe.sh) logs
 * synthesis, inference start/end and play calls.
 */
import Speech, {TTSEngine} from '@pocketpalai/react-native-speech';
import {kittenModelManager} from './utils/KittenModelManager';
import {kokoroModelManager} from './utils/ModelManager';
import {phonemizerDictManager} from './utils/PhonemizerDictManager';

const A =
  'The river ran past the old mill where the children used to play every summer afternoon. ' +
  'Along the river bank there were tall trees that gave shade to anyone who walked by slowly. ' +
  'In spring the river rose and covered the low fields with cold brown water for many weeks. ' +
  'Fishermen came to the river at dawn and sat quietly on the wooden pier until the sun rose. ' +
  'At night the river was calm and the lights of the small town were reflected in the water. ';
const B =
  'The mountain road climbed through the forest toward a small village near the top. ' +
  'From the mountain pass you could see the whole valley spread out below in the sun. ';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (s: string) => console.log('[I97EV] ' + s);
function q(url: string, k: string): string | null {
  const m = new RegExp('[?&]' + k + '=([^&]*)').exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function isI97EvidenceUrl(url: string | null | undefined) {
  return !!url && url.startsWith('speechexample://evidence/i97');
}

function start(kind: 'speak' | 'stream', text: string): Promise<void> {
  if (kind === 'speak') {
    return Speech.speak(text);
  }
  const s = Speech.createSpeechStream();
  // Token-ish deltas like an LLM reply.
  const words = text.split(/(?<= )/);
  return (async () => {
    for (let i = 0; i < words.length; i += 3) {
      s.append(words.slice(i, i + 3).join(''));
      await wait(30);
    }
    await s.finalize();
  })();
}

async function init(engine: string, maxChunkSize: number, ep = 'default') {
  const dictPath = await phonemizerDictManager.ensureDict('en-us');
  let cfg: any;
  if (engine === 'kokoro-fp32' || engine === 'kokoro-int8') {
    const variant = engine === 'kokoro-fp32' ? 'full' : 'quantized';
    await kokoroModelManager.scanInstalledModels();
    const pick = () =>
      kokoroModelManager.getInstalledModels().find(x => x.variant === variant);
    if (!pick()) {
      log('downloading Kokoro ' + variant + ' model');
      await kokoroModelManager.downloadModel(variant as any);
      await kokoroModelManager.scanInstalledModels();
    }
    const m = pick()!;
    cfg = {
      engine: TTSEngine.KOKORO,
      ...kokoroModelManager.getDownloadedModelConfig(m.version, m.variant as any),
      dictPath,
      phonemizerType: 'js',
    };
  } else {
    await kittenModelManager.scanInstalledModel();
    if (!kittenModelManager.getInstalledModel()) {
      log('downloading Kitten model');
      await kittenModelManager.downloadModel();
      await kittenModelManager.scanInstalledModel();
    }
    cfg = {
      engine: TTSEngine.KITTEN,
      ...kittenModelManager.getDownloadedModelConfig(),
      dictPath,
    };
  }
  await Speech.release().catch(() => undefined);
  if (ep === 'cpu') {
    cfg.executionProviders = ['cpu'];
  }
  await Speech.initialize({
    ...cfg,
    silentMode: 'obey',
    ducking: true,
    maxChunkSize,
  });
}

export async function runI97Evidence(url: string): Promise<void> {
  const label = q(url, 'label') ?? 'x';
  const engine = q(url, 'engine') ?? 'kitten';
  const mode = q(url, 'mode') ?? 'streamstop';
  const runs = Number(q(url, 'runs') ?? '10');
  const delay = Number(q(url, 'delay') ?? '1200');
  const max = Number(q(url, 'max') ?? '120');
  const abort = q(url, 'abort') === '1';
  const ep = q(url, 'ep') ?? 'default';
  (globalThis as any).__i97abort = abort;
  const first: 'speak' | 'stream' = mode === 'speakstop' ? 'speak' : 'stream';
  const second: 'speak' | 'stream' =
    mode === 'streamreplace' ? 'stream' : 'speak';
  // bg: RootView skips its background release; the runner turns the screen off mid-stream.
  (globalThis as any).__i97bg = mode === 'bg';
  log(
    `START label=${label} engine=${engine} mode=${mode} runs=${runs} delay=${delay} max=${max} ep=${ep}`,
  );
  const events: string[] = [];
  const subs = [
    Speech.onStart(() => events.push(`start@${Date.now()}`)),
    Speech.onFinish(() => events.push(`finish@${Date.now()}`)),
    Speech.onStopped(() => events.push(`stopped@${Date.now()}`)),
  ];
  try {
    await init(engine, max, ep);
    await Speech.speak('Warm up.');
    await wait(800);
    for (let r = 1; r <= runs; r++) {
      events.length = 0;
      const t0 = Date.now();
      log(`RUN_BEGIN label=${label} engine=${engine} mode=${mode} run=${r} t=${t0}`);
      let aSettled = 'pending';
      const aDone = (mode === 'idle' ? Promise.resolve() : start(first, mode === 'bg' ? A + A : A)).then(
        () => (aSettled = `resolved@${Date.now()}`),
        e => (aSettled = `rejected@${Date.now()}:${String(e)}`),
      );
      let tB = 0;
      let tBEnd = 0;
      let bErr = '';
      if (mode === 'idle') {
        aSettled = 'none';
        await wait(300);
        tB = Date.now();
        await start('speak', B).catch(e => (bErr = String(e)));
        tBEnd = Date.now();
      } else if (mode === 'gaps' || mode === 'bg') {
        await Promise.race([aDone, wait(90000)]);
      } else {
        for (let i = 0; i < 3000 && !events.some(e => e.startsWith('start')); i++) {
          await wait(5);
        }
        await wait(delay);
        tB = Date.now();
        if (mode === 'release') {
          const r0 = Date.now();
          const res = await Speech.release();
          const r1 = Date.now();
          await init(engine, max, ep);
          log(`RELEASE ms=${r1 - r0} reinit_ms=${Date.now() - r1} result=${JSON.stringify(res)}`);
        } else if (mode !== 'streamreplace') {
          await Speech.stop();
        }
        await start(second, B).catch(e => (bErr = String(e)));
        tBEnd = Date.now();
        await Promise.race([aDone, wait(30000)]);
      }
      await wait(1500);
      log(
        `RUN_END label=${label} engine=${engine} mode=${mode} run=${r} t0=${t0} tB=${tB} tBEnd=${tBEnd} a=${aSettled} bErr=${bErr} events=${JSON.stringify(events)}`,
      );
      await wait(500);
    }
    log('DONE');
  } catch (e) {
    log('ERROR ' + String(e));
  } finally {
    subs.forEach(s => s.remove());
  }
}
