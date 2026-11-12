/**
 * IOSF evidence harness (not committed). Deep link:
 *   speechexample://evidence/iosf?label=X&mode=during|gap|stopduring|neural&ducking=1|0&runs=N
 * The runner starts a Clock timer (LENGTH=1) when it sees "[IOSF] FIRE <run>"
 * and force-stops the Clock app 4 s later (focus comes back). Every native and
 * interruption event is logged with Date.now().
 *   during:      OS stream; FIRE 1.5 s into the first sentence; Speech.resume() after `ended`.
 *   gap:         OS stream; sentence 1, then FIRE once it has finished (queue drained,
 *                focus held by the idle grace); sentence 2 appended 7 s later.
 *   stopduring:  OS stream; FIRE 1.5 s into sentence 1; stream.cancel() 1 s after `began`.
 *   neural:      Kitten speak(); FIRE 1.5 s after its first onStart; Speech.resume() after `ended`.
 *   plain:       OS stream of both sentences, no timer (iOS smoke of ducking/silentMode).
 *   gapappend:   OS stream; sentence 1, FIRE after it finished, sentence 2 appended 1 s after
 *                `began` (alarm still ringing); Speech.resume() after `ended`.
 *   noresume:    as during, but no resume: CHECK (runner dumps the focus stack) 7 s after `ended`.
 *   apppause:    OS stream; Speech.pause() 1.5 s into sentence 1, sentence 2 appended while paused,
 *                CHECK 7 s later, then Speech.resume(). No timer.
 */
import Speech, {
  TTSEngine,
  onAudioInterruption,
} from '@pocketpalai/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {kittenModelManager} from './utils/KittenModelManager';
import {phonemizerDictManager} from './utils/PhonemizerDictManager';

const S1 =
  'The river ran past the old mill where the children used to play every summer afternoon, and the water was always cold. ';
const S2 = 'At night the river was calm and the lights of the town were reflected in it. ';
const KITTEN_TEXT = S1 + S2;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const TRACE = `${RNFS.DocumentDirectoryPath}/iosf-trace.log`;
const out = (s: string) => {
  console.log('[IOSF] ' + s);
  RNFS.appendFile(TRACE, '[IOSF] ' + s + '\n', 'utf8').catch(() => {});
};
function q(url: string, k: string): string | null {
  const m = new RegExp('[?&]' + k + '=([^&]*)').exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function isIOSFEvidenceUrl(url: string | null | undefined) {
  return !!url && url.startsWith('speechexample://evidence/iosf');
}

async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) {
    await wait(20);
  }
  return cond();
}

export async function runIOSFEvidence(url: string): Promise<void> {
  const label = q(url, 'label') ?? 'x';
  const mode = q(url, 'mode') ?? 'during';
  const ducking = q(url, 'ducking') !== '0';
  const runs = Number(q(url, 'runs') ?? '3');
  const ev: string[] = [];
  const rec = (s: string) => {
    ev.push(s);
    out(`E ${Date.now()} ${s}`);
  };
  const has = (p: string) => ev.some(l => l.startsWith(p));
  const subs = [
    Speech.onStart(e => rec(`onStart id=${e.id}`)),
    Speech.onFinish(e => rec(`onFinish id=${e.id}`)),
    Speech.onStopped(e => rec(`onStopped id=${e.id}`)),
    Speech.onPause(e => rec(`onPause id=${e.id}`)),
    Speech.onResume(e => rec(`onResume id=${e.id}`)),
    onAudioInterruption(e =>
      rec(`interruption ${e.type} shouldResume=${e.shouldResume}`),
    ),
  ];
  try {
    await wait(6000);
    if (mode === 'neural') {
      const dictPath = await phonemizerDictManager.ensureDict('en-us');
      await kittenModelManager.scanInstalledModel();
      if (!kittenModelManager.getInstalledModel()) {
        out('downloading Kitten model');
        await kittenModelManager.downloadModel();
        await kittenModelManager.scanInstalledModel();
      }
      await Speech.initialize({
        engine: TTSEngine.KITTEN,
        ...kittenModelManager.getDownloadedModelConfig(),
        dictPath,
        ducking,
      } as any);
    } else {
      const silentMode = q(url, 'silentMode') ?? undefined;
      await Speech.initialize({
        engine: TTSEngine.OS_NATIVE,
        ducking,
        silentMode,
      } as any);
    }
    out(
      `START label=${label} mode=${mode} ducking=${ducking} engine=${Speech.getCurrentEngineId()} runs=${runs}`,
    );
    for (let r = 0; r < runs; r++) {
      ev.length = 0;
      out(`RUN_BEGIN ${r}`);
      if (mode === 'neural') {
        const done = Speech.speak(KITTEN_TEXT);
        await until(() => has('onStart'), 30000);
        await wait(1500);
        out(`FIRE ${r}`);
        if (await until(() => has('interruption ended'), 20000)) {
          await wait(500);
          rec('resume call');
          await Speech.resume();
        }
        await Promise.race([done, wait(60000)]);
        rec('speak resolved');
      } else {
        const stream = Speech.createSpeechStream();
        stream.onProgress(e => rec(`streamProgress batch=${e.batchIndex}`));
        stream.append(S1);
        if (mode === 'plain') {
          stream.append(S2);
        } else if (mode === 'gapappend') {
          await until(() => has('onFinish'), 30000);
          rec('gap begins');
          out(`FIRE ${r}`);
          if (await until(() => has('interruption began'), 10000)) {
            await wait(1000);
            rec('append S2');
            stream.append(S2);
          }
          if (await until(() => has('interruption ended'), 20000)) {
            await wait(500);
            rec('resume call');
            rec(`resume -> ${await Speech.resume()}`);
          }
        } else if (mode === 'apppause') {
          await until(() => has('onStart'), 20000);
          await wait(1500);
          rec(`pause -> ${await Speech.pause()}`);
          await wait(500);
          rec('append S2');
          stream.append(S2);
          await wait(7000);
          out(`CHECK ${r}`);
          await wait(1500);
          rec(`resume -> ${await Speech.resume()}`);
        } else if (mode === 'gap') {
          await until(() => has('onFinish'), 30000);
          rec('gap begins');
          out(`FIRE ${r}`);
          await wait(7000);
          rec('append S2');
          stream.append(S2);
        } else {
          stream.append(S2);
          await until(() => has('onStart'), 20000);
          await wait(1500);
          out(`FIRE ${r}`);
          if (mode === 'stopduring') {
            if (await until(() => has('interruption began'), 10000)) {
              await wait(1000);
              rec('cancel call');
              await stream.cancel();
              rec('cancel resolved');
            }
          } else if (await until(() => has('interruption ended'), 20000)) {
            if (mode === 'noresume') {
              await wait(7000);
              out(`CHECK ${r}`);
              await wait(1500);
              rec('cancel call');
              await stream.cancel();
            } else {
              await wait(500);
              rec('resume call');
              rec(`resume -> ${await Speech.resume()}`);
            }
          }
        }
        const fin = stream.finalize().then(() => rec('finalize resolved'));
        await Promise.race([fin, wait(60000)]);
      }
      await wait(mode === 'stopduring' ? 8000 : 2000);
      rec('settled');
      out(`RUN_END ${r}`);
      await wait(6500); // past the 5 s idle release
    }
    out('DONE');
  } catch (e) {
    out(`ERROR ${e}`);
  } finally {
    subs.forEach(s => s.remove());
  }
}
