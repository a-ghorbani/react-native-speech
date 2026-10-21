/**
 * Phonon TurboModule contract: the codegen schema, the flag-off native
 * stubs that implement it, and the packaging bits that ship with it.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

type Annotation = {type: string; name?: string; elementType?: Annotation};
type SchemaMethod = {
  name: string;
  typeAnnotation: {
    returnTypeAnnotation: Annotation;
    params: {name: string; typeAnnotation: Annotation}[];
  };
};

function parseSpec(): {
  methods: SchemaMethod[];
  aliasMap: Record<string, {properties: {name: string; optional: boolean}[]}>;
} {
  // Same parser the Android/iOS codegen runs at build time.
  const {
    TypeScriptParser,
  } = require('@react-native/codegen/lib/parsers/typescript/parser');
  const schema = new TypeScriptParser().parseFile(
    path.join(ROOT, 'src/NativeSpeech.ts'),
  );
  const module = schema.modules.NativeSpeech;
  return {methods: module.spec.methods, aliasMap: module.aliasMap};
}

// name -> [param types, return type]; 'Promise<X>' for async methods.
const EXPECTED: Record<string, [string[], string]> = {
  phononGetSupport: [[], 'Promise<PhononSupportInfo>'],
  phononNeedsCompile: [['String'], 'Promise<Boolean>'],
  phononCreate: [['String', 'PhononLoadOptions'], 'Promise<PhononLoadResult>'],
  phononAllocRequestId: [[], 'Number'],
  phononSynthesize: [
    ['Number', 'Number', 'String', 'String', 'String'],
    'Promise<PhononSynthResult>',
  ],
  phononCancel: [['Number'], 'Boolean'],
  phononCancelAll: [[], 'Boolean'],
  phononPlayBuffer: [['Number', 'PhononPlayConfig'], 'Promise<Void>'],
  phononCopyBuffer: [['Number'], 'Promise<String>'],
  phononReleaseBuffer: [['Number'], 'Boolean'],
  phononDestroy: [['Number'], 'Promise<Void>'],
  phononGetDiagnostics: [[], 'Promise<PhononDiagnostics>'],
  phononResetSupport: [[], 'Promise<Boolean>'],
};

function show(a: Annotation): string {
  if (a.type === 'PromiseTypeAnnotation' && a.elementType) {
    return `Promise<${show(a.elementType)}>`;
  }
  if (a.type === 'TypeAliasTypeAnnotation') return a.name ?? '?';
  return a.type.replace(/TypeAnnotation$/, '');
}

describe('Phonon TurboModule spec (codegen schema)', () => {
  const {methods, aliasMap} = parseSpec();
  const phonon = methods.filter(m => m.name.startsWith('phonon'));

  it('declares exactly the designed phonon methods', () => {
    expect(phonon.map(m => m.name).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
  });

  it.each(Object.entries(EXPECTED))(
    '%s has the designed signature',
    (name, [params, ret]) => {
      const m = phonon.find(x => x.name === name)!;
      expect(m.typeAnnotation.params.map(p => show(p.typeAnnotation))).toEqual(
        params,
      );
      expect(show(m.typeAnnotation.returnTypeAnnotation)).toBe(ret);
    },
  );

  it('keeps cancel, id allocation and release synchronous', () => {
    for (const name of [
      'phononAllocRequestId',
      'phononCancel',
      'phononCancelAll',
      'phononReleaseBuffer',
    ]) {
      const m = phonon.find(x => x.name === name)!;
      expect(m.typeAnnotation.returnTypeAnnotation.type).not.toBe(
        'PromiseTypeAnnotation',
      );
    }
  });

  it('PhononPlayConfig carries the base player config plus volume', () => {
    const props = aliasMap.PhononPlayConfig!.properties.map(p => p.name);
    expect(props).toEqual(
      expect.arrayContaining([
        'sampleRate',
        'channels',
        'ducking',
        'silentMode',
        'volume',
      ]),
    );
  });

  it('result shapes have the designed fields', () => {
    const fields = (alias: string) =>
      aliasMap[alias]!.properties.map(p => p.name).sort();
    expect(fields('PhononSupportInfo')).toEqual(
      [
        'supported',
        'reason',
        'detail',
        'abi',
        'osVersion',
        'libraryVersion',
        'isSimulator',
        'pageSize',
      ].sort(),
    );
    expect(fields('PhononSynthResult')).toEqual(
      [
        'requestId',
        'bufferId',
        'samples',
        'sampleRate',
        'ttfaMs',
        'totalMs',
        'queuedMs',
        'voiceChanged',
        'cancelled',
        'startedAtMs',
        'finishedAtMs',
      ].sort(),
    );
    expect(fields('PhononLoadOptions')).toEqual(
      ['language', 'numThreads', 'computeUnit', 'spinBudget'].sort(),
    );
    expect(fields('PhononLoadResult')).toEqual(
      [
        'handleId',
        'voices',
        'languages',
        'defaultVoice',
        'sampleRate',
        'loadMs',
        'compiled',
        'numThreads',
        'computeUnit',
      ].sort(),
    );
    expect(fields('PhononDiagnostics')).toEqual(
      [
        'memKb',
        'peakMemKb',
        'threads',
        'libraryLoaded',
        'handleOpen',
        'liveBuffers',
        'orphanBuffers',
        'busy',
        'lastIssuedId',
        'cancelWatermark',
      ].sort(),
    );
  });
});

describe('Phonon native implementations cover the spec', () => {
  const names = Object.keys(EXPECTED);

  it('Android RNSpeechModule overrides every phonon method', () => {
    const kt = read(
      'android/src/main/java/com/pocketpalai/speech/RNSpeechModule.kt',
    );
    for (const name of names) {
      expect(kt).toMatch(new RegExp(`override fun ${name}\\(`));
    }
  });

  it('Android flag-off stub reports not-compiled and sync defaults', () => {
    const kt = read(
      'android/src/phononStub/java/com/pocketpalai/speech/phonon/PhononBridge.kt',
    );
    expect(kt).toContain('"reason" to "not-compiled"');
    expect(kt).toContain('const val NOT_COMPILED = "PHONON_NOT_COMPILED"');
    expect(kt).toMatch(/fun allocRequestId\(\): Long = 0L/);
    expect(kt).toMatch(
      /fun cancelUpTo\(upToRequestId: Long\): Boolean = false/,
    );
    expect(kt).toMatch(/fun cancelAll\(\): Boolean = false/);
    expect(kt).toMatch(/fun releaseBuffer\(bufferId: Long\): Boolean = false/);
    // The stub must never load native code.
    expect(kt).not.toMatch(/loadLibrary|external fun/);
  });

  it('iOS RNSpeech.mm implements every phonon selector when flag is off', () => {
    const mm = read('ios/RNSpeech.mm');
    const start = mm.indexOf('#if !RN_SPEECH_PHONON');
    const end = mm.indexOf('#endif // !RN_SPEECH_PHONON');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const stubs = mm.slice(start, end);
    for (const name of names) {
      expect(stubs).toMatch(new RegExp(`^- \\([^)]+\\)${name}\\b`, 'm'));
    }
    expect(stubs).toContain('@"reason": @"not-compiled"');
    expect(stubs).toContain('@"PHONON_NOT_COMPILED"');
    expect(stubs).toMatch(
      /phononCancel:\(double\)upToRequestId \{\s*return @\(NO\);/,
    );
    expect(stubs).toMatch(/phononAllocRequestId \{\s*return @\(0\);/);
  });
});

describe('Phonon flag plumbing and packaging', () => {
  it('phonon.lock.json pins upstream v0.4.0 and the binaries release', () => {
    const lock = JSON.parse(read('phonon.lock.json'));
    expect(lock.upstream.tag).toBe('v0.4.0');
    expect(lock.upstream.commit).toBe(
      'f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa',
    );
    expect(lock.arm64Features).toBe('+dotprod,+fp16');
    expect(lock.binaries.release).toMatch(/^phonon-bin-v\d+\.\d+\.\d+-r\d+$/);
    expect(lock.binaries.android.abis).toEqual(
      expect.arrayContaining(['arm64-v8a']),
    );
    for (const platform of ['android', 'ios']) {
      expect(lock.binaries[platform].sha256).toMatch(
        /^(PLACEHOLDER|[0-9a-f]{64})$/,
      );
    }
  });

  it('package.json ships the lock and never the xcframework or JVM tests', () => {
    const files: string[] = JSON.parse(read('package.json')).files;
    expect(files).toContain('phonon.lock.json');
    expect(files).toContain('!ios/phonon/PhononCore.xcframework');
    expect(files).toContain('!android/src/phononStubTest');
  });

  it('android/build.gradle gates Phonon on RNSpeech_phononEnabled', () => {
    const gradle = read('android/build.gradle');
    expect(gradle).toContain('getPhononOption("phononEnabled")');
    expect(gradle).toContain('"RN_SPEECH_PHONON"');
    expect(gradle).toContain('"src/phononStub/java"');
    expect(gradle).toMatch(/-DRN_SPEECH_PHONON=/);
    // Force reason exists in both build types; only debug takes the value.
    expect(gradle).toMatch(
      /debug \{[^}]*RN_SPEECH_PHONON_FORCE_REASON", "\\"\$\{phononForceReason\}\\""/,
    );
    expect(gradle).toMatch(
      /release \{[^}]*RN_SPEECH_PHONON_FORCE_REASON", "\\"\\""/,
    );
    expect(gradle).toContain('testImplementation "junit:junit:4.13.2"');
  });

  it('podspec gates Phonon on RN_SPEECH_PHONON and excludes it when off', () => {
    const podspec = read('RNSpeech.podspec');
    expect(podspec).toContain("ENV['RN_SPEECH_PHONON'] == '1'");
    expect(podspec).toContain("ENV['RN_SPEECH_PHONON_XCFRAMEWORK']");
    expect(podspec).toContain('"ios/phonon/**/*", "cpp/phonon/**/*"');
    expect(podspec).toContain("'RN_SPEECH_PHONON=1'");
  });

  it('jest mock reports Phonon as not compiled', async () => {
    const mock = require('../../jest/index.js').default;
    await expect(mock.getEngineSupport('phonon')).resolves.toMatchObject({
      supported: false,
      reason: 'not-compiled',
    });
    await expect(mock.getEngineSupport('kitten')).resolves.toEqual({
      supported: true,
      reason: 'ok',
    });
  });
});
