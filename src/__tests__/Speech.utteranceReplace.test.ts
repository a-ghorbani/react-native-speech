/**
 * OS engine (#72): a stream replaces a running speak() and is replaced by
 * a new speak() or stream; speak() after speak() still queues natively.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});

/** Native calls in order: "speak:<text>" or "stop". */
const mockNative: string[] = [];
jest.mock('../NativeSpeech', () => {
  const store: Record<string, unknown> = {
    speak: jest.fn(async (text: string) => {
      mockNative.push(`speak:${text.trim()}`);
    }),
    speakWithOptions: jest.fn(async (text: string) => {
      mockNative.push(`speak:${text.trim()}`);
    }),
    stop: jest.fn(async () => {
      mockNative.push('stop');
    }),
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

import Speech from '../Speech';

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

/** Native calls after the first one that matches `marker`. */
const after = (marker: string) =>
  mockNative.slice(mockNative.indexOf(marker) + 1);

beforeAll(async () => {
  await Speech.initialize({engine: 'os-native' as any});
});

beforeEach(() => {
  mockNative.length = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

describe('OS engine: a stream replaces, speak() queues', () => {
  test('speak -> speak queues natively (no stop)', async () => {
    await Speech.speak('Alpha one.');
    await Speech.speak('Bravo one.');
    expect(mockNative).toEqual(['speak:Alpha one.', 'speak:Bravo one.']);
  });

  test('speak -> stream flushes the running speak first', async () => {
    await Speech.speak('Alpha one.');
    const s = Speech.createSpeechStream();
    s.append('Bravo one. ');
    await s.finalize();
    const firstB = mockNative.indexOf('speak:Bravo one.');
    expect(firstB).toBeGreaterThan(0);
    expect(mockNative.slice(1, firstB)).toContain('stop');
  });

  test.each(['speak', 'stream'] as const)(
    'stream -> %s: the old stream sends nothing more after the new one starts',
    async second => {
      const a = Speech.createSpeechStream();
      a.append('Alpha one. ');
      await tick();

      if (second === 'speak') {
        await Speech.speak('Bravo one.');
      } else {
        const b = Speech.createSpeechStream();
        b.append('Bravo one. ');
        await b.finalize();
      }
      // The old stream's source (e.g. an LLM) keeps producing.
      a.append('Alpha two. ');
      await a.finalize();
      await tick();

      const firstB = mockNative.indexOf('speak:Bravo one.');
      expect(firstB).toBeGreaterThan(0);
      expect(
        after('speak:Bravo one.').filter(c => c.includes('Alpha')),
      ).toEqual([]);
      // The old stream's queued batches are flushed before B is queued.
      expect(
        mockNative.slice(mockNative.indexOf('speak:Alpha one.'), firstB),
      ).toContain('stop');
    },
  );
});
