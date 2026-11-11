/**
 * #134: a pause between two chunks of an utterance holds the next chunk
 * until resume() (or drops it on stop()), and reports onPause/onResume.
 */

let mockStart: ((e: {id: number}) => void) | null = null;
jest.mock('../../NativeAudioPlayer', () => ({
  __esModule: true,
  default: {
    playAudio: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    pause: jest.fn(async () => true),
    resume: jest.fn(async () => true),
    isSpeaking: jest.fn(async () => false),
    onStart: jest.fn((cb: (e: {id: number}) => void) => {
      mockStart = cb;
      return {remove: () => {}};
    }),
  },
}));

import NativeNeuralAudioPlayer from '../../NativeAudioPlayer';
import {NeuralAudioPlayer} from '../NeuralAudioPlayer';

const native = NativeNeuralAudioPlayer as unknown as Record<string, jest.Mock>;
const buffer = {
  samples: new Float32Array([0, 0.5]),
  sampleRate: 24000,
  channels: 1,
  duration: 0,
};
const tick = () => new Promise(r => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return {promise, resolve};
}

beforeEach(() => {
  Object.values(native).forEach(fn => fn.mockClear());
  native.playAudio!.mockImplementation(async () => {});
  native.pause!.mockImplementation(async () => true);
  native.isSpeaking!.mockImplementation(async () => false);
});

describe('NeuralAudioPlayer: pause between chunks (#134)', () => {
  it('holds the next chunk until resume()', async () => {
    const player = new NeuralAudioPlayer();
    const u = {};
    await player.play(buffer, undefined, u); // chunk 1 ended
    await expect(player.pause()).resolves.toBe(true);
    expect(native.pause).not.toHaveBeenCalled();

    let played = false;
    const chunk2 = player.play(buffer, undefined, u).then(() => {
      played = true;
    });
    await tick();
    expect(native.playAudio).toHaveBeenCalledTimes(1);
    expect(played).toBe(false);

    await expect(player.resume()).resolves.toBe(true);
    expect(native.resume).not.toHaveBeenCalled();
    await chunk2;
    expect(native.playAudio).toHaveBeenCalledTimes(2);
  });

  it('stop() drops the held chunk; the next utterance plays at once', async () => {
    const player = new NeuralAudioPlayer();
    const u = {};
    await player.play(buffer, undefined, u);
    await player.pause();
    const chunk2 = player.play(buffer, undefined, u);
    await tick();
    await player.stop();
    await chunk2;
    expect(native.playAudio).toHaveBeenCalledTimes(1);

    await player.play(buffer, undefined, {});
    expect(native.playAudio).toHaveBeenCalledTimes(2);
  });

  it('a pause with no utterance open returns false, as before', async () => {
    const player = new NeuralAudioPlayer();
    await expect(player.pause()).resolves.toBe(false);
    const u = {};
    await player.play(buffer, undefined, u);
    await player.endUtterance(u);
    await expect(player.pause()).resolves.toBe(false);
  });

  it('the end of the utterance clears a hold it never used', async () => {
    const player = new NeuralAudioPlayer();
    const u = {};
    await player.play(buffer, undefined, u);
    await player.pause();
    await player.endUtterance(u);
    await player.play(buffer, undefined, {});
    expect(native.playAudio).toHaveBeenCalledTimes(2);
  });

  it('reports one onPause and one onResume, with the last chunk id', async () => {
    const player = new NeuralAudioPlayer();
    const events: string[] = [];
    const subs = [
      player.onGapPause(e => events.push(`pause:${e.id}`)),
      player.onGapResume(e => events.push(`resume:${e.id}`)),
    ];
    const u = {};
    await player.play(buffer, undefined, u);
    mockStart?.({id: 7});
    await player.pause();
    await player.pause();
    await player.resume();
    await expect(player.resume()).resolves.toBe(true); // native resume, nothing held
    subs.forEach(s => s.remove());
    expect(events).toEqual(['pause:7', 'resume:7']);
  });

  it('a pause while a chunk plays still pauses natively', async () => {
    const player = new NeuralAudioPlayer();
    const d = deferred();
    native.playAudio!.mockImplementationOnce(() => d.promise);
    const playing = player.play(buffer, undefined, {});
    await expect(player.pause()).resolves.toBe(true);
    expect(native.pause).toHaveBeenCalledTimes(1);
    d.resolve();
    await playing;
  });

  it('stop() or the end of the utterance ends a gap pause with onStopped', async () => {
    const player = new NeuralAudioPlayer();
    const events: string[] = [];
    const subs = [
      player.onGapPause(() => events.push('pause')),
      player.onGapResume(() => events.push('resume')),
      player.onGapStopped(() => events.push('stopped')),
    ];
    const u = {};
    await player.play(buffer, undefined, u);
    await player.pause();
    await player.stop();
    const v = {};
    await player.play(buffer, undefined, v);
    await player.pause();
    await player.endUtterance(v);
    subs.forEach(s => s.remove());
    expect(events).toEqual(['pause', 'stopped', 'pause', 'stopped']);
  });

  it('a chunk dropped by stop() never plays, even after a later resume()', async () => {
    const player = new NeuralAudioPlayer();
    const u = {};
    await player.play(buffer, undefined, u);
    await player.pause();
    const chunk2 = player.play(buffer, undefined, u);
    await player.stop();
    await player.resume();
    await chunk2;
    expect(native.playAudio).toHaveBeenCalledTimes(1);
  });

  it('a pause in the same tick as resume() keeps the chunk held', async () => {
    const player = new NeuralAudioPlayer();
    const u = {};
    await player.play(buffer, undefined, u);
    await player.pause();
    const chunk2 = player.play(buffer, undefined, u);
    // Same tick: the woken chunk has not started yet.
    const resumed = player.resume();
    const paused = player.pause();
    await Promise.all([resumed, paused]);
    await tick();
    expect(native.playAudio).toHaveBeenCalledTimes(1);
    expect(native.pause).not.toHaveBeenCalled();
    await player.resume();
    await chunk2;
    expect(native.playAudio).toHaveBeenCalledTimes(2);
  });

  it('a pause while native already paused the chunk (focus loss) stays native', async () => {
    const player = new NeuralAudioPlayer();
    const d = deferred();
    native.playAudio!.mockImplementationOnce(() => d.promise);
    native.pause!.mockImplementationOnce(async () => false);
    native.isSpeaking!.mockImplementationOnce(async () => true);
    const playing = player.play(buffer, undefined, {});
    await expect(player.pause()).resolves.toBe(false);
    await player.resume();
    expect(native.resume).toHaveBeenCalledTimes(1);
    d.resolve();
    await playing;
  });

  it('a pause as the chunk ends (on its onFinish, before its settle) holds the next one', async () => {
    const player = new NeuralAudioPlayer();
    const u = {};
    const d = deferred();
    native.playAudio!.mockImplementationOnce(() => d.promise);
    native.pause!.mockImplementationOnce(async () => false);
    const chunk1 = player.play(buffer, undefined, u);
    await expect(player.pause()).resolves.toBe(true);
    d.resolve();
    await chunk1;
    const chunk2 = player.play(buffer, undefined, u);
    await tick();
    expect(native.playAudio).toHaveBeenCalledTimes(1);
    await player.resume();
    await chunk2;
    expect(native.playAudio).toHaveBeenCalledTimes(2);
  });
});
