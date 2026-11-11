/**
 * I134 iOS harness (throwaway branch, not for main). After the FIRST chunk of the
 * first neural utterance ends, the app calls Speech.pause() in the gap, waits 3 s,
 * then Speech.resume(). Native onStart/onFinish/onPause/onResume/onStopped and the
 * pause/resume results go to Documents/i134-trace.log (epoch ms).
 * Pass (branch): PAUSE result=true, EV pause, no EV start between PAUSE and RESUME_CALL,
 * EV resume, then the next EV start. Base: PAUSE result=false and the next start at once.
 */
import * as RNFS from '@dr.pogodin/react-native-fs';
import Speech from '@pocketpalai/react-native-speech';
import {NeuralAudioPlayer} from '@pocketpalai/react-native-speech/engine-sdk';

const path = `${RNFS.DocumentDirectoryPath}/i134-trace.log`;
let buf = '';
let writing = Promise.resolve();
function log(s: string) {
  const line = `${Date.now()} ${s}\n`;
  console.log('[I134] ' + line.trim());
  buf += line;
  writing = writing.then(async () => {
    const out = buf;
    buf = '';
    if (out) await RNFS.appendFile(path, out, 'utf8').catch(() => undefined);
  });
}

log('APP_START');
Speech.onStart(e => log(`EV start id=${e.id}`));
Speech.onFinish(e => log(`EV finish id=${e.id}`));
Speech.onPause(e => log(`EV pause id=${e.id}`));
Speech.onResume(e => log(`EV resume id=${e.id}`));
Speech.onStopped(e => log(`EV stopped id=${e.id}`));

let chunk = 0;
let done = false;
const orig = NeuralAudioPlayer.prototype.play;
NeuralAudioPlayer.prototype.play = async function (...args: any[]) {
  const n = ++chunk;
  log(`PLAY_CALL n=${n}`);
  try {
    return await (orig as any).apply(this, args);
  } finally {
    log(`PLAY_SETTLED n=${n}`);
    if (n === 1 && !done) {
      done = true;
      Speech.pause().then(p => {
        log(`PAUSE result=${p}`);
        setTimeout(() => {
          log('RESUME_CALL');
          Speech.resume().then(r => log(`RESUME result=${r}`));
        }, 3000);
      });
    }
  }
};
