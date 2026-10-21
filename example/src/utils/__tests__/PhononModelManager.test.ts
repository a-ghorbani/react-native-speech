/**
 * PhononModelManager against an in-memory RNFS: per-platform file lists,
 * per-file verification with cleanup, atomic install, free-space check.
 */

type Entry = {size: number; sha: string; content?: string};
type Remote = {status?: number; size: number; sha: string; content?: string};

const mockFs = {
  files: new Map<string, Entry>(),
  dirs: new Set<string>(),
  remote: new Map<string, Remote>(),
  freeSpace: (10 * 1024 * 1024 * 1024) as number,
  fsInfoFails: false,
  downloads: [] as string[],
  mkdirOptions: [] as Array<{path: string; options: unknown}>,
};

function mockParents(path: string): string[] {
  const out: string[] = [];
  let p = path;
  while (p.lastIndexOf('/') > 0) {
    p = p.slice(0, p.lastIndexOf('/'));
    out.push(p);
  }
  return out;
}

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  LibraryDirectoryPath: '/lib',
  exists: jest.fn(
    async (p: string) => mockFs.files.has(p) || mockFs.dirs.has(p),
  ),
  mkdir: jest.fn(async (p: string, options?: unknown) => {
    mockFs.mkdirOptions.push({path: p, options});
    mockFs.dirs.add(p);
    mockParents(p).forEach(d => mockFs.dirs.add(d));
  }),
  unlink: jest.fn(async (p: string) => {
    for (const k of [...mockFs.files.keys()]) {
      if (k === p || k.startsWith(`${p}/`)) mockFs.files.delete(k);
    }
    for (const k of [...mockFs.dirs]) {
      if (k === p || k.startsWith(`${p}/`)) mockFs.dirs.delete(k);
    }
  }),
  stat: jest.fn(async (p: string) => {
    const f = mockFs.files.get(p);
    if (!f) throw new Error(`ENOENT ${p}`);
    return {size: f.size};
  }),
  hash: jest.fn(async (p: string, algo: string) => {
    expect(algo).toBe('sha256');
    const f = mockFs.files.get(p);
    if (!f) throw new Error(`ENOENT ${p}`);
    return f.sha;
  }),
  writeFile: jest.fn(async (p: string, content: string) => {
    mockFs.files.set(p, {size: content.length, sha: '', content});
  }),
  copyFile: jest.fn(async (from: string, to: string) => {
    const f = mockFs.files.get(from);
    if (!f) throw new Error(`ENOENT ${from}`);
    mockFs.files.set(to, {...f});
  }),
  readFile: jest.fn(async (p: string) => {
    const f = mockFs.files.get(p);
    if (!f) throw new Error(`ENOENT ${p}`);
    return f.content ?? '';
  }),
  moveFile: jest.fn(async (from: string, to: string) => {
    if (mockFs.dirs.has(to) || mockFs.files.has(to)) {
      throw new Error(`EEXIST ${to}`);
    }
    for (const [k, v] of [...mockFs.files]) {
      if (k === from || k.startsWith(`${from}/`)) {
        mockFs.files.delete(k);
        mockFs.files.set(to + k.slice(from.length), v);
      }
    }
    for (const k of [...mockFs.dirs]) {
      if (k === from || k.startsWith(`${from}/`)) {
        mockFs.dirs.delete(k);
        mockFs.dirs.add(to + k.slice(from.length));
      }
    }
  }),
  readDir: jest.fn(async (dir: string) => {
    const names = new Map<string, {isDir: boolean; size: number}>();
    for (const [k, v] of mockFs.files) {
      if (k.startsWith(`${dir}/`)) {
        const rest = k.slice(dir.length + 1);
        const name = rest.split('/')[0]!;
        names.set(name, {
          isDir: rest.includes('/'),
          size: rest.includes('/') ? 0 : v.size,
        });
      }
    }
    for (const k of mockFs.dirs) {
      if (k.startsWith(`${dir}/`)) {
        const name = k.slice(dir.length + 1).split('/')[0]!;
        if (!names.has(name)) names.set(name, {isDir: true, size: 0});
      }
    }
    return [...names].map(([name, e]) => ({
      name,
      path: `${dir}/${name}`,
      size: e.size,
      isFile: () => !e.isDir,
      isDirectory: () => e.isDir,
    }));
  }),
  getFSInfo: jest.fn(async () => {
    if (mockFs.fsInfoFails) throw new Error('no fs info');
    return {freeSpace: mockFs.freeSpace, totalSpace: 0};
  }),
  downloadFile: jest.fn(
    (opts: {
      fromUrl: string;
      toFile: string;
      progress?: (r: {bytesWritten: number}) => void;
    }) => {
      mockFs.downloads.push(opts.fromUrl);
      const r = mockFs.remote.get(opts.fromUrl);
      const promise = (async () => {
        if (!r) return {statusCode: 404, bytesWritten: 0};
        if ((r.status ?? 200) !== 200) {
          return {statusCode: r.status, bytesWritten: 0};
        }
        opts.progress?.({bytesWritten: r.size});
        mockFs.files.set(opts.toFile, {
          size: r.size,
          sha: r.sha,
          content: r.content,
        });
        return {statusCode: 200, bytesWritten: r.size};
      })();
      return {jobId: mockFs.downloads.length, promise};
    },
  ),
}));

