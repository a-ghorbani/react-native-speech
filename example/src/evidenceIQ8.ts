/**
 * IQ8 evidence harness (not committed). Kokoro int8 vs fp32 on device, pinned HF revision.
 * Deep link:
 *   speechexample://evidence/iq8?file=fp32|int8|q8f16&round=R&modes=speak,stream&texts=r1,r2,...&wav=r1
 * - Loads <dir>/<file>.onnx (pushed by the host, or downloaded from resolve/<SHA>/onnx/... if absent),
 *   CPU EP, maxChunkSize 200, voice af_heart: the PocketPal config.
 * - Playback is nulled (globalThis.__IQ8_NOPLAY: NeuralAudioPlayer.play waits the buffer's duration
 *   instead of calling native), so nothing reaches the speaker; pipelining timing is kept.
 * - Per chunk, the [IQ8CHUNK] probe in KokoroEngine logs NaN/zero/RMS/samples/timings.
 * - wav=<key>: the speak() run of that reply saves the PCM handed to playback as a WAV (Kokoro has no
 *   onAudioChunk, so the null-playback hook calls globalThis.__IQ8_ONPLAY with each buffer).
 * - Logs VmHWM/VmRSS from /proc/self/status (Android) at the end of the run.
 */
import Speech, {TTSEngine} from '@pocketpalai/react-native-speech';
import {phonemizerDictManager} from './utils/PhonemizerDictManager';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {Platform} from 'react-native';

