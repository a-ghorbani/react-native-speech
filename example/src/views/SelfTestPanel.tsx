/**
 * Device self-tests for the streaming APIs. Each scenario drives the real
 * engine and logs `[SelfTest] <name> PASS|FAIL <detail>` to the console
 * (logcat: ReactNativeJS) and to the panel.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Speech, {
  createMarkdownStreamBuffer,
  onAudioInterruption,
  type SpeechStreamOptions,
  type StreamProgressEvent,
  type ChunkProgressEvent,
} from '@pocketpalai/react-native-speech';
import {C, MONO} from '../styles/cyber';

const PROSE =
  'Sure, here is a quick overview of how the whole process works, step by step, so you can follow along easily. ' +
  'First you open the settings screen and pick a model. Then you start a chat.';
const PROSE_CLAUSE =
  'Sure, here is a quick overview of how the whole process works, ';
const PROSE_SENTENCE =
  'Sure, here is a quick overview of how the whole process works, step by step, so you can follow along easily. ';

const MARKDOWN =
  '# Quick setup\n\n' +
  'Sure, here is **the short version**, with a [link](https://example.com) and `code` inline. ' +
  'It keeps going for a while, then ends.\n\n' +
  '- First item, with a comma\n' +
  '- Second item\n\n' +
  'That is all, thanks for reading.';

type Result = {name: string; pass: boolean; detail: string};

function report(name: string, pass: boolean, detail: string): Result {
  console.log(`[SelfTest] ${name} ${pass ? 'PASS' : 'FAIL'} ${detail}`);
  return {name, pass, detail};
}

function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Run one stream to completion; `listenAfterMs` > 0 attaches the progress
 * listener that long after append().
 */
async function runStream(
  text: string,
  options: SpeechStreamOptions,
  listenAfterMs = 0,
): Promise<StreamProgressEvent[]> {
  const events: StreamProgressEvent[] = [];
  const stream = Speech.createSpeechStream(undefined, options);
  const listen = () => stream.onProgress(e => events.push(e));
  if (listenAfterMs === 0) {
    listen();
    stream.append(text);
  } else {
    stream.append(text);
    await wait(listenAfterMs);
    listen();
  }
  await stream.finalize();
  return events;
}

function contiguous(events: StreamProgressEvent[], total: number): boolean {
  let pos = 0;
  for (const e of events) {
    if (e.streamRange.start !== pos) return false;
    pos = e.streamRange.end;
  }
  return pos === total;
}

