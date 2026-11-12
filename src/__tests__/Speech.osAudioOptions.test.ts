/**
 * OS engine (#140): `ducking` and `silentMode` reach the native speak call,
 * from the call's own options first, then from Speech.initialize().
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});

/** Native speak calls: [text, options | undefined]. */
const mockCalls: Array<[string, Record<string, unknown> | undefined]> = [];
let mockNextId = 1;

jest.mock('../NativeSpeech', () => {
  const store: Record<string, unknown> = {
    speak: jest.fn(async (text: string) => {
      mockCalls.push([text.trim(), undefined]);
      return mockNextId++;
    }),
    speakWithOptions: jest.fn(
      async (text: string, options: Record<string, unknown>) => {
        mockCalls.push([text.trim(), options]);
        return mockNextId++;
      },
    ),
    stop: jest.fn(async () => {}),
    onStart: () => ({remove: () => {}}),
    onFinish: () => ({remove: () => {}}),
    onStopped: () => ({remove: () => {}}),
    onError: () => ({remove: () => {}}),
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

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

/** The audio options of the native call that spoke `text`. */
function audioOptionsOf(text: string) {
  const call = mockCalls.find(([t]) => t === text);
  expect(call).toBeDefined();
  const options = call![1];
  return {ducking: options?.ducking, silentMode: options?.silentMode};
}

beforeEach(async () => {
  await Speech.initialize({engine: 'os-native' as any});
  await Speech.stop();
  mockCalls.length = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('OS engine: ducking and silentMode reach native', () => {
  test('Speech.initialize() defaults apply to speak()', async () => {
    await Speech.initialize({
      engine: 'os-native',
      ducking: true,
      silentMode: 'respect',
    } as any);
    await Speech.speak('Alpha one.');
    expect(audioOptionsOf('Alpha one.')).toEqual({
      ducking: true,
      silentMode: 'respect',
    });
  });

  test("a speak()'s own options win over the defaults", async () => {
    await Speech.initialize({
      engine: 'os-native',
      ducking: true,
      silentMode: 'respect',
    } as any);
    await Speech.speak('Alpha one.', undefined, {
      ducking: false,
      silentMode: 'ignore',
    });
    expect(audioOptionsOf('Alpha one.')).toEqual({
      ducking: false,
      silentMode: 'ignore',
    });
  });

  test('speak() options without any defaults', async () => {
    await Speech.speak('Alpha one.', undefined, {ducking: true});
    expect(audioOptionsOf('Alpha one.').ducking).toBe(true);
  });

  test('a stream passes its options and the defaults on every batch', async () => {
    await Speech.initialize({
      engine: 'os-native',
      silentMode: 'respect',
    } as any);
    const stream = Speech.createSpeechStream(undefined, {ducking: true});
    stream.append('Alpha one. Bravo two. ');
    await tick();
    expect(audioOptionsOf('Alpha one.')).toEqual({
      ducking: true,
      silentMode: 'respect',
    });
    expect(audioOptionsOf('Bravo two.')).toEqual({
      ducking: true,
      silentMode: 'respect',
    });
    await stream.cancel();
  });

  test('a later initialize() without them clears the defaults', async () => {
    await Speech.initialize({engine: 'os-native', ducking: true} as any);
    await Speech.initialize({engine: 'os-native'} as any);
    await Speech.speak('Alpha one.');
    expect(audioOptionsOf('Alpha one.')).toEqual({
      ducking: undefined,
      silentMode: undefined,
    });
  });
});