const SHA = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const HF = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${SHA}`;
const FILES: Record<string, {path: string; bytes: number}> = {
  fp32: {path: 'onnx/model.onnx', bytes: 325532232},
  int8: {path: 'onnx/model_quantized.onnx', bytes: 92361116},
  q8f16: {path: 'onnx/model_q8f16.onnx', bytes: 86033585},
};
const VOICE = 'af_heart';

// Five assistant-style replies, 6+ sentences each, with numbers, a list and a question.
export const REPLIES: Record<string, string> = {
  r1: "Great question! Tomatoes grow best when the soil is at least 16 degrees Celsius, so in most temperate places that means planting out in late May. Start the seeds indoors about 6 to 8 weeks earlier. Here is a simple plan: 1. Sow two seeds per pot, 5 millimetres deep. 2. Keep them somewhere warm and bright. 3. Harden them off for 7 days before moving them outside. Water deeply, roughly 2 litres per plant, two or three times a week. Do you know which variety you want to grow?",
  r2: "Sure, here's a quick summary of the meeting. We agreed to ship version 3.2 on the 14th of March, two weeks later than planned. The main reasons were the payment bug and the 18 percent drop in test coverage. The next steps are: - Maria fixes the checkout flow. - Tom writes the missing tests. - I update the release notes. The budget stays at 45,000 dollars, and nobody asked for more. We'll meet again on Thursday at 10:30. Should I send the notes to the whole team or only to the leads?",
  r3: "To convert 72 degrees Fahrenheit to Celsius, subtract 32 and multiply by five ninths. That gives you 40 times 5 divided by 9, which is about 22.2 degrees. A quick rule of thumb is to subtract 30 and halve the result, so 72 becomes 21. It's off by about a degree, which is fine for the weather. For cooking, though, use the exact formula. Here are three handy reference points: freezing is 32, body temperature is 98.6, and boiling is 212. Would you like a small table for oven temperatures as well?",
  r4: "Your trip to Lisbon sounds lovely, and four days is enough to see the highlights. On day 1, walk through Alfama and take tram 28 up to the castle. On day 2, visit Belém, the monastery and the tower, and try a pastel de nata at the original bakery. Day 3 could be a day trip to Sintra, which is about 40 minutes by train. Keep day 4 for the LX Factory and a sunset at a miradouro. Expect to spend around 80 to 120 euros a day, not counting the hotel. Are you travelling in summer or in winter?",
  r5: "Let's look at the numbers together. Your monthly income is 3,200 and your fixed costs come to 1,950, which leaves 1,250. A common rule splits that into three parts: first, 50 percent for needs; second, 30 percent for wants; and third, 20 percent for savings. In your case, 20 percent of 3,200 is 640 a month. Over 12 months that adds up to 7,680, before any interest. If you raise it by just 50 a month, you'd save 600 more a year. Which of your current expenses do you think is easiest to cut?",
};

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (s: string) => console.log('[IQ8EV] ' + s);
function q(url: string, k: string): string | null {
  const m = new RegExp('[?&]' + k + '=([^&]*)').exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

function toWavBase64(s: Float32Array, sr: number): string {
  const n = s.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s[i]!)) * 32767), true);
  const bytes = new Uint8Array(buf);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += A[a >> 2]! + A[((a & 3) << 4) | ((b ?? 0) >> 4)]! + (b === undefined ? '=' : A[((b & 15) << 2) | ((c ?? 0) >> 6)]!) + (c === undefined ? '=' : A[c & 63]!);
  }
  return out;
}

async function memLine(tag: string) {
  if (Platform.OS !== 'android') return;
  try {
    const s = await RNFS.readFile('/proc/self/status', 'utf8');
    const g = (k: string) => (new RegExp(k + ':\\s*(\\d+)').exec(s)?.[1] ?? '?');
    log(`MEM ${tag} VmHWM_kB=${g('VmHWM')} VmRSS_kB=${g('VmRSS')}`);
  } catch (e) {
    log(`MEM ${tag} error ${String(e)}`);
  }
}

async function ensureFile(dir: string, name: string, url: string, bytes?: number) {
  const p = `${dir}/${name}`;
  if (await RNFS.exists(p)) {
    const st = await RNFS.stat(p);
    if (!bytes || Number(st.size) === bytes) return p;
    log(`size mismatch ${name} ${st.size} != ${bytes}, re-downloading`);
    await RNFS.unlink(p);
  }
  log(`downloading ${url}`);
  const r = await RNFS.downloadFile({fromUrl: url, toFile: p}).promise;
  if (r.statusCode !== 200) throw new Error(`download ${url} -> ${r.statusCode}`);
  const st = await RNFS.stat(p);
  if (bytes && Number(st.size) !== bytes) throw new Error(`size ${name} ${st.size} != ${bytes}`);
  return p;
}

export function isIQ8EvidenceUrl(url: string | null | undefined) {
  return !!url && url.startsWith('speechexample://evidence/iq8');
}

export async function runIQ8Evidence(url: string): Promise<void> {
  const file = q(url, 'file') ?? 'int8';
  const round = q(url, 'round') ?? '1';
  const modes = (q(url, 'modes') ?? 'speak,stream').split(',');
  const keys = (q(url, 'texts') ?? Object.keys(REPLIES).join(',')).split(',');
  const wavKey = q(url, 'wav');
  const tokMs = Number(q(url, 'tokms') ?? '50');
  (globalThis as any).__IQ8_NOPLAY = true;
  log(`START file=${file} round=${round} modes=${modes.join(',')} texts=${keys.join(',')} wav=${wavKey} os=${Platform.OS}`);
  await memLine('start');
  try {
    const base = Platform.OS === 'android' ? RNFS.ExternalDirectoryPath : RNFS.DocumentDirectoryPath;
    const dir = `${base}/iq8`;
    await RNFS.mkdir(dir);
    await RNFS.mkdir(`${dir}/voices`);
    await RNFS.mkdir(`${dir}/wav`);
    const f = FILES[file]!;
    const modelPath = await ensureFile(dir, `${file}.onnx`, `${HF}/${f.path}`, f.bytes);
    const tokPath = await ensureFile(dir, 'tokenizer.json', `${HF}/tokenizer.json`, 3497);
    await ensureFile(`${dir}/voices`, `${VOICE}.bin`, `${HF}/voices/${VOICE}.bin`, 522240);
    await RNFS.writeFile(`${dir}/voices-manifest.json`, JSON.stringify({baseUrl: `${HF}/voices`, voices: [VOICE]}), 'utf8');
    const dictPath = await phonemizerDictManager.ensureDict('en-us');
    await Speech.release().catch(() => undefined);
    const t0 = Date.now();
    await Speech.initialize({
      engine: TTSEngine.KOKORO,
      modelPath: `file://${modelPath}`,
      tokenizerPath: `file://${tokPath}`,
      voicesPath: `file://${dir}/voices-manifest.json`,
      dictPath,
      phonemizerType: 'js',
      executionProviders: ['cpu'],
      maxChunkSize: 200,
      silentMode: 'obey',
      ducking: false,
    } as any);
    log(`INIT_MS ${Date.now() - t0}`);
    await memLine('init');
    log('WARMUP_BEGIN');
    await Speech.speak('Warm up.', VOICE).catch(e => log('WARMUP_ERROR ' + String(e)));
    log('WARMUP_END');
    for (const key of keys) {
      for (const mode of modes) {
        const text = REPLIES[key]!;
        const capture = mode === 'speak' && key === wavKey;
        const bufs: Float32Array[] = [];
        let sr = 24000;
        let firstAudioMs = -1;
        const onAudioChunk = (b: any) => {
          if (firstAudioMs < 0) firstAudioMs = Date.now() - ts;
          if (capture) { bufs.push(new Float32Array(b.samples)); sr = b.sampleRate; }
        };
        let ts = 0;
        (globalThis as any).__IQ8_ONPLAY = onAudioChunk;
        log(`RUN_BEGIN file=${file} round=${round} mode=${mode} text=${key} chars=${text.length}`);
        ts = Date.now();
        const chunks: number[] = [];
        let err = '';
        try {
          if (mode === 'speak') {
            await Speech.speak(text, VOICE, {firstChunk: 'clause'} as any);
          } else {
            const stream = Speech.createSpeechStream(VOICE, {firstChunk: 'clause', targetChars: 300} as any);
            stream.onProgress(e => chunks.push(e.chunkText.length));
            for (const tok of text.match(/\S+\s*/g) ?? []) {
              stream.append(tok);
              await wait(tokMs);
            }
            await stream.finalize();
          }
        } catch (e) {
          err = String(e).replace(/\s+/g, ' ').slice(0, 300);
        }
        log(`RUN_END file=${file} round=${round} mode=${mode} text=${key} firstAudioMs=${firstAudioMs} totalMs=${Date.now() - ts} chunks=${JSON.stringify(chunks)} error=${err || 'none'}`);
        if (capture && bufs.length) {
          const all = new Float32Array(bufs.reduce((n, b) => n + b.length, 0));
          let o = 0;
          for (const b of bufs) { all.set(b, o); o += b.length; }
          const wp = `${dir}/wav/${file}-${key}-r${round}.wav`;
          await RNFS.writeFile(wp, toWavBase64(all, sr), 'base64');
          log(`WAV ${wp} samples=${all.length} chunks=${bufs.length}`);
        }
        await memLine(`after-${mode}-${key}`);
        await wait(500);
      }
    }
    await memLine('end');
    log('DONE');
  } catch (e) {
    log('ERROR ' + String(e));
    await memLine('error');
    log('DONE');
  }
}
