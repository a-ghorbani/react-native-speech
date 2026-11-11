/**
 * OS engine (#129): chunk progress and playback state for streams.
 * The native module is faked with a queue that speaks one utterance at a
 * time and emits onStart / onFinish / onStopped like the real modules.
 */
import type {ChunkProgressEvent} from '../types';

jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});

type Listener = (e: {id: number}) => void;
const mockListeners: Record<string, Set<Listener>> = {};
const mockQueue: {id: number; text: string}[] = [];
const mockLog: string[] = [];
let mockNextId = 1;
let mockSpeakError: Error | null = null;

jest.mock('../NativeSpeech', () => {
  const emitter = (name: string) => (cb: Listener) => {
    (mockListeners[name] ??= new Set()).add(cb);
    return {remove: () => mockListeners[name]!.delete(cb)};
  };
  const speak = jest.fn(async (text: string) => {
    if (mockSpeakError) {
      throw mockSpeakError;
    }
    mockQueue.push({id: mockNextId++, text});
    mockLog.push(`speak:${text.trim()}`);
  });
  const store: Record<string, unknown> = {
    speak,
    speakWithOptions: speak,
    stop: jest.fn(async () => {
      mockLog.push('stop');
      const current = mockQueue[0];
      mockQueue.length = 0;
      if (current) {
        mockEmit('onStopped', current.id);
      }
    }),
    onStart: emitter('onStart'),
    onFinish: emitter('onFinish'),
    onStopped: emitter('onStopped'),
    onError: emitter('onError'),
  };
  return {
    __esModule: true,
    default: new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'getConstants') return () => ({maxInputLength: 4000});
          if (!store[prop]) store[prop] = jest.fn(async () => false);
          return store[prop];
        },
      },
    ),
  };
});

function mockEmit(name: string, id: number) {
  for (const cb of [...(mockListeners[name] ?? [])]) {
    cb({id});
  }
}

import Speech from '../Speech';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

/** The native head utterance starts playing. */
function startHead(): {id: number; text: string} {
  const head = mockQueue[0]!;
  mockEmit('onStart', head.id);
  return head;
}
/** The native head utterance finishes; the next one is now the head. */
function finishHead() {
  const head = mockQueue.shift()!;
  mockEmit('onFinish', head.id);
}

const progress: ChunkProgressEvent[] = [];
let unsub: () => void;

beforeAll(async () => {
  await Speech.initialize({engine: 'os-native' as any});
});

beforeEach(async () => {
  await Speech.stop();
  mockQueue.length = 0;
  mockLog.length = 0;
  mockSpeakError = null;
  progress.length = 0;
  unsub = Speech.onChunkProgress(e => progress.push(e));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  unsub();
});

describe('OS engine stream: progress and playback state', () => {
  test('chunk progress fires when each utterance starts, not when it is queued', async () => {
    const stream = Speech.createSpeechStream();
    const streamEvents: string[] = [];
    stream.onProgress(e =>
      streamEvents.push(
        `${e.batchIndex}:${e.streamRange.start}-${e.streamRange.end}`,
      ),
    );
    stream.append('Alpha one. Bravo two. ');
    await tick();
    // Dispatch is unchanged: both sentences are queued natively at once.
    expect(mockQueue.length).toBe(2);
    expect(progress).toHaveLength(0);

    const first = startHead();
    expect(progress.map(e => e.chunkText.trim())).toEqual(['Alpha one.']);
    expect(progress[0]!.id).toBe(first.id);
    finishHead();
    await tick();
    startHead();
    expect(progress.map(e => e.chunkText.trim())).toEqual([
      'Alpha one.',
      'Bravo two.',
    ]);
    expect(streamEvents).toEqual(['0:0-11', '1:11-22']);
    finishHead();
    await stream.finalize();
  });

  test('finalize() resolves only after the last utterance finishes', async () => {
    const stream = Speech.createSpeechStream();
    stream.append('Alpha one. Bravo two. Charlie three.');
    let done = false;
    const fin = stream.finalize().then(() => {
      done = true;
    });
    let played = 0;
    for (let i = 0; i < 10 && !done; i++) {
      await tick();
      if (mockQueue.length) {
        startHead();
        await tick();
        expect(done).toBe(false);
        finishHead();
        played++;
      }
    }
    await fin;
    expect(played).toBeGreaterThanOrEqual(2);
    expect(done).toBe(true);
    expect(mockLog.filter(l => l.startsWith('speak:')).join(' ')).toContain(
      'Charlie three.',
    );
  });

  test('cancel() while an utterance plays: native stop, no progress afterwards, finalize settles', async () => {
    const stream = Speech.createSpeechStream();
    stream.append('Alpha one. Bravo two. ');
    await tick();
    startHead();
    const fin = stream.finalize();
    const before = progress.length;
    const spoken = mockLog.filter(l => l.startsWith('speak:')).length;
    await stream.cancel();
    await fin;
    expect(mockLog).toContain('stop');
    // A late start of a stopped utterance must not surface.
    mockEmit('onStart', 999);
    await tick(20);
    expect(progress.length).toBe(before);
    expect(mockLog.filter(l => l.startsWith('speak:')).length).toBe(spoken);
  });

  test('Speech.stop() mid-stream ends the stream: buffered text is not spoken later', async () => {
    const stream = Speech.createSpeechStream();
    stream.append('Alpha one. Bravo');
    await tick();
    startHead();
    await Speech.stop();
    stream.append(' two. Charlie three.');
    await stream.finalize();
    await tick(20);
    expect(mockLog.filter(l => l.startsWith('speak:'))).toEqual([
      'speak:Alpha one.',
    ]);
  });

  test('a stale onStopped after stop does not settle the next utterance', async () => {
    const a = Speech.createSpeechStream();
    a.append('Alpha one. ');
    await tick();
    const stale = startHead();
    const b = Speech.createSpeechStream();
    b.append('Bravo two. ');
    await tick();
    let bDone = false;
    const bFin = b.finalize().then(() => {
      bDone = true;
    });
    mockEmit('onStopped', stale.id);
    await tick(20);
    expect(bDone).toBe(false);
    startHead();
    finishHead();
    await bFin;
    expect(progress.map(e => e.chunkText.trim())).toEqual([
      'Alpha one.',
      'Bravo two.',
    ]);
  });

  test('a native speak error rejects finalize() instead of hanging', async () => {
    mockSpeakError = new Error('boom');
    const onError = jest.fn();
    const stream = Speech.createSpeechStream(undefined, {onError});
    stream.append('Alpha one. ');
    await expect(stream.finalize()).rejects.toThrow('boom');
    expect(onError).toHaveBeenCalled();
  });

  test('a native onError ends that utterance and the stream goes on', async () => {
    const stream = Speech.createSpeechStream();
    stream.append('Alpha one. Bravo two. ');
    const fin = stream.finalize();
    await tick();
    const head = startHead();
    mockQueue.shift();
    mockEmit('onError', head.id);
    await tick();
    startHead();
    finishHead();
    await fin;
    expect(mockLog.filter(l => l.startsWith('speak:'))).toEqual([
      'speak:Alpha one.',
      'speak:Bravo two.',
    ]);
  });
});

