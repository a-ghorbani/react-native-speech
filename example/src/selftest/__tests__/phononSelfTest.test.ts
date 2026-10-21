/**
 * Phonon self-test: deep-link parsing, metric helpers, and both runner
 * paths (unsupported device; supported device with a scripted engine)
 * against mocks of the library, RNFS and the native benchmark module.
 */

type Listener = (...args: any[]) => void;

const mockState = {
  supported: true,
  reason: 'ok',
  start: new Set<Listener>(),
  stopped: new Set<Listener>(),
  chunk: new Set<Listener>(),
  lastMetrics: null as any,
  requestId: 0,
  lastVoice: '',
  currentEngine: 'kitten',
  files: new Map<string, string>(),
  markers: [] as string[],
  initCalls: [] as any[],
  model: true as boolean,
  /** S6: a chunk starts playing 5 ms after stop() */
  playAfterStop: false,
  /** /proc/self/maps as the app would read it (Android) */
  maps: '',
  /** utime+stime the next /proc/self/stat read reports */
  cpuTicks: 0,
};

function mockEmit(set: Set<Listener>, ...args: any[]) {
  [...set].forEach(l => l(...args));
}

function mockPlayChunk(voice = '') {
  mockEmit(mockState.chunk, {chunkIndex: mockState.requestId});
  mockEmit(mockState.start);
  const now = Date.now();
  mockState.lastMetrics = {
    event: 'PHONON_CHUNK',
    path: 'synth',
    requestId: ++mockState.requestId,
    chars: 10,
    samples: 24000,
    audioSec: 1,
    ttfaMs: 120,
    totalMs: 250,
    queuedMs: 3,
    startedAtMs: 0,
    finishedAtMs: 0,
    playStartTs: now,
    playEndTs: now + 1,
    voiceChanged: voice !== mockState.lastVoice,
  };
  mockState.lastVoice = voice;
}

jest.mock('@pocketpalai/react-native-speech', () => {
  const sub = (key: 'start' | 'stopped') => (cb: Listener) => {
    mockState[key].add(cb);
    return {remove: () => mockState[key].delete(cb)};
  };
  const Speech = {
    getEngineSupport: jest.fn(async () => ({
      supported: mockState.supported,
      reason: mockState.reason,
    })),
    getCurrentEngine: jest.fn(() => mockState.currentEngine),
    initialize: jest.fn(async (config: any) => {
      mockState.initCalls.push(config);
      if (config.engine === 'phonon' && !mockState.supported) {
        throw Object.assign(new Error('unsupported'), {
          code: 'ERR_PHONON_UNSUPPORTED',
        });
      }
      mockState.currentEngine = config.engine;
    }),
    release: jest.fn(async () => ({success: true, errors: []})),
    speak: jest.fn(async (_text: string, voice?: string, opts?: any) => {
      mockPlayChunk(voice ?? '');
      opts?.onAudioChunk?.({
        samples: new Float32Array([0.2, -0.2, 0.2, -0.2]),
        sampleRate: 24000,
        channels: 1,
        duration: 1,
      });
    }),
    stop: jest.fn(async () => {
      mockEmit(mockState.stopped);
      if (mockState.playAfterStop) {
        mockState.playAfterStop = false;
        mockPlayChunk();
        mockState.lastMetrics.playStartTs = Date.now() + 5;
      }
    }),
    pause: jest.fn(async () => true),
    resume: jest.fn(async () => true),
    createSpeechStream: jest.fn(() => ({
      append: jest.fn(),
      finalize: async () => {
        mockState.lastMetrics = null;
        mockPlayChunk();
      },
    })),
    onStart: sub('start'),
    onStopped: sub('stopped'),
    onChunkProgress: (cb: Listener) => {
      mockState.chunk.add(cb);
      return () => mockState.chunk.delete(cb);
    },
  };
  return {
    __esModule: true,
    default: Speech,
    TTSEngine: {OS_NATIVE: 'os-native', PHONON: 'phonon', KITTEN: 'kitten'},
    PhononEngine: {
      getSupport: jest.fn(async () => ({
        supported: mockState.supported,
        reason: mockState.reason,
        detail: '',
        abi: 'arm64-v8a',
        osVersion: '16',
        libraryVersion: mockState.supported ? '0.4.0-r1' : '',
        isSimulator: false,
        pageSize: 4096,
      })),
      needsCompile: jest.fn(async () => false),
      getDiagnostics: jest.fn(async () => ({
        memKb: 100_000,
        peakMemKb: 150_000,
        threads: 40,
        libraryLoaded: mockState.supported,
        handleOpen: mockState.supported,
        liveBuffers: 0,
        orphanBuffers: 0,
        busy: 'idle',
        lastIssuedId: mockState.requestId,
        cancelWatermark: 0,
      })),
    },
    engineManager: {
      getEngine: () => ({
        getLoadInfo: () => ({
          handleId: 1,
          voices: ['Alfie', 'Maeve', 'Zoey', 'default'],
          languages: ['en'],
          defaultVoice: 'default',
          sampleRate: 24000,
          loadMs: 80,
          compiled: false,
          numThreads: 4,
          computeUnit: 'cpu',
        }),
        getLastMetrics: () =>
          mockState.lastMetrics ? {...mockState.lastMetrics} : null,
      }),
    },
  };
});

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  ExternalDirectoryPath: '/ext',
  exists: jest.fn(async (p: string) => mockState.files.has(p)),
  readFile: jest.fn(async (p: string) => {
    if (p === '/proc/self/maps') {
      return mockState.maps;
    }
    if (p === '/proc/self/stat') {
      mockState.cpuTicks += 50;
      return `4242 (speech.example) S 1 2 3 4 5 6 7 8 9 10 ${mockState.cpuTicks} 0 0 0`;
    }
    if (!mockState.files.has(p)) {
      throw new Error(`ENOENT ${p}`);
    }
    return mockState.files.get(p);
  }),
  unlink: jest.fn(async (p: string) => {
    mockState.files.delete(p);
  }),
  copyFile: jest.fn(async (from: string, to: string) => {
    mockState.files.set(to, mockState.files.get(from) ?? '');
  }),
  readDir: jest.fn(async (dir: string) => {
    const names = new Map<string, boolean>();
    for (const f of mockState.files.keys()) {
      if (f.startsWith(`${dir}/`)) {
        const rest = f.slice(dir.length + 1);
        const slash = rest.indexOf('/');
        names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
      }
    }
    return [...names].map(([name, isDir]) => ({
      name,
      path: `${dir}/${name}`,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    }));
  }),
  mkdir: jest.fn(async () => {}),
  writeFile: jest.fn(async (p: string, c: string) => {
    mockState.files.set(p, c);
  }),
  appendFile: jest.fn(async (p: string, c: string) => {
    mockState.files.set(p, (mockState.files.get(p) ?? '') + c);
  }),
}));

