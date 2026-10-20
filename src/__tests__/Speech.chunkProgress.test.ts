/**
 * Speech chunk-progress fan-out: listeners stack, and a stream's
 * subscription must not replace or remove an app-level listener.
 */
import type {ChunkProgressCallback, ChunkProgressEvent} from '../types';

jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('../NativeSpeech', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'getConstants') return () => ({maxInputLength: 4000});
        return () => undefined;
      },
    },
  ),
}));
jest.mock('../NativeAudioPlayer', () => ({
  __esModule: true,
  default: new Proxy({}, {get: () => () => undefined}),
}));
jest.mock('../engines/EngineManager', () => ({
  engineManager: {
    registerEngine: jest.fn(),
    initializeEngine: jest.fn(async () => {}),
    reinitializeEngine: jest.fn(async () => {}),
    setDefaultEngine: jest.fn(),
  },
}));

// Capture the dispatcher Speech hands to the engine.
let engineCallback: ChunkProgressCallback | null = null;
jest.mock('../engines/kitten', () => ({
  KittenEngine: class {
    name = 'kitten';
    setChunkProgressCallback(cb: ChunkProgressCallback | null) {
      engineCallback = cb;
    }
  },
}));

import Speech from '../Speech';

function event(n: number): ChunkProgressEvent {
  return {
    id: 0,
    chunkIndex: n,
    totalChunks: 0,
    chunkText: `chunk ${n}`,
    textRange: {start: n, end: n + 1},
    progress: 0,
  };
}

describe('Speech chunk progress listeners', () => {
  beforeAll(async () => {
    await Speech.initialize({engine: 'kitten'} as any);
  });

  test('engine receives a dispatcher at init', () => {
    expect(typeof engineCallback).toBe('function');
  });

  test('app listener survives a stream subscribing and unsubscribing', () => {
    const app = jest.fn();
    const unApp = Speech.onChunkProgress(app);

    const stream = jest.fn();
    const unStream = Speech.onChunkProgress(stream);
    engineCallback!(event(1));
    unStream();
    engineCallback!(event(2));

    expect(stream).toHaveBeenCalledTimes(1);
    expect(app).toHaveBeenCalledTimes(2);
    unApp();
    engineCallback!(event(3));
    expect(app).toHaveBeenCalledTimes(2);
  });

  test('a stale unsubscribe only removes its own listener', () => {
    const a = jest.fn();
    const b = jest.fn();
    const unA = Speech.onChunkProgress(a);
    const unB = Speech.onChunkProgress(b);
    unA();
    unA();
    engineCallback!(event(1));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    unB();
  });

  test('the same callback subscribed twice needs two unsubscribes', () => {
    const cb = jest.fn();
    const un1 = Speech.onChunkProgress(cb);
    const un2 = Speech.onChunkProgress(cb);
    un1();
    engineCallback!(event(1));
    expect(cb).toHaveBeenCalledTimes(1);
    un2();
  });

  test('setChunkProgressCallback coexists with listeners', () => {
    const slot = jest.fn();
    const listener = jest.fn();
    Speech.setChunkProgressCallback(slot);
    const un = Speech.onChunkProgress(listener);
    engineCallback!(event(1));
    Speech.setChunkProgressCallback(null);
    engineCallback!(event(2));
    expect(slot).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    un();
  });

  test('a throwing listener does not block the others', () => {
    const bad = Speech.onChunkProgress(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const un = Speech.onChunkProgress(good);
    engineCallback!(event(1));
    expect(good).toHaveBeenCalledTimes(1);
    bad();
    un();
  });
});