jest.mock('@pocketpalai/react-native-speech', () => ({}));

import {
  PhononModelManager,
  PhononModelError,
  PHONON_CURATED_VOICES,
  androidModelFiles,
  curatedVoicesJsonl,
  parseManifest,
  requiredFreeBytes,
  isPinnedMirror,
  DEFAULT_PHONON_IOS_MIRROR,
} from '../PhononModelManager';
import * as RNFS from '@dr.pogodin/react-native-fs';

const ANDROID_ROOT = '/docs/phonon/models';
const ANDROID_DIR = `${ANDROID_ROOT}/31m-en`;
const IOS_ROOT = '/lib/Application Support/phonon';
const IOS_DIR = `${IOS_ROOT}/phonon-31m-en-coreml`;

const sha = (c: string) => c.repeat(64);

function serveAndroid(): void {
  for (const f of androidModelFiles()) {
    mockFs.remote.set(f.url, {size: f.size, sha: f.sha256});
  }
}

const IOS_FILES = [
  {path: 'bundle.json', size: 900, sha: sha('a')},
  {path: 'flow_t1.mlmodelc/model.mil', size: 1000, sha: sha('b')},
  {path: 'flow_t1.mlmodelc/weights/weight.bin', size: 5000, sha: sha('c')},
  {path: 'voices/default.safetensors', size: 300, sha: sha('d')},
];

function manifestText(files = IOS_FILES): string {
  return files.map(f => `${f.path}\t${f.size}\t${f.sha}`).join('\n') + '\n';
}

function mirrorUrl(path: string, repo = DEFAULT_PHONON_IOS_MIRROR.repo) {
  return `https://huggingface.co/${repo}/resolve/main/${path}`;
}

function serveIos(files = IOS_FILES, repo?: string): void {
  const text = manifestText(files);
  mockFs.remote.set(mirrorUrl('phonon-31m-en-coreml.manifest.tsv', repo), {
    size: text.length,
    sha: '',
    content: text,
  });
  for (const f of files) {
    mockFs.remote.set(mirrorUrl(`phonon-31m-en-coreml/${f.path}`, repo), {
      size: f.size,
      sha: f.sha,
    });
  }
}

function filesUnder(dir: string): string[] {
  return [...mockFs.files.keys()]
    .filter(k => k.startsWith(`${dir}/`))
    .map(k => k.slice(dir.length + 1))
    .sort();
}

function hasStaging(root: string): boolean {
  return [...mockFs.files.keys(), ...mockFs.dirs].some(k =>
    k.startsWith(`${root}/.staging-`),
  );
}