jest.mock('../../benchmark/NativeBenchmark', () => ({
  __esModule: true,
  default: {
    logMarker: (m: string) => mockState.markers.push(m),
    captureScreen: jest.fn(async (p: string) => p),
  },
}));

jest.mock('../../utils/wavWriter', () => ({
  saveChunksAsWav: jest.fn(async (_c: unknown, name: string) => ({
    path: `/docs/${name}`,
    bytes: 1000,
    durationSec: 3.3,
    sampleRate: 24000,
  })),
}));

jest.mock('../../utils/PhononModelManager', () => ({
  phononModelManager: {
    scanInstalledModel: jest.fn(async () => {}),
    getInstalledModel: jest.fn(() =>
      mockState.model ? {variant: '31m-en'} : null,
    ),
    getDownloadedModelConfig: jest.fn(() => ({
      modelPath: '/docs/phonon/models/31m-en',
      language: 'en',
      voicesMetadataPath: '/docs/phonon/models/31m-en/voices.jsonl',
    })),
    getVariantDirectory: jest.fn(() => '/docs/phonon/models/31m-en'),
    setIosMirror: jest.fn(),
    downloadModel: jest.fn(async () => {}),
    installFromDirectory: jest.fn(async () => {}),
  },
}));

import {
  AppState,
  DevSettings,
  Platform,
  TurboModuleRegistry,
} from 'react-native';
import {
  PHONON_SCENARIOS,
  countMapsLines,
  cpuTicksFromStat,
  relevantMapsLines,
  errorCode,
  parseSelfTestUrl,
  playbackGaps,
  realTimeFactor,
  rms,
  runPhononSelfTest,
  summarize,
  isPhononSelfTestRunning,
  onPhononSelfTestDone,
  resumePhononSelfTestAfterReload,
} from '../phononSelfTest';
import {phononModelManager} from '../../utils/PhononModelManager';

const NOW = new Date('2026-10-21T10:20:30.456Z');

