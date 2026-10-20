/**
 * EngineStreamSession optional hooks (hasAudio / discard / onCancel) with
 * a non-AudioBuffer audio type, as used by engines whose PCM stays native.
 */
import {EngineStreamSession} from '../EngineStreamSession';

type Handle = {id: number; samples: number};

function makeSynth() {
  const calls: {
    text: string;
    resolve: (h: Handle) => void;
    reject: (e: Error) => void;
  }[] = [];
  let nextId = 0;
  const synthesizeChunk = jest.fn(
    (text: string) =>
      new Promise<Handle>((resolve, reject) => {
        calls.push({text, resolve, reject});
      }),
  );
  const audio = (samples = 10): Handle => ({id: ++nextId, samples});
  return {synthesizeChunk, calls, audio};
}

function makePlayer() {
  const plays: {
    audio: Handle;
    resolve: () => void;
    reject: (e: Error) => void;
  }[] = [];
  const playAudio = jest.fn(
    (audio: Handle) =>
      new Promise<void>((resolve, reject) => {
        plays.push({audio, resolve, reject});
      }),
  );
  return {playAudio, plays};
}

async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function makeSession(overrides: Record<string, unknown> = {}) {
  const synth = makeSynth();
  const player = makePlayer();
  const discard = jest.fn();
  const onCancel = jest.fn();
  const order: string[] = [];
  const stopPlayback = jest.fn(async () => {
    order.push('stopPlayback');
  });
  onCancel.mockImplementation(() => order.push('onCancel'));
  const session = new EngineStreamSession<Handle>({
    synthesizeChunk: synth.synthesizeChunk,
    playAudio: player.playAudio,
    stopPlayback,
    maxChunkSize: 10,
    hasAudio: h => h.samples > 0,
    discard,
    onCancel,
    ...overrides,
  });
  return {session, synth, player, discard, onCancel, stopPlayback, order};
}

describe('EngineStreamSession hooks', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('onCancel runs synchronously before stopPlayback, once', async () => {
    const {session, onCancel, order} = makeSession();
    const p = session.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    await p;
    await session.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['onCancel', 'stopPlayback']);
  });

  test('a throwing onCancel does not block cancel', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const {session, stopPlayback} = makeSession({
      onCancel: () => {
        throw new Error('boom');
      },
    });
    await session.cancel();
    expect(stopPlayback).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  test('played audio is never discarded', async () => {
    const {session, synth, player, discard} = makeSession();
    session.append('One here. Two here. ');
    const fin = session.finalize();
    await flush();
    synth.calls[0]!.resolve(synth.audio());
    await flush();
    synth.calls[1]!.resolve(synth.audio());
    player.plays[0]!.resolve();
    await flush();
    player.plays[1]!.resolve();
    await fin;
    expect(player.plays).toHaveLength(2);
    expect(discard).not.toHaveBeenCalled();
  });

  test('no-audio chunks are skipped and discarded', async () => {
    const {session, synth, player, discard} = makeSession();
    session.append('One here. Two here. ');
    const fin = session.finalize();
    await flush();
    const empty = synth.audio(0);
    synth.calls[0]!.resolve(empty);
    await flush();
    synth.calls[1]!.resolve(synth.audio());
    await flush();
    player.plays[0]!.resolve();
    await fin;
    expect(discard).toHaveBeenCalledWith(empty);
    expect(player.plays).toHaveLength(1);
  });

  test('cancel while the prefetch is in flight discards it when it lands', async () => {
    const {session, synth, player, discard, onCancel} = makeSession();
    session.append('One here. Two here. ');
    await flush();
    synth.calls[0]!.resolve(synth.audio());
    await flush();
    expect(player.plays).toHaveLength(1);
    expect(synth.calls).toHaveLength(2);

    await session.cancel();
    expect(onCancel).toHaveBeenCalled();
    const late = synth.audio();
    synth.calls[1]!.resolve(late);
    await flush();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(late);
    expect(player.plays).toHaveLength(1);
  });

  test('cancel during bootstrap synth discards the late result', async () => {
    const {session, synth, player, discard} = makeSession();
    session.append('One here. ');
    await flush();
    await session.cancel();
    const late = synth.audio();
    synth.calls[0]!.resolve(late);
    await flush();
    expect(discard).toHaveBeenCalledWith(late);
    expect(player.plays).toHaveLength(0);
  });

  test('a prefetch that landed before cancel is discarded on early return', async () => {
    const {session, synth, player, discard} = makeSession();
    session.append('One here. Two here. ');
    await flush();
    synth.calls[0]!.resolve(synth.audio());
    await flush();
    const ready = synth.audio();
    synth.calls[1]!.resolve(ready);
    await flush();
    // Prefetch resolved (not cancelled yet); chunk 0 still playing.
    await session.cancel();
    await flush();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(ready);
    expect(player.plays).toHaveLength(1);
  });

  test('a synth result that wins the race but finds the session cancelled is discarded once', async () => {
    const {session, synth, discard} = makeSession();
    session.append('One here. ');
    await flush();
    const audio = synth.audio();
    synth.calls[0]!.resolve(audio);
    // Cancel before the loop continuation runs.
    const c = session.cancel();
    await c;
    await flush();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  test('a playback failure discards the pending prefetch', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const {session, synth, player, discard} = makeSession();
    session.append('One here. Two here. ');
    const fin = session.finalize();
    await flush();
    synth.calls[0]!.resolve(synth.audio());
    await flush();
    player.plays[0]!.reject(new Error('device gone'));
    await expect(fin).rejects.toThrow('device gone');
    const late = synth.audio();
    synth.calls[1]!.resolve(late);
    await flush();
    expect(discard).toHaveBeenCalledWith(late);
    expect(error).toHaveBeenCalled();
  });

  test('a throwing discard is contained', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const {session, synth} = makeSession({
      discard: () => {
        throw new Error('release failed');
      },
    });
    session.append('One here. ');
    await flush();
    await session.cancel();
    synth.calls[0]!.resolve(synth.audio());
    await flush();
    expect(warn).toHaveBeenCalled();
  });

  test('without hooks, the default hasAudio reads samples.length', async () => {
    const plays: unknown[] = [];
    const session = new EngineStreamSession({
      synthesizeChunk: async (text: string) => ({
        samples: new Float32Array(text.includes('skip') ? 0 : 4),
        sampleRate: 24000,
        channels: 1,
        duration: 0.1,
      }),
      playAudio: async buf => {
        plays.push(buf);
      },
      stopPlayback: async () => {},
      maxChunkSize: 15,
    });
    session.append('Please skip. Play me. ');
    await session.finalize();
    expect(plays).toHaveLength(1);
  });
});
