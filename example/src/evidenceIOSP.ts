/**
 * IOSP evidence harness (not committed). Deep link:
 *   speechexample://evidence/iosp?label=X&mode=seq|stream|stop&voice=local|network|default&runs=N&stopAt=2500
 * Drives the OS engine and logs every native event with Date.now() so it can
 * be lined up with the TTS engine's AudioTrack started/stopped events from
 * `dumpsys audio` (playback activity log).
 */
import Speech, {TTSEngine} from '@pocketpalai/react-native-speech';
import * as RNFS from '@dr.pogodin/react-native-fs';

const SENTENCES = [
  'The river ran past the old mill where the children used to play every summer afternoon. ',
  'Along the bank there were tall trees that gave shade to anyone walking by. ',
  'In spring the water rose, and it covered the low fields for many weeks. ',
  'Fishermen came at dawn and sat quietly on the wooden pier. ',
  'At night the river was calm. ',
  'The lights of the town were reflected in the water until morning came. ',
];

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// Also kept in Documents/iosp-trace.log: iOS Release builds drop console lines.
const TRACE = `${RNFS.DocumentDirectoryPath}/iosp-trace.log`;
let traceBuf: string[] = [];
const out = (s: string) => {
  console.log('[IOSP] ' + s);
  traceBuf.push('[IOSP] ' + s);
};
const flushTrace = async () => {
  const lines = traceBuf;
  traceBuf = [];
  await RNFS.appendFile(TRACE, lines.join('\n') + '\n', 'utf8').catch(() => {});
};
function q(url: string, k: string): string | null {
  const m = new RegExp('[?&]' + k + '=([^&]*)').exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

async function waitIdle(rec: (s: string) => void) {
  const deadline = Date.now() + 90000;
  let quietSince = 0;
  let firstFalse = 0;
  while (Date.now() < deadline) {
    if (await Speech.isSpeaking()) {
      quietSince = 0;
    } else {
      if (!firstFalse) {
        firstFalse = Date.now();
        rec('isSpeaking=false (first)');
      }
      quietSince = quietSince || Date.now();
      if (Date.now() - quietSince > 2500) {
        break;
      }
    }
    await wait(50);
  }
  rec('idle');
}

export function isIOSPEvidenceUrl(url: string | null | undefined) {
  return !!url && url.startsWith('speechexample://evidence/iosp');
}

async function pickVoice(kind: string): Promise<string | undefined> {
  if (kind === 'default') {
    return undefined;
  }
  const voices: any[] = await Speech.getAvailableVoices('en');
  const wantNet = kind === 'network';
  const v = voices.find(
    x =>
      !!x.networkConnectionRequired === wantNet &&
      !x.notInstalled &&
      /^en-US/i.test(x.language),
  );
  return v?.identifier;
}

export async function runIOSPEvidence(url: string): Promise<void> {
  const label = q(url, 'label') ?? 'x';
  const mode = q(url, 'mode') ?? 'seq';
  const runs = Number(q(url, 'runs') ?? '5');
  const stopAt = Number(q(url, 'stopAt') ?? '2500');
  const voiceKind = q(url, 'voice') ?? 'local';
  const ev: string[] = [];
  let t0 = 0;
  const rec = (s: string) => ev.push(`${Date.now()} ${s}`);
  const subs = [
    Speech.onStart(e => rec(`onStart id=${e.id}`)),
    Speech.onFinish(e => rec(`onFinish id=${e.id}`)),
    Speech.onStopped(e => rec(`onStopped id=${e.id}`)),
    Speech.onError(e => rec(`onError id=${e.id}`)),
    Speech.onProgress(e => rec(`onProgress id=${e.id} loc=${e.location}`)),
  ];
  const progUnsub = Speech.onChunkProgress(e =>
    rec(`chunkProgress idx=${e.chunkIndex} "${e.chunkText.slice(0, 20)}"`),
  );
  try {
    // The example app initializes its own engine at startup; let it settle,
    // then switch to the OS engine (latest initialize() wins).
    await wait(6000);
    await Speech.initialize({engine: TTSEngine.OS_NATIVE});
    const voice = await pickVoice(voiceKind);
    out(
      `START label=${label} mode=${mode} voice=${voiceKind}:${voice} runs=${runs} stopAt=${stopAt}`,
    );
    for (let r = 0; r < runs; r++) {
      if (Speech.getCurrentEngineId() !== TTSEngine.OS_NATIVE) {
        await Speech.initialize({engine: TTSEngine.OS_NATIVE});
      }
      out(`engine=${Speech.getCurrentEngineId()}`);
      ev.length = 0;
      t0 = Date.now();
      out(`RUN_BEGIN ${r} t0=${t0}`);
      if (mode === 'seq') {
        for (const s of SENTENCES) {
          rec(`speak "${s.slice(0, 12)}"`);
          await Speech.speak(s, voice);
          rec('speak resolved');
        }
        // wait until idle
        await waitIdle(rec);
      } else {
        const stream = Speech.createSpeechStream(voice, {});
        stream.onProgress(e =>
          rec(`streamProgress batch=${e.batchIndex} idx=${e.chunkIndex}`),
        );
        const text = SENTENCES.join('');
        let stopped = false;
        if (mode === 'stop' || mode === 'stopgap' || mode === 'stopraw') {
          (async () => {
            if (mode === 'stopgap') {
              // Cancel right after the first utterance ends: the gap before the next one starts.
              while (!ev.some(l => l.includes('onFinish'))) {
                await wait(2);
              }
            } else {
              while (!ev.some(l => l.includes('onStart'))) {
                await wait(10);
              }
              await wait(stopAt);
            }
            rec('STOP call');
            stopped = true;
            if (mode === 'stopraw') {
              await Speech.stop();
            } else {
              await stream.cancel();
            }
            rec('STOP resolved');
          })();
        }
        for (let i = 0; i < text.length && !stopped; i += 4) {
          stream.append(text.slice(i, i + 4));
          await wait(25);
        }
        rec('finalize call');
        await stream.finalize().catch(e => rec(`finalize threw ${e}`));
        rec('finalize resolved');
        await waitIdle(rec);
      }
      await wait(3000);
      rec('settled');
      for (const l of ev) {
        out(`E ${r} ${l}`);
      }
      out(`RUN_END ${r}`);
      await flushTrace();
      await wait(1500);
    }
    out('DONE');
  } catch (e) {
    out(`ERROR ${e}`);
  } finally {
    await flushTrace();
    subs.forEach(s => s.remove());
    progUnsub();
  }
}