describe('parseSelfTestUrl', () => {
  it('parses the documented deep link', () => {
    const p = parseSelfTestUrl(
      'speechexample://selftest/phonon?runs=5&threads=4&spin=200',
      NOW,
    )!;
    expect(p).toMatchObject({
      runs: 5,
      threads: 4,
      spin: 200,
      cycles: 10,
      download: false,
      runId: '20261021T102030',
    });
    expect([...p.scenarios]).toEqual([...PHONON_SCENARIOS]);
    expect(p.hold).toBe(1500);
  });

  it('s11 is opt-in only; hold is clamped', () => {
    expect(
      parseSelfTestUrl('speechexample://selftest/phonon', NOW)!.scenarios.has(
        's11',
      ),
    ).toBe(false);
    const p = parseSelfTestUrl(
      'speechexample://selftest/phonon?scenarios=s11,s4&hold=999999',
      NOW,
    )!;
    expect([...p.scenarios].sort()).toEqual(['s1', 's11', 's2', 's4']);
    expect(p.hold).toBe(60000);
  });

  it('uses defaults without a query', () => {
    const p = parseSelfTestUrl('speechexample://selftest/phonon', NOW)!;
    expect(p).toMatchObject({runs: 5, threads: 0, spin: undefined});
    expect(p.modelPath).toBeUndefined();
  });

  it('reads the optional parameters', () => {
    const p = parseSelfTestUrl(
      'speechexample://selftest/phonon/?scenarios=s3,S6,bogus&runId=ci_1/../x' +
        '&model=%2Fdata%2Flocal%2Ftmp%2Fm&download=1&unit=cpu&cycles=2' +
        '&mirrorRepo=palshub%2Fx&mirrorRev=abc',
      NOW,
    )!;
    expect([...p.scenarios].sort()).toEqual(['s1', 's2', 's3', 's6']);
    expect(p).toMatchObject({
      runId: 'ci_1..x',
      modelPath: '/data/local/tmp/m',
      download: true,
      computeUnit: 'cpu',
      cycles: 2,
      mirrorRepo: 'palshub/x',
      mirrorRev: 'abc',
    });
  });

  it('clamps numbers and ignores junk', () => {
    const p = parseSelfTestUrl(
      'speechexample://selftest/phonon?runs=999&threads=-3&spin=abc&unit=gpu',
      NOW,
    )!;
    expect(p.runs).toBe(50);
    expect(p.threads).toBe(0);
    expect(p.spin).toBe(0);
    expect(p.computeUnit).toBeUndefined();
  });

  it.each([
    'https://example.com/selftest/phonon',
    'speechexample://selftest/kitten',
    'speechexample://other',
    '',
  ])('ignores %s', url => {
    expect(parseSelfTestUrl(url, NOW)).toBeNull();
  });
});

describe('metric helpers', () => {
  it('summarize: median and p90', () => {
    expect(summarize([5, 1, 3, 2, 4])).toEqual({
      n: 5,
      min: 1,
      max: 5,
      median: 3,
      p90: 5,
    });
    expect(summarize([1, 2, 3, 4])!.median).toBe(2.5);
    expect(summarize([NaN])).toBeNull();
    expect(summarize([])).toBeNull();
  });

  it('playbackGaps: next start minus previous end, in play order', () => {
    expect(
      playbackGaps([
        {playStartTs: 2000, playEndTs: 3000},
        {playStartTs: 0, playEndTs: 1900},
        {playStartTs: 3050, playEndTs: 4000},
      ]),
    ).toEqual([100, 50]);
    expect(playbackGaps([{playStartTs: 0, playEndTs: 1}])).toEqual([]);
  });

  it('realTimeFactor, rms, errorCode', () => {
    expect(realTimeFactor(500, 2)).toBe(0.25);
    expect(realTimeFactor(500, 0)).toBeNaN();
    expect(
      rms([
        {
          samples: new Float32Array([0.5, -0.5]),
          sampleRate: 1,
          channels: 1,
          duration: 1,
        },
      ]),
    ).toBeCloseTo(0.5);
    expect(rms([])).toBe(0);
    expect(errorCode({code: 'ERR_X'})).toBe('ERR_X');
    expect(errorCode(new Error('x'))).toBe('none');
  });

  it('countMapsLines and cpuTicksFromStat', () => {
    const maps =
      '7f00-7f10 r--p 0 fd:01 1 /data/app/x/lib/arm64/libptts_ffi.so\n' +
      '7f10-7f20 r-xp 0 fd:01 1 /data/app/x/lib/arm64/libptts_ffi.so\n' +
      '7f20-7f30 r-xp 0 fd:01 2 /data/app/x/lib/arm64/librnspeech_phonon.so\n';
    expect(countMapsLines(maps, 'libptts_ffi')).toBe(2);
    expect(countMapsLines('', 'libptts_ffi')).toBe(0);
    // comm with spaces and a paren; utime=7, stime=5 (fields 14, 15).
    expect(
      cpuTicksFromStat('99 (a b) c) R 1 2 3 4 5 6 7 8 9 10 7 5 0 0 20'),
    ).toBe(12);
    expect(cpuTicksFromStat('garbage')).toBeNull();
    expect(
      relevantMapsLines(
        '1-2 r--p 0 0:0 1 /system/lib64/libc.so\n' +
          '3-4 r-xp 2000 0:0 2 /data/app/x/base.apk\n' +
          '5-6 r-xp 0 0:0 3 /data/app/x/lib/arm64/libptts_ffi.so\n',
      ),
    ).toEqual([
      '3-4 r-xp 2000 0:0 2 /data/app/x/base.apk',
      '5-6 r-xp 0 0:0 3 /data/app/x/lib/arm64/libptts_ffi.so',
    ]);
    expect(cpuTicksFromStat('1 (x) R 1')).toBeNull();
  });
});

