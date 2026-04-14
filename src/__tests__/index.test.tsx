/**
 * Public API contract test.
 *
 * Verifies that the package's public surface (default export + named
 * exports) is shaped the way consumers expect. If anything here changes
 * shape, downstream apps will break — so we want a fast signal.
 */

// Stub the native modules and FS dep so the engine classes and the
// Speech façade can be imported without a real RN runtime.
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

// Mock onnxruntime-react-native at module-eval time so the engine
// classes can be imported without crashing in a Node test env.
jest.mock(
  'onnxruntime-react-native',
  () => ({
    InferenceSession: {create: jest.fn()},
    Tensor: jest.fn(),
  }),
  {virtual: true},
);

import Speech, {
  engineManager,
  KokoroEngine,
  SupertonicEngine,
  KittenEngine,
  OSEngine,
  TTSEngine,
} from '../index';

describe('public API surface', () => {
  it('exports a default Speech class', () => {
    expect(Speech).toBeDefined();
    // Speech is exported as the default — accept either a class or instance.
    expect(['function', 'object']).toContain(typeof Speech);
  });

  it('exports engineManager singleton', () => {
    expect(engineManager).toBeDefined();
    expect(typeof engineManager).toBe('object');
  });

  it('exports per-engine classes', () => {
    expect(typeof KokoroEngine).toBe('function');
    expect(typeof SupertonicEngine).toBe('function');
    expect(typeof KittenEngine).toBe('function');
    expect(typeof OSEngine).toBe('function');
  });

  it('exports TTSEngine enum/values', () => {
    expect(TTSEngine).toBeDefined();
  });

  it('engine classes are instantiable and self-identify', () => {
    const k = new KokoroEngine();
    const s = new SupertonicEngine();
    const ki = new KittenEngine();
    expect(k.name).toBe('kokoro');
    expect(s.name).toBe('supertonic');
    expect(ki.name).toBe('kitten');
  });
});
