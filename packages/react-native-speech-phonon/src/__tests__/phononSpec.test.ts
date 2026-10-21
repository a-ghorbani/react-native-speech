/**
 * RNSpeechPhonon TurboModule contract: the codegen schema, the native
 * modules that implement it, and the packaging bits that ship with it.
 */
import * as fs from 'fs';
import * as path from 'path';

// Only the jest-mock parity suite loads the package entry, which needs the core natives.
jest.mock('@dr.pogodin/react-native-fs', () => ({}), {virtual: true});
jest.mock('../../../../src/NativeSpeech', () => ({
  __esModule: true,
  default: {getConstants: () => ({maxInputLength: 4000})},
}));
jest.mock('../../../../src/NativeAudioPlayer', () => ({
  __esModule: true,
  default: {},
}));

const ROOT = path.resolve(__dirname, '../..');
const CORE = path.resolve(ROOT, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

type Annotation = {type: string; name?: string; elementType?: Annotation};
type SchemaMethod = {
  name: string;
  typeAnnotation: {
    returnTypeAnnotation: Annotation;
    params: {name: string; typeAnnotation: Annotation}[];
  };
};

function parseSpec(
  file: string,
  name: string,
): {
  methods: SchemaMethod[];
  aliasMap: Record<string, {properties: {name: string; optional: boolean}[]}>;
} {
  // Same parser the Android/iOS codegen runs at build time.
  const {
    TypeScriptParser,
  } = require('@react-native/codegen/lib/parsers/typescript/parser');
  const module = new TypeScriptParser().parseFile(file).modules[name];
  return {methods: module.spec.methods, aliasMap: module.aliasMap};
}

// name -> [param types, return type]; 'Promise<X>' for async methods.
const EXPECTED: Record<string, [string[], string]> = {
  getSupport: [[], 'Promise<PhononSupportInfo>'],
  needsCompile: [['String'], 'Promise<Boolean>'],
  create: [['String', 'PhononLoadOptions'], 'Promise<PhononLoadResult>'],
  allocRequestId: [[], 'Number'],
  synthesize: [
    ['Number', 'Number', 'String', 'String', 'String'],
    'Promise<PhononSynthResult>',
  ],
  cancel: [['Number'], 'Boolean'],
  cancelAll: [[], 'Boolean'],
  playBuffer: [['Number', 'PhononPlayConfig'], 'Promise<Void>'],
  copyBuffer: [['Number'], 'Promise<String>'],
  releaseBuffer: [['Number'], 'Boolean'],
  destroy: [['Number'], 'Promise<Void>'],
  getDiagnostics: [[], 'Promise<PhononDiagnostics>'],
  resetSupport: [[], 'Promise<Boolean>'],
};

function show(a: Annotation): string {
  if (a.type === 'PromiseTypeAnnotation' && a.elementType) {
    return `Promise<${show(a.elementType)}>`;
  }
  if (a.type === 'TypeAliasTypeAnnotation') return a.name ?? '?';
  return a.type.replace(/TypeAnnotation$/, '');
}

describe('RNSpeechPhonon TurboModule spec (codegen schema)', () => {
  const {methods: phonon, aliasMap} = parseSpec(
    path.join(ROOT, 'src/NativeSpeechPhonon.ts'),
    'NativeSpeechPhonon',
  );

  it('declares exactly the designed methods', () => {
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
      'allocRequestId',
      'cancel',
      'cancelAll',
      'releaseBuffer',
    ]) {
      const m = phonon.find(x => x.name === name)!;
      expect(m.typeAnnotation.returnTypeAnnotation.type).not.toBe(
        'PromiseTypeAnnotation',
      );
    }
  });

  it('PhononPlayConfig carries the core player config plus volume, mono only', () => {
    const props = aliasMap.PhononPlayConfig!.properties.map(p => p.name);
    expect(props.sort()).toEqual(
      ['ducking', 'sampleRate', 'silentMode', 'volume'].sort(),
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

describe('core has no Phonon', () => {
  it('the core TurboModule spec declares no Phonon method or type', () => {
    const {methods, aliasMap} = parseSpec(
      path.join(CORE, 'src/NativeSpeech.ts'),
      'NativeSpeech',
    );
    expect(methods.filter(m => /phonon/i.test(m.name))).toEqual([]);
    expect(Object.keys(aliasMap).filter(a => /phonon/i.test(a))).toEqual([]);
  });
});

describe('native modules implement the spec', () => {
  const names = Object.keys(EXPECTED);

  it('Android RNSpeechPhononModule overrides every method', () => {
    const kt = read(
      'android/src/main/java/com/pocketpalai/speech/phonon/RNSpeechPhononModule.kt',
    );
    expect(kt).toContain('NativeSpeechPhononSpec(reactContext)');
    expect(kt).toContain('const val NAME = "RNSpeechPhonon"');
    for (const name of names) {
      expect(kt).toMatch(new RegExp(`override fun ${name}\\(`));
    }
    // Playback goes through the core's PCM sink, not a player of its own.
    expect(kt).toContain('NeuralPcmSink.from(reactApplicationContext)');
  });

  it('iOS RNSpeechPhononModule implements every selector', () => {
    const mm = read('ios/RNSpeechPhononModule.mm');
    expect(mm).toContain('RCT_EXPORT_MODULE(RNSpeechPhonon)');
    expect(mm).toContain('NativeSpeechPhononSpecJSI');
    for (const name of names) {
      expect(mm).toMatch(new RegExp(`^- \\([^)]+\\)${name}\\b`, 'm'));
    }
    expect(mm).toContain('[RNSpeechAudioOutput shared]');
  });

  it('codegen maps the module to its iOS class', () => {
    const {codegenConfig} = JSON.parse(read('package.json'));
    expect(codegenConfig.name).toBe('RNSpeechPhononSpec');
    expect(codegenConfig.ios.modulesProvider).toEqual({
      RNSpeechPhonon: 'RNSpeechPhononModule',
    });
  });
});

describe('packaging', () => {
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
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        'phonon.lock.json',
        'docs/THIRD_PARTY_NOTICES.md',
        '!ios/PhononCore.xcframework',
        '!android/src/test',
      ]),
    );
    expect(Object.keys(pkg.peerDependencies)).toContain(
      '@pocketpalai/react-native-speech',
    );
  });

  it('android/build.gradle has no opt-in flag and depends on the core project', () => {
    const gradle = read('android/build.gradle');
    expect(gradle).not.toMatch(/phononEnabled|RN_SPEECH_PHONON"/);
    expect(gradle).toContain('apply from: "phonon.gradle"');
    expect(gradle).toContain('":pocketpalai_react-native-speech"');
    expect(gradle).toContain('implementation speechCore');
    // Force reason exists in both build types; only debug takes the value.
    expect(gradle).toMatch(
      /debug \{[^}]*RN_SPEECH_PHONON_FORCE_REASON", "\\"\$\{phononForceReason\}\\""/,
    );
    expect(gradle).toMatch(
      /release \{[^}]*RN_SPEECH_PHONON_FORCE_REASON", "\\"\\""/,
    );
  });

  it('a PLACEHOLDER lock fails the Android build at fetch time', () => {
    const fetch = read('android/phonon.gradle');
    expect(fetch).toMatch(
      /local\.isEmpty\(\) && sha256\.get\(\) == "PLACEHOLDER"\) \{\s*throw new GradleException/,
    );
  });

  it('the podspec depends on RNSpeech and fails on a PLACEHOLDER lock', () => {
    const podspec = read('RNSpeechPhonon.podspec');
    expect(podspec).toContain('s.dependency "RNSpeech"');
    expect(podspec).toMatch(
      /unless informative\.call \{ RNSpeechPhonon\.lock_ready\?\(__dir__\) \}\s+raise Pod::Informative/,
    );
    expect(podspec).not.toContain("ENV['RN_SPEECH_PHONON']");
  });

  it('playBuffer stays on the TurboModule shared queue and off the main queue', () => {
    // Ordering with RNSpeech's stopAudio relies on neither module declaring a methodQueue.
    const ownQueue =
      /\(dispatch_queue_t\)\s*methodQueue|@synthesize\s+methodQueue/;
    const mm = read('ios/RNSpeechPhononModule.mm');
    expect(mm).not.toMatch(ownQueue);
    expect(
      fs.readFileSync(path.join(CORE, 'ios/RNSpeech.mm'), 'utf8'),
    ).not.toMatch(ownQueue);
    expect(mm).toMatch(
      /\+ \(BOOL\)requiresMainQueueSetup\s*\{\s*return NO;\s*\}/,
    );
  });

  it('requires React Native 0.74+, where TurboModules share one method queue', () => {
    const semver = require('semver');
    const range = JSON.parse(read('package.json')).peerDependencies[
      'react-native'
    ];
    expect(semver.gte(semver.minVersion(range), '0.74.0')).toBe(true);
  });

  it('playBuffer checks the core output before taking the buffer', () => {
    const mm = read('ios/RNSpeechPhononModule.mm');
    const body = mm.slice(mm.indexOf('- (void)playBuffer:'));
    expect(body.indexOf('[RNSpeechAudioOutput shared]')).toBeGreaterThan(0);
    expect(body.indexOf('[RNSpeechAudioOutput shared]')).toBeLessThan(
      body.indexOf('takeBuffer:'),
    );
  });
});