beforeEach(() => {
  mockFs.files.clear();
  mockFs.dirs.clear();
  mockFs.remote.clear();
  mockFs.freeSpace = 10 * 1024 * 1024 * 1024;
  mockFs.fsInfoFails = false;
  mockFs.downloads = [];
  mockFs.mkdirOptions = [];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Android file list', () => {
  it('lists the 4 pinned checkpoint files and 8 voices saved by display name', () => {
    const files = androidModelFiles();
    expect(files.map(f => f.path)).toEqual([
      'config.json',
      'tokenizer.json',
      'model.q8.gguf',
      'default-voice.safetensors',
      ...PHONON_CURATED_VOICES.map(v => `voices/${v.name}.safetensors`),
    ]);
    expect(PHONON_CURATED_VOICES).toHaveLength(8);
    for (const f of files.slice(0, 4)) {
      expect(f.url).toBe(
        `https://huggingface.co/gradium/phonon-31m-en/resolve/52433c46975bfa13144c56204c9f4ee1c5b148aa/${f.path}`,
      );
    }
    const zoey = files.find(f => f.path === 'voices/Zoey.safetensors')!;
    expect(zoey.url).toBe(
      'https://huggingface.co/gradium/phonon-voices/resolve/da6c9ec0d47be8df5c87c730a3aa97187f3229c3/voices/NbpkqMVS3CJeq2j8.safetensors',
    );
    for (const f of files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.size).toBeGreaterThan(0);
    }
  });

  it('writes a voices.jsonl whose filenames match the saved voices', () => {
    const lines = curatedVoicesJsonl()
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatchObject({
      name: 'Zoey',
      filename: 'voices/Zoey.safetensors',
      language: 'en',
    });
  });
});