describe('runPhononSelfTest', () => {
  const sleep = () => Promise.resolve();

  beforeEach(() => {
    mockState.supported = true;
    mockState.reason = 'ok';
    mockState.start.clear();
    mockState.stopped.clear();
    mockState.chunk.clear();
    mockState.lastMetrics = null;
    mockState.lastVoice = '';
    mockState.currentEngine = 'kitten';
    mockState.files.clear();
    mockState.markers = [];
    mockState.initCalls = [];
    mockState.model = true;
    mockState.playAfterStop = false;
    mockState.maps = '';
    mockState.cpuTicks = 0;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function selftestJson(runId: string) {
    return JSON.parse(
      mockState.files.get(`/docs/phonon-evidence/${runId}/selftest.json`)!,
    );
  }

  it('unsupported: records the probe, direct-init code, no library, OS speak', async () => {
    mockState.supported = false;
    mockState.reason = 'missing-cpu-features';
    const params = parseSelfTestUrl(
      'speechexample://selftest/phonon?runId=u1',
      NOW,
    )!;
    const tabs: string[] = [];
    const summary = await runPhononSelfTest(params, {
      sleep,
      showTab: t => tabs.push(t),
    });

    expect(summary.supported).toBe(false);
    expect(summary.failed).toBe(0);
    expect(summary.results.map(r => r.name)).toEqual([
      'S1_support',
      'U_direct_init',
      'U_library_not_loaded',
      'U_os_native_speak',
    ]);
    expect(summary.results[1]!.data).toMatchObject({
      code: 'ERR_PHONON_UNSUPPORTED',
      before: 'kitten',
      after: 'kitten',
    });
    expect(tabs).toEqual(['demo', 'benchmark', 'demo']);

    const json = selftestJson('u1');
    expect(json.support.reason).toBe('missing-cpu-features');
    expect(json.failed).toBe(0);
    const bench = mockState.files.get('/docs/phonon-evidence/u1/bench.jsonl')!;
    const events = bench
      .trim()
      .split('\n')
      .map(l => JSON.parse(l).event);
    expect(events[0]).toBe('SELFTEST_START');
    expect(events).toContain('PHONON_UNSUPPORTED');
    expect(events[events.length - 1]).toBe('SELFTEST_DONE');
    expect(mockState.markers.some(m => m.includes('SELFTEST_DONE'))).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[SelfTest\] SELFTEST_DONE passed=4 failed=0 /),
    );
    expect(isPhononSelfTestRunning()).toBe(false);
  });

  it('supported: runs every scenario and writes the evidence set', async () => {
    const params = parseSelfTestUrl(
      'speechexample://selftest/phonon?runs=3&threads=4&spin=200&cycles=2&runId=s',
      NOW,
    )!;
    const summary = await runPhononSelfTest(params, {sleep});

    const failed = summary.results.filter(r => !r.pass);
    expect(failed).toEqual([]);
    expect(summary.results.map(r => r.name)).toEqual([
      'S1_support',
      'S2_init',
      'S3_short_speak',
      'S4_long_speak',
      'S5_stream_clause',
      'S5_stream_sentence',
      'S6_stop',
      'S7_voice_switch',
      'S9_pause_resume',
      'S10_capture',
      'S8_init_release',
      'S12_peak_memory',
    ]);
    // Init got the deep-link knobs.
    expect(mockState.initCalls[0]).toMatchObject({
      engine: 'phonon',
      modelPath: '/docs/phonon/models/31m-en',
      numThreads: 4,
      spinBudget: 200,
    });
    const s3 = summary.results.find(r => r.name === 'S3_short_speak')!;
    expect((s3.data!.runs as unknown[]).length).toBe(3);
    expect(s3.data!.rtf).toMatchObject({median: 0.25});

    const s7 = summary.results.find(r => r.name === 'S7_voice_switch')!;
    expect((s7.data!.rows as any[]).map(r => r.voiceChanged)).toEqual([
      true,
      false,
      true,
      true,
    ]);

    const json = selftestJson('s');
    expect(json.load.numThreads).toBe(4);
    expect(json.results).toHaveLength(12);
    const bench = mockState.files.get('/docs/phonon-evidence/s/bench.jsonl')!;
    expect(bench).toContain('"event":"PHONON_CHUNK"');
    expect(bench).toContain('"event":"SCREENSHOT_READY"');
  });

  it('supported without a model: one failing init result, no speak', async () => {
    mockState.model = false;
    const params = parseSelfTestUrl(
      'speechexample://selftest/phonon?runId=nomodel',
      NOW,
    )!;
    const summary = await runPhononSelfTest(params, {sleep});
    expect(summary.results.map(r => [r.name, r.pass])).toEqual([
      ['S1_support', true],
      ['S2_init', false],
    ]);
    expect(phononModelManager.downloadModel).not.toHaveBeenCalled();
  });

  it('download=1 fetches the default model first', async () => {
    mockState.model = false;
    (phononModelManager.downloadModel as jest.Mock).mockImplementationOnce(
      async () => {
        mockState.model = true;
      },
    );
    const params = parseSelfTestUrl(
      'speechexample://selftest/phonon?download=1&scenarios=s3&runs=1&runId=dl',
      NOW,
    )!;
    const summary = await runPhononSelfTest(params, {sleep});
    expect(phononModelManager.downloadModel).toHaveBeenCalledWith('31m-en');
    expect(summary.failed).toBe(0);
    expect(summary.results.map(r => r.name)).toEqual([
      'S1_support',
      'S2_init',
      'S3_short_speak',
    ]);
  });

  it('modelFrom=<dir> installs the default model from a pushed folder', async () => {
    mockState.model = false;
    (phononModelManager.downloadModel as jest.Mock).mockClear();
    (
      phononModelManager.installFromDirectory as jest.Mock
    ).mockImplementationOnce(async () => {
      mockState.model = true;
    });
    const params = parseSelfTestUrl(
      'speechexample://selftest/phonon?modelFrom=%2Fext%2Fpush%2F31m-en&scenarios=s3&runs=1&runId=mf',
      NOW,
    )!;
    const summary = await runPhononSelfTest(params, {sleep});
    expect(phononModelManager.installFromDirectory).toHaveBeenCalledWith(
      '/ext/push/31m-en',
    );
    expect(phononModelManager.downloadModel).not.toHaveBeenCalled();
    expect(summary.failed).toBe(0);
  });

  it('S6 passes when no chunk of the stopped call plays after stop()', async () => {
    const params = parseSelfTestUrl(
      'speechexample://selftest/phonon?scenarios=s6&runId=s6ok',
      NOW,
    )!;
    const summary = await runPhononSelfTest(params, {sleep});
    const s6 = summary.results.find(r => r.name === 'S6_stop')!;
    expect(s6.pass).toBe(true);
    expect(s6.data).toMatchObject({
      chunksPlayedAfterStop: 0,
      nativeStartedBeforeStop: true,
      chunks: 1,
    });
  });

  it('S6 fails by native timestamps when a chunk plays after stop()', async () => {
    mockState.playAfterStop = true;
    const params = parseSelfTestUrl(
      'speechexample://selftest/phonon?scenarios=s6&runId=s6late',
      NOW,
    )!;
    const summary = await runPhononSelfTest(params, {sleep});
    const s6 = summary.results.find(r => r.name === 'S6_stop')!;
    expect(s6.pass).toBe(false);
    expect(s6.data!.chunksPlayedAfterStop).toBe(1);
    expect((s6.data!.lateChunks as any[])[0].playStartAfterStopMs).toBe(5);
    // The JS onStart count is recorded alongside.
    expect(s6.data).toHaveProperty('onStartAfterStop');
    expect(s6.detail).toContain('chunksPlayedAfterStop=1');
  });

  it('tells listeners which engine was current before and after', async () => {
    const events: unknown[] = [];
    const off = onPhononSelfTestDone(e => events.push(e));
    const params = parseSelfTestUrl(
      'speechexample://selftest/phonon?scenarios=s3&runs=1&runId=done',
      NOW,
    )!;
    await runPhononSelfTest(params, {sleep});
    off();
    await runPhononSelfTest(params, {sleep});
    expect(events).toEqual([{engineBefore: 'kitten', engineAfter: 'phonon'}]);
  });

  it('refuses to run twice at once', async () => {
    const params = parseSelfTestUrl(
      'speechexample://selftest/phonon?scenarios=s3&runs=1',
      NOW,
    )!;
    const first = runPhononSelfTest(params, {sleep});
    await expect(runPhononSelfTest(params, {sleep})).rejects.toThrow(
      'already running',
    );
    await first;
  });

  describe('on Android', () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, 'OS', 'android');
    });

    it('unsupported: maps proof, external copy of the evidence', async () => {
      mockState.supported = false;
      mockState.reason = 'missing-cpu-features';
      mockState.maps =
        '7f00-7f10 r-xp 0 fd:01 2 /system/lib64/libc.so\n' +
        '7f00-7f10 r-xp 0 fd:01 3 /data/app/x/base.apk\n';
      const params = parseSelfTestUrl(
        'speechexample://selftest/phonon?runId=u1a',
        NOW,
      )!;
      const summary = await runPhononSelfTest(params, {sleep});
      const maps = summary.results.find(r => r.name === 'U_ptts_not_mapped')!;
      expect(maps.pass).toBe(true);
      expect(maps.detail).toMatch(/^libptts_ffi=0 \(by name; /);
      // The host's offset check reads the APK mappings from maps.txt.
      expect(mockState.files.get('/docs/phonon-evidence/u1a/maps.txt')).toBe(
        '7f00-7f10 r-xp 0 fd:01 3 /data/app/x/base.apk\n',
      );
      expect(summary.failed).toBe(0);
      // Same folder, readable by adb without run-as.
      expect(
        mockState.files.get('/ext/phonon-evidence/u1a/selftest.json'),
      ).toBe(mockState.files.get('/docs/phonon-evidence/u1a/selftest.json'));
      expect(
        mockState.files.get('/ext/phonon-evidence/u1a/bench.jsonl'),
      ).toContain('"event":"SELFTEST_DONE"');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringMatching(
          /SELFTEST_DONE passed=5 failed=0 .* external=\/ext\/phonon-evidence\/u1a$/,
        ),
      );
    });

    it('unsupported: a mapped libptts_ffi fails the proof', async () => {
      mockState.supported = false;
      mockState.maps = '7f00-7f10 r-xp 0 fd:01 1 /data/app/libptts_ffi.so\n';
      const params = parseSelfTestUrl(
        'speechexample://selftest/phonon?runId=u1b',
        NOW,
      )!;
      const summary = await runPhononSelfTest(params, {sleep});
      const maps = summary.results.find(r => r.name === 'U_ptts_not_mapped')!;
      expect(maps.pass).toBe(false);
    });

    it('S3 records CPU over the runs and the idle window; maps in selftest.json', async () => {
      mockState.maps = '7f00-7f10 r-xp 0 fd:01 1 /data/app/libptts_ffi.so\n';
      const params = parseSelfTestUrl(
        'speechexample://selftest/phonon?scenarios=s3&runs=2&runId=cpu',
        NOW,
      )!;
      const summary = await runPhononSelfTest(params, {sleep});
      const s3 = summary.results.find(r => r.name === 'S3_short_speak')!;
      // Each /proc/self/stat read advances 50 ticks (10 ms each).
      expect(s3.data!.cpu).toMatchObject({
        userHz: 100,
        runsCpuMs: 500,
        idleCpuMs: 500,
        cpuMsPerAudioSec: 250,
      });
      expect(selftestJson('cpu').maps).toEqual({
        libptts_ffi: 1,
        librnspeech_phonon: 0,
        apkMappings: 0,
      });
    });

    it('a pushed model folder with voices.jsonl is used as the catalog', async () => {
      mockState.files.set('/ext/m/voices.jsonl', '{}\n');
      const params = parseSelfTestUrl(
        'speechexample://selftest/phonon?scenarios=s3&runs=1&runId=m&model=%2Fext%2Fm',
        NOW,
      )!;
      await runPhononSelfTest(params, {sleep});
      expect(mockState.initCalls[0]).toMatchObject({
        modelPath: '/ext/m',
        voicesMetadataPath: '/ext/m/voices.jsonl',
      });
    });
  });

  describe('S11 interruptions', () => {
    let appStateListeners: Array<(s: string) => void>;

    beforeEach(() => {
      appStateListeners = [];
      // The host: HOME on the marker, then the deep link again.
      (console.log as jest.Mock).mockImplementation((line: string) => {
        if (String(line).includes('S11_BACKGROUND_REQUEST')) {
          setTimeout(() => {
            appStateListeners.forEach(l => l('background'));
            appStateListeners.forEach(l => l('active'));
          }, 0);
        }
      });
      // No native DevSettings unless a test provides one: the JS fallback.
      const realGet = TurboModuleRegistry.get.bind(TurboModuleRegistry);
      jest
        .spyOn(TurboModuleRegistry, 'get')
        .mockImplementation((name: string) =>
          name === 'DevSettings' ? null : realGet(name),
        );
      jest
        .spyOn(AppState, 'addEventListener')
        .mockImplementation((_type: any, cb: any) => {
          appStateListeners.push(cb);
          return {remove: () => {}} as any;
        });
    });

    it('background/foreground on the host markers, then a reload that is not available', async () => {
      (console.log as jest.Mock).mockImplementation((line: string) => {
        if (String(line).includes('S11_BACKGROUND_REQUEST')) {
          // The host presses HOME, then sends the deep link again.
          setTimeout(() => {
            appStateListeners.forEach(l => l('background'));
            appStateListeners.forEach(l => l('active'));
          }, 0);
        }
      });
      const reload = jest
        .spyOn(DevSettings, 'reload')
        .mockImplementation(() => {});
      const params = parseSelfTestUrl(
        'speechexample://selftest/phonon?scenarios=s11&runId=s11rel',
        NOW,
      )!;
      const summary = await runPhononSelfTest(params, {sleep});
      const bg = summary.results.find(r => r.name === 'S11_background')!;
      expect(bg.pass).toBe(true);
      expect(bg.data).toMatchObject({
        states: ['background', 'active'],
        speakOutcome: 'resolved',
        nextSpeakOk: true,
      });
      expect(reload).toHaveBeenCalled();
      const rl = summary.results.find(r => r.name === 'S11_reload')!;
      expect(rl.pass).toBe(false);
      expect(rl.detail).toMatch(/^not-run: /);
      // The marker is gone, so the next app start does not resume.
      expect(
        mockState.files.has('/docs/phonon-evidence/.s11-reload-pending.json'),
      ).toBe(false);
      expect(summary.results[summary.results.length - 1]!.name).toBe(
        'S11_reload',
      );
    });

    it('reloads through the native DevSettings module (JS DevSettings is dev-only)', async () => {
      const nativeReload = jest.fn();
      jest
        .spyOn(TurboModuleRegistry, 'get')
        .mockImplementation((name: string) =>
          name === 'DevSettings'
            ? ({reloadWithReason: nativeReload} as any)
            : null,
        );
      const jsReload = jest
        .spyOn(DevSettings, 'reload')
        .mockImplementation(() => {});
      const params = parseSelfTestUrl(
        'speechexample://selftest/phonon?scenarios=s11&runId=s11native',
        NOW,
      )!;
      await runPhononSelfTest(params, {sleep});
      expect(nativeReload).toHaveBeenCalledWith('phonon self-test S11');
      expect(jsReload).not.toHaveBeenCalled();
    });

    it('re-creates an engine the app released in the background', async () => {
      const diag = jest.requireMock('@pocketpalai/react-native-speech')
        .PhononEngine.getDiagnostics as jest.Mock;
      const original = diag.getMockImplementation()!;
      let calls = 0;
      diag.mockImplementation(async () => ({
        memKb: 1,
        peakMemKb: 1,
        threads: 1,
        libraryLoaded: true,
        // The first read after foreground sees the released handle.
        handleOpen: ++calls !== 1,
        liveBuffers: 0,
        orphanBuffers: 0,
        busy: 'idle',
        lastIssuedId: mockState.requestId,
        cancelWatermark: 0,
      }));
      (console.log as jest.Mock).mockImplementation((line: string) => {
        if (String(line).includes('S11_BACKGROUND_REQUEST')) {
          calls = 0;
          setTimeout(() => {
            appStateListeners.forEach(l => l('background'));
            appStateListeners.forEach(l => l('active'));
          }, 0);
        }
      });
      jest.spyOn(DevSettings, 'reload').mockImplementation(() => {});
      const params = parseSelfTestUrl(
        'speechexample://selftest/phonon?scenarios=s11&runId=s11rel2',
        NOW,
      )!;
      mockState.initCalls = [];
      const summary = await runPhononSelfTest(params, {sleep});
      diag.mockImplementation(original);
      const bg = summary.results.find(r => r.name === 'S11_background')!;
      expect(bg.pass).toBe(true);
      expect(bg.data).toMatchObject({releasedInBackground: true});
      // S2 init + the re-create after foreground.
      expect(
        mockState.initCalls.filter(c => c.engine === 'phonon'),
      ).toHaveLength(2);
    });

    it('fails S11_background when the host never backgrounds the app', async () => {
      (console.log as jest.Mock).mockImplementation(() => {});
      // A fast clock: every read is 5 s later, so the 60 s wait runs out.
      let t = NOW.getTime();
      jest.spyOn(Date, 'now').mockImplementation(() => (t += 5000));
      jest.spyOn(DevSettings, 'reload').mockImplementation(() => {});
      const params = parseSelfTestUrl(
        'speechexample://selftest/phonon?scenarios=s11&runId=s11none',
        NOW,
      )!;
      const summary = await runPhononSelfTest(params, {sleep});
      const bg = summary.results.find(r => r.name === 'S11_background')!;
      expect(bg.pass).toBe(false);
      expect(bg.detail).toContain('no background/foreground');
    });

    it('a reload persists the run; the next JS context finishes it', async () => {
      // DevSettings.reload "works": capture the marker, then simulate the
      // new context by calling the resume entry point.
      let marker: string | undefined;
      jest.spyOn(DevSettings, 'reload').mockImplementation(() => {
        marker = mockState.files.get(
          '/docs/phonon-evidence/.s11-reload-pending.json',
        );
      });
      const params = parseSelfTestUrl(
        'speechexample://selftest/phonon?scenarios=s3&runs=1&runId=s11ok',
        NOW,
      )!;
      params.scenarios = new Set([...params.scenarios, 's11']);
      (console.log as jest.Mock).mockImplementation((line: string) => {
        if (String(line).includes('S11_BACKGROUND_REQUEST')) {
          setTimeout(() => {
            appStateListeners.forEach(l => l('background'));
            appStateListeners.forEach(l => l('active'));
          }, 0);
        }
      });
      await runPhononSelfTest(params, {sleep});
      expect(marker).toBeDefined();
      const pending = JSON.parse(marker!);
      expect(pending.runId).toBe('s11ok');
      expect(pending.results.map((r: any) => r.name)).toEqual([
        'S1_support',
        'S2_init',
        'S3_short_speak',
        'S11_background',
      ]);

      // New context: marker present again (the real reload never returns).
      mockState.files.set(
        '/docs/phonon-evidence/.s11-reload-pending.json',
        marker!,
      );
      mockState.initCalls = [];
      const summary = (await resumePhononSelfTestAfterReload({sleep}))!;
      expect(summary).not.toBeNull();
      const rl = summary.results.find(r => r.name === 'S11_reload')!;
      expect(rl.pass).toBe(true);
      expect(
        (rl.data!.lastIssuedIdAfterSpeak as number) >
          (rl.data!.lastIssuedIdBefore as number),
      ).toBe(true);
      expect(mockState.initCalls[0]).toMatchObject({
        engine: 'phonon',
        modelPath: '/docs/phonon/models/31m-en',
      });
      const json = selftestJson('s11ok');
      expect(json.results.map((r: any) => r.name)).toEqual([
        'S1_support',
        'S2_init',
        'S3_short_speak',
        'S11_background',
        'S11_reload',
      ]);
      // bench.jsonl continued, not truncated.
      const bench = mockState.files.get(
        '/docs/phonon-evidence/s11ok/bench.jsonl',
      )!;
      expect(bench).toContain('"event":"SELFTEST_START"');
      expect(bench).toContain('"event":"PHONON_S11_RELOAD"');
      expect(
        mockState.files.has('/docs/phonon-evidence/.s11-reload-pending.json'),
      ).toBe(false);
      expect(isPhononSelfTestRunning()).toBe(false);
      // Nothing left to resume.
      expect(await resumePhononSelfTestAfterReload({sleep})).toBeNull();
    });

    it('ignores a stale reload marker', async () => {
      mockState.files.set(
        '/docs/phonon-evidence/.s11-reload-pending.json',
        JSON.stringify({runId: 'old', at: Date.now() - 10 * 60_000}),
      );
      expect(await resumePhononSelfTestAfterReload({sleep})).toBeNull();
      expect(
        mockState.files.has('/docs/phonon-evidence/.s11-reload-pending.json'),
      ).toBe(false);
    });
  });
});
