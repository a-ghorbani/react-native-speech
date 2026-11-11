// I86 evidence harness (do not merge): logs each neural chunk handed to native
// playback, and chunk-progress / finish events, to Documents/i86-trace.log.
import * as RNFS from '@dr.pogodin/react-native-fs';
import Speech from '@pocketpalai/react-native-speech';
import {NeuralAudioPlayer} from '../../src/engines/NeuralAudioPlayer';
import NativeNeuralAudioPlayer from '../../src/NativeAudioPlayer';

const FILE = `${RNFS.DocumentDirectoryPath}/i86-trace.log`;
let queue = Promise.resolve();
let seq = 0;

function log(line: string) {
  const text = `[I86] ${Date.now()} ${line}`;
  console.log(text);
  queue = queue
    .then(() => RNFS.appendFile(FILE, text + '\n', 'utf8'))
    .catch(() => {});
}

const origPlay = NeuralAudioPlayer.prototype.play;
NeuralAudioPlayer.prototype.play = async function (audioBuffer, options) {
  const n = ++seq;
  const samples = audioBuffer.samples.length / (audioBuffer.channels || 1);
  const sec = (samples / audioBuffer.sampleRate).toFixed(3);
  log(
    `PLAY_BEGIN n=${n} samples=${samples} sr=${audioBuffer.sampleRate} audio_s=${sec}`,
  );
  const t0 = Date.now();
  try {
    await origPlay.call(this, audioBuffer, options);
    log(`PLAY_END n=${n} wall_ms=${Date.now() - t0} audio_s=${sec}`);
  } catch (e) {
    log(`PLAY_ERROR n=${n} wall_ms=${Date.now() - t0} err=${String(e)}`);
    throw e;
  }
};

Speech.onChunkProgress(e =>
  log(
    `CHUNK id=${e.id} ${e.chunkIndex + 1}/${e.totalChunks} chars=${e.chunkText.length}`,
  ),
);
NativeNeuralAudioPlayer.onFinish(e =>
  log(`NATIVE_FINISH ${JSON.stringify(e)}`),
);
NativeNeuralAudioPlayer.onStopped(e =>
  log(`NATIVE_STOPPED ${JSON.stringify(e)}`),
);
NativeNeuralAudioPlayer.onError(e => log(`NATIVE_ERROR ${JSON.stringify(e)}`));
log(`HARNESS_READY file=${FILE}`);
