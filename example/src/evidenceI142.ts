/**
 * I142 evidence harness (not committed to the PR). Deep link:
 *   speechexample://evidence/i142?label=X&mode=plain|stop|stall|osneural|interrupt&ducking=1|0&silentMode=obey|respect|ignore&runs=N
 * Every speech/interruption event is appended to Documents/i142-trace.log with Date.now().
 * The trace branches also patch RNSpeech.mm to append `DUCK activate|deactivate-begin|deactivate-end <ms>`
 * to Documents/i142-native.log (same clock).
 *   plain:     OS stream of 4 sentences at once; finalize; wait 8 s (past the 5 s grace).
 *   stop:      OS stream of 4 sentences; stream.cancel() 1.5 s into sentence 2; wait 8 s.
 *   stall:     S1; S2 appended 2 s after S1 finished (inside the grace); S3 appended 7 s after
 *              S2 finished (after the grace); finalize; wait 8 s.
 *   osneural:  OS S1 (ducking), then at its onFinish Kitten speaks S2+S3 with the same ducking; wait 8 s.
 *   stopspeak: 4 sentences; stream.cancel() 1.5 s into sentence 2, then at once Speech.speak(S4);
 *              logs `speak call` and its onStart (stop -> next speech latency); wait 8 s.
 *   stopgrace: as plain, then Speech.stop() 2 s after the last onFinish (inside the grace); wait 8 s.
 *   pause:     4 sentences; Speech.pause() 1.5 s into sentence 2, Speech.resume() 2 s later; finalize.
 *   interrupt: as plain, prints FIRE 1.5 s into sentence 2 (runner fires a timer/alarm); after
 *              `ended`, Speech.resume(); finalize; wait 8 s.
 */
import Speech, {
  TTSEngine,
  onAudioInterruption,
} from '@pocketpalai/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {kittenModelManager} from './utils/KittenModelManager';
import {phonemizerDictManager} from './utils/PhonemizerDictManager';

const S = [
  'The river ran past the old mill where the children used to play. ',
  'At night the river was calm and the lights of the town were reflected in it. ',
  'In the morning the fishermen came down to the water with their nets. ',
  'By noon the market by the bridge was full of people and noise. ',
];

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const TRACE = `${RNFS.DocumentDirectoryPath}/i142-trace.log`;
const out = (s: string) => {
  console.log('[I142] ' + s);
  RNFS.appendFile(TRACE, '[I142] ' + s + '\n', 'utf8').catch(() => {});
};
function q(url: string, k: string): string | null {
  const m = new RegExp('[?&]' + k + '=([^&]*)').exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function isI142EvidenceUrl(url: string | null | undefined) {
  return !!url && url.startsWith('speechexample://evidence/i142');
}

async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) {
    await wait(20);
  }
  return cond();
}

export async function runI142Evidence(url: string): Promise<void> {
  const label = q(url, 'label') ?? 'x';
  const mode = q(url, 'mode') ?? 'plain';
  const ducking = q(url, 'ducking') !== '0';
  const silentMode = q(url, 'silentMode') ?? undefined;
  const runs = Number(q(url, 'runs') ?? '2');
  const ev: string[] = [];
  const rec = (s: string) => {
    ev.push(s);
    out(`E ${Date.now()} ${s}`);
  };
  const count = (p: string) => ev.filter(l => l.startsWith(p)).length;
  const has = (p: string) => count(p) > 0;
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
  const initOS = async () => {
    for (let i = 0; i < 3; i++) {
      await Speech.initialize({
        engine: TTSEngine.OS_NATIVE,
        ducking,
        silentMode,
      } as any);
      await wait(500);
      if (Speech.getCurrentEngineId() === TTSEngine.OS_NATIVE) {
        break;
      }
    }
  };
  try {
    (globalThis as any).__I142_KEEP_ENGINE = true;
    await wait(6000);
    await initOS();
    out(
      `START label=${label} mode=${mode} ducking=${ducking} silentMode=${silentMode} engine=${Speech.getCurrentEngineId()} runs=${runs}`,
    );
    for (let r = 0; r < runs; r++) {
      ev.length = 0;
      out(`RUN_BEGIN ${r}`);
      if (mode === 'osneural') {
        await initOS();
        const s1 = Speech.speak(S[0]!);
        await s1;
        await until(() => has('onFinish'), 30000);
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
        rec(`neural speak engine=${Speech.getCurrentEngineId()}`);
        await Promise.race([Speech.speak(S[1]! + S[2]!), wait(60000)]);
        rec('neural speak resolved');
      } else {
        const stream = Speech.createSpeechStream();
        stream.onProgress(e => rec(`streamProgress batch=${e.batchIndex}`));
        if (mode === 'stall') {
          stream.append(S[0]!);
          await until(() => count('onFinish') >= 1, 30000);
          await wait(2000);
          rec('append S2');
          stream.append(S[1]!);
          await until(() => count('onFinish') >= 2, 30000);
          await wait(7000);
          rec('append S3');
          stream.append(S[2]!);
        } else {
          S.forEach(s => stream.append(s));
          if (mode === 'stopgrace') {
            await stream.finalize();
            await until(() => count('onFinish') >= 4, 30000);
            await wait(2000);
            rec('stop call');
            await Speech.stop();
            rec('stop resolved');
          } else if (mode === 'pause') {
            await until(() => count('onStart') >= 2, 30000);
            await wait(1500);
            rec(`pause -> ${await Speech.pause()}`);
            await wait(2000);
            rec(`resume -> ${await Speech.resume()}`);
          } else if (mode === 'stopspeak') {
            await until(() => count('onStart') >= 2, 30000);
            await wait(1500);
            rec('cancel call');
            await stream.cancel();
            rec('speak call');
            const spoken = Speech.speak(S[3]!);
            await spoken;
            rec('speak resolved');
            await until(() => count('onFinish') >= 2, 30000);
          } else if (mode === 'stop' || mode === 'interrupt') {
            await until(() => count('onStart') >= 2, 30000);
            await wait(1500);
            if (mode === 'stop') {
              rec('cancel call');
              await stream.cancel();
              rec('cancel resolved');
            } else {
              out(`FIRE ${r}`);
              if (await until(() => has('interruption ended'), 30000)) {
                await wait(500);
                rec(`resume -> ${await Speech.resume()}`);
              }
            }
          }
        }
        if (mode !== 'stop' && mode !== 'stopspeak' && mode !== 'stopgrace') {
          const fin = stream.finalize().then(() => rec('finalize resolved'));
          await Promise.race([fin, wait(90000)]);
        }
      }
      rec('settled');
      await wait(8000); // past the 5 s idle grace
      out(`RUN_END ${r}`);
    }
    out('DONE');
  } catch (e) {
    out(`ERROR ${e}`);
  } finally {
    (globalThis as any).__I142_KEEP_ENGINE = false;
    subs.forEach(s => s.remove());
  }
}
