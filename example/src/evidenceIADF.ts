/**
 * IADF evidence harness (throwaway branches only). Deep link:
 *   speechexample://evidence/iadf?label=X&ducking=1|0|none&call=none|0|1&mode=speak|stream&runs=N
 * Kitten is initialized with `ducking` from the link (none = left out); each
 * run speaks two sentences via speak() or createSpeechStream(), with no
 * per-call ducking unless `call` is 0/1. Events go to Documents/iadf-trace.log.
 */
import Speech, {TTSEngine} from '@pocketpalai/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {kittenModelManager} from './utils/KittenModelManager';
import {phonemizerDictManager} from './utils/PhonemizerDictManager';

const TEXT =
  'The river ran past the old mill where the children used to play every summer afternoon, and the water was always cold. ' +
  'At night the river was calm and the lights of the town were reflected in it. ';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const TRACE = `${RNFS.DocumentDirectoryPath}/iadf-trace.log`;
const out = (s: string) => {
  console.log('[IADF] ' + s);
  RNFS.appendFile(TRACE, '[IADF] ' + s + '\n', 'utf8').catch(() => {});
};
function q(url: string, k: string): string | null {
  const m = new RegExp('[?&]' + k + '=([^&]*)').exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function isIADFEvidenceUrl(url: string | null | undefined) {
  return !!url && url.startsWith('speechexample://evidence/iadf');
}

export async function runIADFEvidence(url: string): Promise<void> {
  const label = q(url, 'label') ?? 'x';
  const mode = q(url, 'mode') ?? 'speak';
  const d = q(url, 'ducking') ?? '1';
  const c = q(url, 'call') ?? 'none';
  const runs = Number(q(url, 'runs') ?? '3');
  const initAudio = d === 'none' ? {} : {ducking: d === '1'};
  const callOpts = c === 'none' ? undefined : {ducking: c === '1'};
  const subs = [
    Speech.onStart(e => out(`E ${Date.now()} onStart id=${e.id}`)),
    Speech.onFinish(e => out(`E ${Date.now()} onFinish id=${e.id}`)),
    Speech.onStopped(e => out(`E ${Date.now()} onStopped id=${e.id}`)),
  ];
  try {
    (globalThis as any).__IOSF_KEEP_ENGINE = true;
    await wait(6000);
    const dictPath = await phonemizerDictManager.ensureDict('en-us');
    await kittenModelManager.scanInstalledModel();
    if (!kittenModelManager.getInstalledModel()) {
      out('downloading Kitten model');
      await kittenModelManager.downloadModel();
      await kittenModelManager.scanInstalledModel();
    }
    // The example's own startup initialize() can supersede this one: retry until Kitten is current.
    for (let i = 0; i < 5; i++) {
      await Speech.initialize({
        engine: TTSEngine.KITTEN,
        ...kittenModelManager.getDownloadedModelConfig(),
        dictPath,
        ...initAudio,
      } as any);
      await wait(1000);
      if (Speech.getCurrentEngineId() === TTSEngine.KITTEN) break;
    }
    out(
      `START label=${label} mode=${mode} init=${JSON.stringify(initAudio)} call=${JSON.stringify(callOpts ?? null)} engine=${Speech.getCurrentEngineId()} runs=${runs}`,
    );
    for (let r = 0; r < runs; r++) {
      out(`RUN_BEGIN ${r} ${Date.now()}`);
      if (mode === 'stream') {
        const stream = Speech.createSpeechStream(undefined, callOpts);
        stream.append(TEXT);
        await Promise.race([stream.finalize(), wait(60000)]);
      } else {
        await Promise.race([
          Speech.speak(TEXT, undefined, callOpts),
          wait(60000),
        ]);
      }
      out(`RUN_END ${r} ${Date.now()}`);
      await wait(3000);
    }
    out('DONE');
  } catch (e) {
    out(`ERROR ${e}`);
  } finally {
    subs.forEach(s => s.remove());
  }
}