describe('Android install from a local folder', () => {
  const SRC = '/ext/push/31m-en';
  function pushAll(skip?: string) {
    for (const f of androidModelFiles()) {
      if (f.path !== skip) {
        mockFs.files.set(`${SRC}/${f.path}`, {size: f.size, sha: f.sha256});
      }
    }
  }

  it('copies, verifies and installs like a download, without the network', async () => {
    pushAll();
    const mgr = new PhononModelManager({platform: 'android'});
    await mgr.installFromDirectory(`file://${SRC}/`);
    expect(mockFs.downloads).toEqual([]);
    expect(filesUnder(ANDROID_DIR)).toEqual(
      [
        '.phonon-installed.json',
        'config.json',
        'default-voice.safetensors',
        'model.q8.gguf',
        'tokenizer.json',
        'voices.jsonl',
        ...PHONON_CURATED_VOICES.map(v => `voices/${v.name}.safetensors`),
      ].sort(),
    );
    expect(hasStaging(ANDROID_ROOT)).toBe(false);
    expect(await mgr.isModelInstalled('31m-en')).toBe(true);
    const marker = JSON.parse(
      mockFs.files.get(`${ANDROID_DIR}/.phonon-installed.json`)!.content!,
    );
    expect(marker.copiedFrom).toBe(SRC);
    expect(mockFs.files.has(`${SRC}/model.q8.gguf`)).toBe(true);
  });

  it.each([
    ['missing-file', () => pushAll('tokenizer.json')],
    [
      'checksum',
      () => {
        pushAll();
        mockFs.files.set(`${SRC}/model.q8.gguf`, {
          size: androidModelFiles().find(f => f.path === 'model.q8.gguf')!.size,
          sha: sha('0'),
        });
      },
    ],
  ])('a %s source installs nothing', async (code, setup) => {
    setup();
    const mgr = new PhononModelManager({platform: 'android'});
    await expect(mgr.installFromDirectory(SRC)).rejects.toMatchObject({code});
    expect(hasStaging(ANDROID_ROOT)).toBe(false);
    expect(filesUnder(ANDROID_DIR)).toEqual([]);
  });

  it('is Android-only', async () => {
    const mgr = new PhononModelManager({platform: 'ios'});
    await expect(mgr.installFromDirectory(SRC)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('Android download', () => {
  it('downloads, verifies and installs atomically', async () => {
    serveAndroid();
    const mgr = new PhononModelManager({platform: 'android'});
    const progress: number[] = [];
    await mgr.downloadModel('31m-en', p => progress.push(p.progress));

    expect(filesUnder(ANDROID_DIR)).toEqual(
      [
        '.phonon-installed.json',
        'config.json',
        'default-voice.safetensors',
        'model.q8.gguf',
        'tokenizer.json',
        'voices.jsonl',
        ...PHONON_CURATED_VOICES.map(v => `voices/${v.name}.safetensors`),
      ].sort(),
    );
    expect(hasStaging(ANDROID_ROOT)).toBe(false);
    expect(progress[progress.length - 1]).toBe(1);
    expect(Math.max(...progress.slice(0, -1))).toBeLessThan(1);

    expect(await mgr.isModelInstalled('31m-en')).toBe(true);
    const info = mgr.getInstalledModel()!;
    expect(info.path).toBe(ANDROID_DIR);
    expect(info.voices).toEqual(
      [...PHONON_CURATED_VOICES.map(v => v.name), 'default'].sort(),
    );
    expect(mgr.getDownloadedModelConfig()).toEqual({
      modelPath: ANDROID_DIR,
      language: 'en',
      voicesMetadataPath: `${ANDROID_DIR}/voices.jsonl`,
    });
  });

  it.each([
    ['checksum', {sha: sha('0')}],
    ['size-mismatch', {size: 12}],
    ['http', {status: 503}],
  ])(
    'a %s failure on one file removes the staging dir and installs nothing',
    async (code, override) => {
      serveAndroid();
      const target = androidModelFiles().find(f => f.path === 'model.q8.gguf')!;
      mockFs.remote.set(target.url, {
        size: target.size,
        sha: target.sha256,
        ...override,
      });
      const mgr = new PhononModelManager({platform: 'android'});
      await expect(mgr.downloadModel('31m-en')).rejects.toMatchObject({code});
      expect(hasStaging(ANDROID_ROOT)).toBe(false);
      expect(filesUnder(ANDROID_DIR)).toEqual([]);
      expect(await mgr.isModelInstalled('31m-en')).toBe(false);
    },
  );

  it('keeps a previous install when a re-download fails', async () => {
    serveAndroid();
    const mgr = new PhononModelManager({platform: 'android'});
    await mgr.downloadModel('31m-en');
    const before = filesUnder(ANDROID_DIR);

    const voice = androidModelFiles().find(f => f.path.startsWith('voices/'))!;
    mockFs.remote.set(voice.url, {size: voice.size, sha: sha('f')});
    await expect(mgr.downloadModel('31m-en')).rejects.toBeInstanceOf(
      PhononModelError,
    );
    expect(filesUnder(ANDROID_DIR)).toEqual(before);
    expect(hasStaging(ANDROID_ROOT)).toBe(false);
  });

  it('restores the previous install when the final move fails', async () => {
    serveAndroid();
    const mgr = new PhononModelManager({platform: 'android'});
    await mgr.downloadModel('31m-en');
    const before = filesUnder(ANDROID_DIR);

    const move = RNFS.moveFile as jest.Mock;
    const real = move.getMockImplementation()!;
    move.mockImplementation(async (from: string, to: string) => {
      if (from.includes('.staging-')) {
        // A partial copy, then failure (Android renameTo fallback).
        mockFs.files.set(`${to}/config.json`, {size: 1, sha: ''});
        throw new Error('rename failed');
      }
      return real(from, to);
    });
    try {
      await expect(mgr.downloadModel('31m-en')).rejects.toThrow(
        'rename failed',
      );
    } finally {
      move.mockImplementation(real);
    }
    expect(filesUnder(ANDROID_DIR)).toEqual(before);
    expect(hasStaging(ANDROID_ROOT)).toBe(false);
    expect(filesUnder(`${ANDROID_ROOT}/.old-31m-en`)).toEqual([]);
    expect(await mgr.isModelInstalled('31m-en')).toBe(true);
  });

  it('replaces a previous install and removes the old copy', async () => {
    serveAndroid();
    const mgr = new PhononModelManager({platform: 'android'});
    await mgr.downloadModel('31m-en');
    await mgr.downloadModel('31m-en');
    expect(await mgr.isModelInstalled('31m-en')).toBe(true);
    expect(
      [...mockFs.files.keys(), ...mockFs.dirs].some(k => k.includes('.old-')),
    ).toBe(false);
  });

  it('joins a download of the same variant that is already running', async () => {
    serveAndroid();
    const mgr = new PhononModelManager({platform: 'android'});
    const first = mgr.downloadModel('31m-en');
    expect(mgr.isDownloading('31m-en')).toBe(true);
    const second = mgr.downloadModel('31m-en');
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mgr.isDownloading('31m-en')).toBe(false);
    // Each file was fetched once.
    expect(mockFs.downloads).toHaveLength(androidModelFiles().length);
    expect(await mgr.isModelInstalled('31m-en')).toBe(true);
  });

  it('allows a new download after a failed one', async () => {
    serveAndroid();
    mockFs.freeSpace = 0;
    const mgr = new PhononModelManager({platform: 'android'});
    await expect(mgr.downloadModel('31m-en')).rejects.toMatchObject({
      code: 'insufficient-space',
    });
    expect(mgr.isDownloading('31m-en')).toBe(false);
    mockFs.freeSpace = 10 * 1024 * 1024 * 1024;
    await mgr.downloadModel('31m-en');
    expect(await mgr.isModelInstalled('31m-en')).toBe(true);
  });

  it('fails before downloading when the disk is too small', async () => {
    serveAndroid();
    const total = androidModelFiles().reduce((a, f) => a + f.size, 0);
    mockFs.freeSpace = requiredFreeBytes('android', total) - 1;
    const mgr = new PhononModelManager({platform: 'android'});
    await expect(mgr.downloadModel('31m-en')).rejects.toMatchObject({
      code: 'insufficient-space',
    });
    expect(mockFs.downloads).toEqual([]);
  });

  it('proceeds when free space cannot be read (fails soft)', async () => {
    serveAndroid();
    mockFs.fsInfoFails = true;
    const mgr = new PhononModelManager({platform: 'android'});
    await mgr.downloadModel('31m-en');
    expect(await mgr.isModelInstalled('31m-en')).toBe(true);
  });

  it('does not count a folder without the install marker as installed', async () => {
    mockFs.files.set(`${ANDROID_DIR}/config.json`, {size: 1, sha: ''});
    const mgr = new PhononModelManager({platform: 'android'});
    await mgr.scanInstalledModel();
    expect(mgr.getInstalledModel()).toBeNull();
  });

  it('deletes an installed model', async () => {
    serveAndroid();
    const mgr = new PhononModelManager({platform: 'android'});
    await mgr.downloadModel('31m-en');
    await mgr.deleteModel('31m-en');
    expect(filesUnder(ANDROID_DIR)).toEqual([]);
    expect(mgr.getAllInstalledModels()).toEqual([]);
  });
});

describe('40m (user-provided, CC BY-NC)', () => {
  it('is listed only behind the non-commercial toggle and only on Android', () => {
    const android = new PhononModelManager({platform: 'android'});
    expect(android.getAvailableVariants().map(v => v.variant)).toEqual([
      '31m-en',
    ]);
    const all = android.getAvailableVariants(true);
    expect(all.map(v => v.variant)).toEqual(['31m-en', '40m-en']);
    expect(all[1]).toMatchObject({
      userProvided: true,
      nonCommercial: true,
      license: 'CC-BY-NC-4.0',
    });
    const ios = new PhononModelManager({platform: 'ios'});
    expect(ios.getAvailableVariants(true).map(v => v.variant)).toEqual([
      '31m-en',
    ]);
  });

  it('is never downloaded', async () => {
    const mgr = new PhononModelManager({platform: 'android'});
    await expect(mgr.downloadModel('40m-en')).rejects.toMatchObject({
      code: 'user-provided',
    });
    expect(mockFs.downloads).toEqual([]);
  });

  it('is detected when the user copied a checkpoint in', async () => {
    const dir = `${ANDROID_ROOT}/40m-en`;
    for (const f of ['config.json', 'tokenizer.json', 'model.safetensors']) {
      mockFs.files.set(`${dir}/${f}`, {size: 10, sha: ''});
    }
    const mgr = new PhononModelManager({platform: 'android'});
    await mgr.scanInstalledModel();
    expect(mgr.getActiveVariant()).toBe('40m-en');
    expect(mgr.getDownloadedModelConfig()).toEqual({
      modelPath: dir,
      language: 'en',
    });
  });
});

describe('iOS download (precompiled Core ML mirror)', () => {
  it('downloads every manifest file into the inner bundle folder', async () => {
    serveIos();
    const mgr = new PhononModelManager({platform: 'ios'});
    await mgr.downloadModel('31m-en');

    expect(mockFs.downloads[0]).toBe(
      mirrorUrl('phonon-31m-en-coreml.manifest.tsv'),
    );
    expect(filesUnder(IOS_DIR)).toEqual(
      ['.phonon-installed.json', ...IOS_FILES.map(f => f.path)].sort(),
    );
    expect(hasStaging(IOS_ROOT)).toBe(false);
    // Backup exclusion on the root and on the installed folder.
    const excluded = mockFs.mkdirOptions
      .filter(m => (m.options as any)?.NSURLIsExcludedFromBackupKey === true)
      .map(m => m.path);
    expect(excluded).toEqual(expect.arrayContaining([IOS_ROOT, IOS_DIR]));
    // modelPath is the inner folder holding bundle.json; no voices.jsonl.
    expect(mgr.getDownloadedModelConfig()).toEqual({
      modelPath: IOS_DIR,
      language: 'en',
    });
    expect(await mgr.isModelInstalled()).toBe(true);
  });

  it('removes the staging dir on a per-file sha mismatch', async () => {
    serveIos();
    mockFs.remote.set(
      mirrorUrl('phonon-31m-en-coreml/flow_t1.mlmodelc/weights/weight.bin'),
      {size: 5000, sha: sha('9')},
    );
    const mgr = new PhononModelManager({platform: 'ios'});
    await expect(mgr.downloadModel()).rejects.toMatchObject({code: 'checksum'});
    expect(hasStaging(IOS_ROOT)).toBe(false);
    expect(filesUnder(IOS_DIR)).toEqual([]);
  });

  it('requires 2x the bundle plus 100 MB free', async () => {
    serveIos();
    const total = IOS_FILES.reduce((a, f) => a + f.size, 0);
    expect(requiredFreeBytes('ios', total)).toBe(2 * total + 100 * 1024 * 1024);
    mockFs.freeSpace = requiredFreeBytes('ios', total) - 1;
    const mgr = new PhononModelManager({platform: 'ios'});
    await expect(mgr.downloadModel()).rejects.toMatchObject({
      code: 'insufficient-space',
    });
    // Only the manifest was fetched.
    expect(mockFs.downloads).toHaveLength(1);
  });

  it('uses a configured mirror', async () => {
    serveIos(IOS_FILES, 'someone/other-mirror');
    const mgr = new PhononModelManager({platform: 'ios'});
    mgr.setIosMirror({repo: 'someone/other-mirror'});
    await mgr.downloadModel();
    expect(
      mockFs.downloads.every(u => u.includes('someone/other-mirror')),
    ).toBe(true);
  });

  it('rejects a manifest whose own sha256 does not match the pin', async () => {
    serveIos();
    const mgr = new PhononModelManager({
      platform: 'ios',
      iosMirror: {manifestSha256: sha('e')},
    });
    // The served manifest has an empty sha; the pin makes it fail.
    await expect(mgr.downloadModel()).rejects.toMatchObject({code: 'checksum'});
    expect(mockFs.downloads).toHaveLength(1);
  });

  it('reports a missing mirror as an HTTP error', async () => {
    const mgr = new PhononModelManager({platform: 'ios'});
    await expect(mgr.downloadModel()).rejects.toMatchObject({code: 'http'});
  });
});

describe('iOS mirror pinning', () => {
  it('requires a commit sha and the manifest sha256', () => {
    expect(isPinnedMirror(DEFAULT_PHONON_IOS_MIRROR)).toBe(false);
    expect(
      isPinnedMirror({
        ...DEFAULT_PHONON_IOS_MIRROR,
        revision: 'a'.repeat(40),
        manifestSha256: null,
      }),
    ).toBe(false);
    expect(
      isPinnedMirror({
        ...DEFAULT_PHONON_IOS_MIRROR,
        revision: 'a'.repeat(40),
        manifestSha256: sha('b'),
      }),
    ).toBe(true);
  });

  it('warns when downloading from an unpinned mirror', async () => {
    serveIos();
    const mgr = new PhononModelManager({platform: 'ios'});
    await mgr.downloadModel('31m-en');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('is not pinned'),
    );
  });
});

describe('parseManifest', () => {
  it('parses path/size/sha lines', () => {
    expect(parseManifest(manifestText())).toEqual(
      IOS_FILES.map(f => ({path: f.path, size: f.size, sha256: f.sha})),
    );
  });

  it.each([
    ['path traversal', `../x\t1\t${sha('a')}\nbundle.json\t1\t${sha('a')}`],
    ['absolute path', `/x\t1\t${sha('a')}\nbundle.json\t1\t${sha('a')}`],
    ['bad sha', 'bundle.json\t1\tnothex'],
    ['bad size', `bundle.json\t-1\t${sha('a')}`],
    ['missing bundle.json', `a.bin\t1\t${sha('a')}`],
    ['duplicate', `bundle.json\t1\t${sha('a')}\nbundle.json\t1\t${sha('a')}`],
  ])('rejects %s', (_name, text) => {
    expect(() => parseManifest(text)).toThrow(PhononModelError);
  });
});