describe('jest mock', () => {
  const mock = require('../../jest/index.js');
  const real = require('../index');

  /** Public instance and static members declared on the real PhononEngine. */
  function publicMembers(): {instance: string[]; statics: string[]} {
    const ts = require('typescript');
    const file = path.join(ROOT, 'src/PhononEngine.ts');
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
    );
    const instance: string[] = [];
    const statics: string[] = [];
    ts.forEachChild(sf, (node: any) => {
      if (!ts.isClassDeclaration(node) || node.name?.text !== 'PhononEngine') {
        return;
      }
      for (const m of node.members) {
        if (!m.name || ts.isConstructorDeclaration(m)) {
          continue;
        }
        const kinds = (ts.getModifiers?.(m) ?? []).map((x: any) => x.kind);
        if (
          kinds.includes(ts.SyntaxKind.PrivateKeyword) ||
          kinds.includes(ts.SyntaxKind.ProtectedKeyword) ||
          ts.isPrivateIdentifier(m.name)
        ) {
          continue;
        }
        const list = kinds.includes(ts.SyntaxKind.StaticKeyword)
          ? statics
          : instance;
        list.push(m.name.text);
      }
    });
    return {instance, statics};
  }

  it('reports Phonon as not compiled', async () => {
    expect(mock.PHONON).toBe('phonon');
    await expect(new mock.PhononEngine().getSupport()).resolves.toMatchObject({
      supported: false,
      reason: 'not-compiled',
    });
    const {NOT_COMPILED_SUPPORT} = require('../NativePhonon');
    const support = await mock.PhononEngine.getSupport();
    expect(Object.keys(support).sort()).toEqual(
      Object.keys(NOT_COMPILED_SUPPORT).sort(),
    );
    await expect(mock.PhononEngine.getDiagnostics()).resolves.toEqual(
      require('../NativePhonon').NOT_COMPILED_DIAGNOSTICS,
    );
  });

  it('exports everything the package exports', () => {
    const missing = Object.keys(real).filter(k => !(k in mock));
    expect(missing).toEqual([]);
    expect(mock.PHONON_CONSTANTS).toEqual(real.PHONON_CONSTANTS);
    expect(mock.PHONON_LANGUAGES).toEqual(real.PHONON_LANGUAGES);
  });

  it('mocks every public PhononEngine member', () => {
    const {instance, statics} = publicMembers();
    expect(instance).toEqual(
      expect.arrayContaining(['synthesizeStream', 'getLoadInfo', 'stop']),
    );
    const engine = new mock.PhononEngine();
    expect(instance.filter(k => !(k in engine))).toEqual([]);
    expect(statics.filter(k => !(k in mock.PhononEngine))).toEqual([]);
    const handle = engine.synthesizeStream();
    expect(Object.keys(handle).sort()).toEqual([
      'append',
      'cancel',
      'finalize',
    ]);
  });

  it('errors match the real ones', () => {
    for (const args of [['not-compiled'], ['os-too-old', 'iOS 17.0']]) {
      const m = new mock.PhononUnsupportedError(...args);
      const r = new real.PhononUnsupportedError(...args);
      expect([m.message, m.code, m.reason, m.detail, m.name]).toEqual([
        r.message,
        r.code,
        r.reason,
        r.detail,
        r.name,
      ]);
    }
    for (const e of [
      Object.assign(new Error('x'), {code: 'PHONON_VOICE_NOT_FOUND'}),
      {code: 'PHONON_NOPE'},
      'plain',
    ]) {
      const m = mock.toPhononError(e);
      const r = real.toPhononError(e);
      expect([m.code, m.message, m.nativeCode]).toEqual([
        r.code,
        r.message,
        r.nativeCode,
      ]);
      expect(m).toBeInstanceOf(mock.PhononError);
    }
  });

  it('helpers match the real ones', () => {
    const jsonl = [
      '{"name":"Alba","voice_id":"v1","language":"en","gender":"f"}',
      'not json',
      '',
      '{"name":"Émile","description":"warm"}',
      '{"filename":"x"}',
    ].join('\n');
    expect(mock.parseVoicesJsonl(jsonl)).toEqual(real.parseVoicesJsonl(jsonl));
    const catalog = real.parseVoicesJsonl(jsonl);
    const ids = ['alba', 'emile', 'v1', 'other'];
    expect(mock.buildVoices(ids, catalog, 'fr')).toEqual(
      real.buildVoices(ids, catalog, 'fr'),
    );
    for (const l of ['en-US', 'PT_br', ' de ', '']) {
      expect(mock.normalizePhononLanguage(l)).toBe(
        real.normalizePhononLanguage(l),
      );
    }
  });
});