const SCENARIOS: Record<string, () => Promise<Result>> = {
  async clause_first_chunk() {
    const ev = await runStream(PROSE, {
      firstChunk: 'clause',
      stripMarkdown: false,
    });
    const first = ev[0]?.chunkText;
    const second = ev[1]?.chunkText;
    const pass =
      first === PROSE_CLAUSE &&
      // Later chunks group whole sentences up to the engine's chunk size.
      !!second?.startsWith('step by step, so you can follow along easily. ') &&
      contiguous(ev, PROSE.length);
    return report(
      'clause_first_chunk',
      pass,
      `chunks=${ev.length} first=${JSON.stringify(first)} second=${JSON.stringify(second)}`,
    );
  },

  async sentence_default() {
    const ev = await runStream(PROSE, {stripMarkdown: false});
    const first = ev[0]?.chunkText;
    const pass =
      !!first?.startsWith(PROSE_SENTENCE) &&
      /[.!?]\s*$/.test(first) &&
      contiguous(ev, PROSE.length);
    return report(
      'sentence_default',
      pass,
      `chunks=${ev.length} first=${JSON.stringify(first)}`,
    );
  },

  async clause_with_strip() {
    // Default stripMarkdown: true path (md buffer + chunker both clause-aware).
    const ev = await runStream(PROSE, {firstChunk: 'clause'});
    const first = ev[0]?.chunkText.trim();
    const pass = first === PROSE_CLAUSE.trim() && ev.length >= 3;
    return report(
      'clause_with_strip',
      pass,
      `chunks=${ev.length} first=${JSON.stringify(first)}`,
    );
  },

  async late_listener() {
    const ev = await runStream(PROSE, {stripMarkdown: false}, 300);
    return report('late_listener', ev.length > 0, `events=${ev.length}`);
  },

  async stale_unsubscribe() {
    // Unsubscribing stream A must not drop stream B's listener.
    const a = Speech.createSpeechStream(undefined, {stripMarkdown: false});
    const unA = a.onProgress(() => {});
    const b = Speech.createSpeechStream(undefined, {stripMarkdown: false});
    const evB: StreamProgressEvent[] = [];
    b.onProgress(e => evB.push(e));
    unA();
    b.append('Stream B is speaking now. It has two sentences.');
    await b.finalize();
    return report('stale_unsubscribe', evB.length > 0, `eventsB=${evB.length}`);
  },

  async global_listener_survives_stream() {
    const got: ChunkProgressEvent[] = [];
    const un = Speech.onChunkProgress(e => got.push(e));
    try {
      await runStream('A short stream. Done.', {stripMarkdown: false});
      got.length = 0;
      await Speech.speak('Global listener check. Second sentence here.');
      await wait(500);
      return report(
        'global_listener_survives_stream',
        got.length > 0,
        `speakEvents=${got.length}`,
      );
    } finally {
      un();
    }
  },

  async md_export_offsets() {
    const md = createMarkdownStreamBuffer({firstChunk: 'clause'});
    const stream = Speech.createSpeechStream(undefined, {
      stripMarkdown: false,
      firstChunk: 'clause',
    });
    const ev: StreamProgressEvent[] = [];
    stream.onProgress(e => ev.push(e));
    let spoken = '';
    for (const tok of MARKDOWN.match(/\S+\s*|\s+/g) ?? []) {
      const clean = md.push(tok);
      spoken += clean;
      stream.append(clean);
    }
    const tail = md.flush();
    spoken += tail;
    stream.append(tail);
    await stream.finalize();
    const aligned = ev.every(
      e => spoken.slice(e.streamRange.start, e.streamRange.end) === e.chunkText,
    );
    const clean = !/[*#`]|\]\(/.test(spoken);
    return report(
      'md_export_offsets',
      ev.length > 0 && aligned && clean,
      `chunks=${ev.length} aligned=${aligned} clean=${clean} first=${JSON.stringify(ev[0]?.chunkText)}`,
    );
  },
};

/** Feed PROSE at 5 tok/s; return ms from first append to first chunk. */
async function timeFirstAudio(firstChunk: 'sentence' | 'clause') {
  const stream = Speech.createSpeechStream(undefined, {firstChunk});
  const start = Date.now();
  let firstMs = -1;
  let firstText = '';
  stream.onProgress(e => {
    if (firstMs < 0) {
      firstMs = Date.now() - start;
      firstText = e.chunkText;
    }
  });
  for (const tok of PROSE.match(/\S+\s*/g) ?? []) {
    stream.append(tok);
    await wait(200);
  }
  await stream.finalize();
  return {firstMs, firstText};
}

/**
 * Releases the engine while a stream is playing; finalize() must still
 * resolve. Runs last: the engine has to be re-initialized afterwards.
 */
async function releaseDuringStream(): Promise<Result> {
  const stream = Speech.createSpeechStream(undefined, {stripMarkdown: false});
  let started!: () => void;
  const firstChunk = new Promise<void>(r => (started = r));
  stream.onProgress(() => started());
  stream.append(`${PROSE} ${PROSE}`);
  const done = stream.finalize().then(() => 'resolved');
  await Promise.race([firstChunk, wait(30000)]);
  await Speech.release();
  const outcome = await Promise.race([done, wait(5000).then(() => 'pending')]);
  return report(
    'release_during_stream',
    outcome === 'resolved',
    `finalize=${outcome} (engine released; re-INIT on SYS tab)`,
  );
}

const SelfTestPanel: React.FC = () => {
  const [results, setResults] = React.useState<Result[]>([]);
  const [running, setRunning] = React.useState(false);
  const [interruptLog, setInterruptLog] = React.useState<string[]>([]);
  const [summary, setSummary] = React.useState<string | null>(null);

  const runAll = React.useCallback(async () => {
    setRunning(true);
    setResults([]);
    setSummary(null);
    // Captured up front: the last scenario releases the engine.
    const engine = Speech.getCurrentEngine();
    console.log(`[SelfTest] START engine=${engine}`);
    const out: Result[] = [];
    for (const [name, fn] of Object.entries(SCENARIOS)) {
      try {
        out.push(await fn());
      } catch (err) {
        out.push(report(name, false, `threw ${String(err)}`));
      }
      setResults([...out]);
      await wait(300);
    }
    try {
      out.push(await releaseDuringStream());
    } catch (err) {
      out.push(report('release_during_stream', false, `threw ${String(err)}`));
    }
    setResults([...out]);
    const failed = out.filter(r => !r.pass).length;
    // Read by the e2e flows (example/e2e) — keep the format stable.
    const line = `SELFTEST DONE engine=${engine} passed=${out.length - failed} failed=${failed}`;
    console.log(`[SelfTest] ${line.slice('SELFTEST '.length)}`);
    setSummary(line);
    setRunning(false);
  }, []);

  const runTiming = React.useCallback(async () => {
    setRunning(true);
    console.log(`[SelfTest] TIMING START engine=${Speech.getCurrentEngine()}`);
    for (let i = 1; i <= 3; i++) {
      for (const mode of ['sentence', 'clause'] as const) {
        const {firstMs, firstText} = await timeFirstAudio(mode);
        console.log(
          `[SelfTest] timing run=${i} mode=${mode} firstAudioMs=${firstMs} first=${JSON.stringify(firstText)}`,
        );
        await wait(500);
      }
    }
    console.log('[SelfTest] DONE timing');
    setRunning(false);
  }, []);

  const runInterruption = React.useCallback(async () => {
    // Long stream; trigger an interruption externally while it plays.
    setInterruptLog([]);
    const sub = onAudioInterruption(e => {
      const line = `type=${e.type} shouldResume=${String(e.shouldResume)}`;
      console.log(`[SelfTest] interruption ${line}`);
      setInterruptLog(l => [...l, line]);
    });
    console.log('[SelfTest] interruption LISTENING');
    try {
      const stream = Speech.createSpeechStream(undefined, {});
      stream.append(`${PROSE} ${PROSE} ${PROSE}`);
      await stream.finalize();
    } finally {
      sub.remove();
      console.log('[SelfTest] interruption STOPPED');
    }
  }, []);

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{'// SELF_TEST'}</Text>
      <View style={styles.row}>
        <TouchableOpacity
          disabled={running}
          onPress={runAll}
          style={styles.btn}>
          <Text style={styles.btnText}>SELFTEST</Text>
        </TouchableOpacity>
        <TouchableOpacity
          disabled={running}
          onPress={runTiming}
          style={styles.btn}>
          <Text style={styles.btnText}>TIMING</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={runInterruption} style={styles.btn}>
          <Text style={styles.btnText}>INTERRUPT</Text>
        </TouchableOpacity>
      </View>
      {results.map(r => (
        <Text
          key={r.name}
          testID={`selftest-${r.name}`}
          style={r.pass ? styles.pass : styles.fail}>
          {r.pass ? 'PASS' : 'FAIL'} {r.name}
        </Text>
      ))}
      {summary && (
        <Text testID="selftest-summary" style={styles.summary}>
          {summary}
        </Text>
      )}
      {interruptLog.map((l, i) => (
        <Text key={i} style={styles.pass}>
          {l}
        </Text>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    padding: 12,
    borderRadius: 4,
    marginBottom: 16,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.greenBorder,
  },
  label: {
    fontSize: 10,
    color: C.muted,
    fontFamily: MONO,
    letterSpacing: 1,
    marginBottom: 8,
  },
  row: {flexDirection: 'row', gap: 8, marginBottom: 8},
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.green,
    backgroundColor: C.greenGhost,
  },
  btnText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.green,
  },
  pass: {fontSize: 11, fontFamily: MONO, color: C.green},
  summary: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.cyan,
    marginTop: 6,
  },
  fail: {fontSize: 11, fontFamily: MONO, color: C.red},
});

export default SelfTestPanel;