describe('OS engine: event edge cases', () => {
  test('a repeated onStart (Android resume) is not taken as the next utterance', async () => {
    await Speech.speak('Alpha one.');
    await Speech.speak('Bravo two.');
    const a = startHead();
    mockEmit('onStart', a.id);
    expect(progress.map(e => e.chunkText)).toEqual(['Alpha one.']);
    finishHead();
    startHead();
    expect(progress.map(e => e.chunkText)).toEqual([
      'Alpha one.',
      'Bravo two.',
    ]);
    finishHead();
  });

  test('speak() during a stream replaces it; the new utterance keeps its progress', async () => {
    const stream = Speech.createSpeechStream();
    stream.append('Alpha one. ');
    await tick();
    startHead();
    const fin = stream.finalize();
    await Speech.speak('Bravo two.');
    await fin;
    expect(mockLog.slice(mockLog.indexOf('speak:Alpha one.') + 1)).toEqual([
      'stop',
      'speak:Bravo two.',
    ]);
    startHead();
    expect(progress.map(e => e.chunkText.trim())).toEqual([
      'Alpha one.',
      'Bravo two.',
    ]);
    finishHead();
  });
});

describe('Add-on engine without synthesizeStream: stream unchanged', () => {
  test('Speech.stop() does not end its stream; batches resolve as the engine does', async () => {
    const said: string[] = [];
    Speech.registerEngine({
      name: 'tier1-addon',
      initialize: async () => {},
      isReady: async () => true,
      synthesize: async (text: any) => {
        said.push(String(text).trim());
      },
      getAvailableVoices: async () => [],
      stop: async () => {},
      destroy: async () => {},
      release: async () => ({success: true, partialRelease: false, errors: []}),
    } as any);
    await Speech.initialize({engine: 'tier1-addon'} as any);
    try {
      const stream = Speech.createSpeechStream();
      stream.append('Alpha one. ');
      await tick();
      await Speech.stop();
      stream.append('Bravo two. ');
      await stream.finalize();
      expect(said).toEqual(['Alpha one.', 'Bravo two.']);
    } finally {
      await Speech.initialize({engine: 'os-native' as any});
    }
  });
});

describe('OS engine speak(): unchanged, plus progress', () => {
  test('speak() resolves on dispatch and queues; progress fires at each start', async () => {
    await Speech.speak('Alpha one.');
    await Speech.speak('Bravo two.');
    expect(mockLog.filter(l => l.startsWith('speak:'))).toEqual([
      'speak:Alpha one.',
      'speak:Bravo two.',
    ]);
    expect(mockQueue).toHaveLength(2);
    expect(progress).toHaveLength(0);
    startHead();
    finishHead();
    startHead();
    expect(
      progress.map(e => [e.chunkText, e.chunkIndex, e.totalChunks]),
    ).toEqual([
      ['Alpha one.', 0, 1],
      ['Bravo two.', 0, 1],
    ]);
    finishHead();
  });
});
