/**
 * The example's Phonon model store; the library itself never downloads.
 *
 * Files and pins: phononPins.json. Android installs the checkpoint plus curated
 * voices as voices/<Name>.safetensors (upstream names voices by file stem). iOS
 * installs the CI-precompiled Core ML bundle file by file from its manifest
 * (format: scripts/precompile-coreml.sh). Installs are atomic: verified in a
 * staging dir, then renamed into place.
 *
 * 40m checkpoints are CC BY-NC and gated, so they are never downloaded: the user
 * copies one into <models>/40m-en/ and it appears behind the non-commercial
 * toggle (Android only).
 */

import {Platform} from 'react-native';

import * as RNFS from '@dr.pogodin/react-native-fs';
import type {PhononConfig} from '@pocketpalai/react-native-speech-phonon';

// HF repos, revisions and per-file sha256; also read by the add-on's CI model scripts.
import PINS from './phononPins.json';

export type PhononVariant = '31m-en' | '40m-en';

export interface PhononModelInfo {
  variant: PhononVariant;
  /** Model folder passed to the engine as `modelPath` */
  path: string;
  size: number;
  voices: string[];
  license: string;
  description: string;
}

export interface PhononDownloadProgress {
  totalBytes: number;
  downloadedBytes: number;
  progress: number;
  currentFile?: string;
}

/** One file of a model, as it will be laid out in the model folder. */
export interface PhononModelFile {
  /** Path relative to the model folder ('/'-separated) */
  path: string;
  url: string;
  size: number;
  sha256: string;
}

/** Where the precompiled iOS Core ML bundle is mirrored. */
export interface PhononIosMirror {
  baseUrl: string;
  /** HF repo (org/name) */
  repo: string;
  /** Git revision; only a commit sha pins it */
  revision: string;
  /** Bundle folder name; also the inner folder used as `modelPath` */
  bundleName: string;
  /** Manifest path in the repo (path<TAB>size<TAB>sha256 lines) */
  manifestPath: string;
  /** sha256 of the manifest itself, or null to trust the pinned revision */
  manifestSha256: string | null;
}

export type PhononModelErrorCode =
  | 'unsupported-variant'
  | 'user-provided'
  | 'insufficient-space'
  | 'http'
  | 'size-mismatch'
  | 'checksum'
  | 'bad-manifest'
  | 'unsupported'
  | 'busy'
  | 'missing-file';

export class PhononModelError extends Error {
  readonly code: PhononModelErrorCode;
  constructor(code: PhononModelErrorCode, message: string) {
    super(message);
    this.name = 'PhononModelError';
    this.code = code;
  }
}

const HF_BASE_URL = 'https://huggingface.co';

interface CuratedVoice {
  name: string;
  voiceId: string;
  locale: string;
  gender: string;
  description: string;
  sha256: string;
}

/** Curated English voices (Apache-2.0), saved under their display name. */
export const PHONON_CURATED_VOICES: readonly CuratedVoice[] =
  PINS.voices.curated;

/**
 * Default iOS mirror, pinned to a commit and the manifest's sha256; override
 * with `setIosMirror`. Layout = precompile-coreml.sh's out dir:
 * `<bundleName>/...` plus `<bundleName>.manifest.tsv` at the repo root.
 */
export const DEFAULT_PHONON_IOS_MIRROR: PhononIosMirror = {
  baseUrl: HF_BASE_URL,
  repo: 'palshub/phonon-31m-en-coreml',
  revision: '0222045816b825e8a004013c7158b111245b4aab',
  bundleName: 'phonon-31m-en-coreml',
  manifestPath: 'phonon-31m-en-coreml.manifest.tsv',
  manifestSha256:
    '4f91af242637d13a93f38a574e4f99466a3063aa5a7d24fc34a797f53b12599a',
};

/** True when `mirror` pins both a commit sha and the manifest's sha256. */
export function isPinnedMirror(mirror: PhononIosMirror): boolean {
  return (
    /^[0-9a-f]{40}$/.test(mirror.revision) &&
    !!mirror.manifestSha256 &&
    /^[0-9a-f]{64}$/.test(mirror.manifestSha256)
  );
}

interface VariantConfig {
  label: string;
  description: string;
  license: string;
  /** Not downloadable: the user copies the checkpoint in (gated, CC BY-NC) */
  userProvided: boolean;
  nonCommercial: boolean;
  platforms: ReadonlyArray<'android' | 'ios'>;
  estimatedSize: Record<'android' | 'ios', number>;
}

const VARIANTS: Record<PhononVariant, VariantConfig> = {
  '31m-en': {
    label: 'Phonon 31M EN',
    description: '31M English, 8 voices',
    license: 'Apache-2.0',
    userProvided: false,
    nonCommercial: false,
    platforms: ['android', 'ios'],
    estimatedSize: {
      android: 66 * 1024 * 1024,
      ios: 170 * 1024 * 1024,
    },
  },
  '40m-en': {
    label: 'Phonon 40M EN',
    description: '40M English, user-downloaded (CC BY-NC)',
    license: 'CC-BY-NC-4.0',
    userProvided: true,
    nonCommercial: true,
    platforms: ['android'],
    estimatedSize: {android: 75 * 1024 * 1024, ios: 0},
  },
};

const DEFAULT_VARIANT: PhononVariant = '31m-en';
const INSTALL_MARKER = '.phonon-installed.json';
const VOICES_JSONL = 'voices.jsonl';
/** Weights the CPU loader accepts (ptts-ffi cpu.rs WEIGHTS) */
const CHECKPOINT_WEIGHTS = ['model.q8.gguf', 'model.safetensors'];
const MB = 1024 * 1024;

function stripFileScheme(path: string): string {
  return path.startsWith('file://') ? path.slice('file://'.length) : path;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function hfUrl(
  base: string,
  repo: string,
  revision: string,
  path: string,
): string {
  return `${base.replace(/\/+$/, '')}/${repo}/resolve/${revision}/${encodePath(path)}`;
}

/** Android file list for the downloadable checkpoint. */
export function androidModelFiles(): PhononModelFile[] {
  const files: PhononModelFile[] = PINS.checkpoint.files.map(f => ({
    ...f,
    url: hfUrl(
      HF_BASE_URL,
      PINS.checkpoint.repo,
      PINS.checkpoint.revision,
      f.path,
    ),
  }));
  for (const v of PHONON_CURATED_VOICES) {
    files.push({
      path: `voices/${v.name}.safetensors`,
      url: hfUrl(
        HF_BASE_URL,
        PINS.voices.repo,
        PINS.voices.revision,
        `voices/${v.voiceId}.safetensors`,
      ),
      size: PINS.voices.fileSize,
      sha256: v.sha256,
    });
  }
  return files;
}

/** voices.jsonl for the curated voices, in upstream's catalog format. */
export function curatedVoicesJsonl(): string {
  return (
    PHONON_CURATED_VOICES.map(v =>
      JSON.stringify({
        filename: `voices/${v.name}.safetensors`,
        name: v.name,
        voice_id: v.voiceId,
        language: 'en',
        locale: v.locale,
        gender: v.gender,
        description: v.description,
      }),
    ).join('\n') + '\n'
  );
}

/**
 * Parse a mirror manifest (`path<TAB>size<TAB>sha256`). Rejects absolute
 * paths, `..` segments and malformed lines; requires bundle.json.
 */
export function parseManifest(text: string): Omit<PhononModelFile, 'url'>[] {
  const out: Omit<PhononModelFile, 'url'>[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) {
      return;
    }
    const parts = line.split('\t');
    const [path, sizeStr, sha] = parts;
    const size = Number(sizeStr);
    if (
      parts.length !== 3 ||
      !path ||
      path.startsWith('/') ||
      path.split('/').some(s => s === '..' || s === '' || s === '.') ||
      !Number.isInteger(size) ||
      size < 0 ||
      !/^[0-9a-f]{64}$/.test(sha ?? '')
    ) {
      throw new PhononModelError(
        'bad-manifest',
        `Malformed manifest line ${i + 1}: ${JSON.stringify(raw)}`,
      );
    }
    if (seen.has(path)) {
      throw new PhononModelError('bad-manifest', `Duplicate path ${path}`);
    }
    seen.add(path);
    out.push({path, size, sha256: sha!});
  });
  if (!seen.has('bundle.json')) {
    throw new PhononModelError('bad-manifest', 'Manifest lists no bundle.json');
  }
  return out;
}

/** Bytes that must be free before a download starts. */
export function requiredFreeBytes(
  platform: 'android' | 'ios',
  totalBytes: number,
): number {
  // iOS: the staged bundle plus room for a fallback Core ML compile.
  return (platform === 'ios' ? 2 * totalBytes : totalBytes) + 100 * MB;
}

export interface PhononModelManagerOptions {
  platform?: 'android' | 'ios';
  iosMirror?: Partial<PhononIosMirror>;
}

export class PhononModelManager {
  private readonly platform: 'android' | 'ios';
  private iosMirror: PhononIosMirror;
  private installed: Map<PhononVariant, PhononModelInfo> = new Map();
  private inFlight: Map<PhononVariant, Promise<void>> = new Map();
  private activeVariant: PhononVariant = DEFAULT_VARIANT;

  constructor(options: PhononModelManagerOptions = {}) {
    this.platform =
      options.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
    this.iosMirror = {...DEFAULT_PHONON_IOS_MIRROR, ...options.iosMirror};
  }

  getPlatform(): 'android' | 'ios' {
    return this.platform;
  }

  getIosMirror(): PhononIosMirror {
    return {...this.iosMirror};
  }

  /** Point the iOS download at another mirror (repo, revision, ...). */
  setIosMirror(mirror: Partial<PhononIosMirror>): void {
    this.iosMirror = {...this.iosMirror, ...mirror};
  }

  /**
   * Android: `Documents/phonon/models`. iOS: `Library/Application
   * Support/phonon` (excluded from backup at download time).
   */
  getModelsDirectory(): string {
    return this.platform === 'ios'
      ? `${RNFS.LibraryDirectoryPath}/Application Support/phonon`
      : `${RNFS.DocumentDirectoryPath}/phonon/models`;
  }

  /** The folder used as `modelPath` (iOS: the inner bundle folder). */
  getVariantDirectory(variant: PhononVariant = this.activeVariant): string {
    const root = this.getModelsDirectory();
    return this.platform === 'ios'
      ? `${root}/${this.iosMirror.bundleName}`
      : `${root}/${variant}`;
  }

  private stagingDirectory(variant: PhononVariant): string {
    return `${this.getModelsDirectory()}/.staging-${variant}`;
  }

  /**
   * Variants offered on this platform. Non-commercial (user-provided)
   * ones are listed only when `includeNonCommercial` is set.
   */
  getAvailableVariants(includeNonCommercial = false): Array<{
    variant: PhononVariant;
    label: string;
    description: string;
    license: string;
    estimatedSize: number;
    userProvided: boolean;
    nonCommercial: boolean;
    isInstalled: boolean;
  }> {
    return (Object.keys(VARIANTS) as PhononVariant[])
      .filter(v => VARIANTS[v].platforms.includes(this.platform))
      .filter(v => includeNonCommercial || !VARIANTS[v].nonCommercial)
      .map(variant => {
        const c = VARIANTS[variant];
        return {
          variant,
          label: c.label,
          description: c.description,
          license: c.license,
          estimatedSize: c.estimatedSize[this.platform],
          userProvided: c.userProvided,
          nonCommercial: c.nonCommercial,
          isInstalled: this.installed.has(variant),
        };
      });
  }

  setActiveVariant(variant: PhononVariant): void {
    this.activeVariant = variant;
  }

  getActiveVariant(): PhononVariant {
    return this.activeVariant;
  }

  /** Files to download for `variant` (iOS: fetches the manifest). */
  async getFileList(variant: PhononVariant): Promise<PhononModelFile[]> {
    this.assertDownloadable(variant);
    if (this.platform === 'android') {
      return androidModelFiles();
    }
    const m = this.iosMirror;
    const text = await this.fetchManifest();
    return parseManifest(text).map(f => ({
      ...f,
      url: hfUrl(m.baseUrl, m.repo, m.revision, `${m.bundleName}/${f.path}`),
    }));
  }

  private assertDownloadable(variant: PhononVariant): void {
    const c = VARIANTS[variant];
    if (!c || !c.platforms.includes(this.platform)) {
      throw new PhononModelError(
        'unsupported-variant',
        `Phonon ${variant} is not available on ${this.platform}`,
      );
    }
    if (c.userProvided) {
      throw new PhononModelError(
        'user-provided',
        `Phonon ${variant} is ${c.license} and gated on Hugging Face; ` +
          `download it yourself and copy the checkpoint into ${this.getVariantDirectory(variant)}`,
      );
    }
  }

  private async fetchManifest(): Promise<string> {
    const m = this.iosMirror;
    if (!isPinnedMirror(m)) {
      // Every per-file sha256 comes from this manifest; a mutable
      // revision or an unpinned manifest leaves the chain unverified.
      console.warn(
        `[PhononModelManager] iOS mirror ${m.repo}@${m.revision} is not pinned ` +
          '(revision must be a commit sha and manifestSha256 set); ' +
          'downloaded files are checked only against the fetched manifest',
      );
    }
    const root = this.getModelsDirectory();
    await RNFS.mkdir(root, {NSURLIsExcludedFromBackupKey: true});
    const tmp = `${root}/.manifest-${Date.now()}.tsv`;
    try {
      await this.downloadVerified(
        {
          path: m.manifestPath,
          url: hfUrl(m.baseUrl, m.repo, m.revision, m.manifestPath),
          size: -1,
          sha256: m.manifestSha256 ?? '',
        },
        tmp,
        () => {},
      );
      return await RNFS.readFile(tmp, 'utf8');
    } finally {
      await this.removeQuietly(tmp);
    }
  }

  /**
   * Download one file to `dest` and verify it. `size < 0` / empty
   * `sha256` skip that check. Throws `PhononModelError`.
   */
  /**
   * Android: install `variant` from a local folder holding the download's
   * files at their download paths (a device-lab push via the package's
   * scripts/stage-android-model.sh). Same checks, catalog, marker and
   * atomic swap as downloadModel; the source folder is left as it is.
   */
  installFromDirectory(
    sourceDir: string,
    variant: PhononVariant = DEFAULT_VARIANT,
    onProgress?: (progress: PhononDownloadProgress) => void,
  ): Promise<void> {
    if (this.platform !== 'android') {
      return Promise.reject(
        new PhononModelError(
          'unsupported',
          'installFromDirectory is Android-only (iOS needs the mirror manifest)',
        ),
      );
    }
    if (this.inFlight.has(variant)) {
      return Promise.reject(
        new PhononModelError('busy', `${variant} is already downloading`),
      );
    }
    const source = stripFileScheme(sourceDir).replace(/\/+$/, '');
    const task = this.runDownload(variant, onProgress, source).finally(() => {
      this.inFlight.delete(variant);
    });
    this.inFlight.set(variant, task);
    return task;
  }

  /** Copy `from` to `dest`, then the download's size and sha256 checks. */
  private async copyVerified(
    file: PhononModelFile,
    from: string,
    dest: string,
  ): Promise<number> {
    if (!(await RNFS.exists(from))) {
      throw new PhononModelError(
        'missing-file',
        `${file.path}: not in ${from}`,
      );
    }
    await RNFS.copyFile(from, dest);
    return this.verifyFile(file, dest);
  }

  private async verifyFile(
    file: PhononModelFile,
    dest: string,
  ): Promise<number> {
    const stat = await RNFS.stat(dest);
    const size = Number(stat.size);
    if (file.size >= 0 && size !== file.size) {
      throw new PhononModelError(
        'size-mismatch',
        `${file.path}: expected ${file.size} bytes, got ${size}`,
      );
    }
    if (file.sha256) {
      const actual = (await RNFS.hash(dest, 'sha256')).toLowerCase();
      if (actual !== file.sha256) {
        throw new PhononModelError(
          'checksum',
          `${file.path}: sha256 ${actual}, expected ${file.sha256}`,
        );
      }
    }
    return size;
  }

  private async downloadVerified(
    file: PhononModelFile,
    dest: string,
    onBytes: (bytesWritten: number) => void,
  ): Promise<number> {
    const result = RNFS.downloadFile({
      fromUrl: file.url,
      toFile: dest,
      background: false,
      discretionary: false,
      cacheable: false,
      progressInterval: 500,
      progress: res => onBytes(res.bytesWritten),
    });
    const response = await result.promise;
    if (response.statusCode !== 200) {
      throw new PhononModelError(
        'http',
        `Failed to download ${file.path}: HTTP ${response.statusCode}`,
      );
    }
    return this.verifyFile(file, dest);
  }

  /**
   * Fail before any download when the disk is clearly too small. A failing
   * `getFSInfo` skips the check (a full disk then fails the download).
   */
  private async checkFreeSpace(totalBytes: number): Promise<void> {
    let free: number;
    try {
      free = Number((await RNFS.getFSInfo()).freeSpace);
    } catch (e) {
      console.warn('[PhononModelManager] getFSInfo failed; skipping check', e);
      return;
    }
    const needed = requiredFreeBytes(this.platform, totalBytes);
    if (Number.isFinite(free) && free < needed) {
      throw new PhononModelError(
        'insufficient-space',
        `Not enough free space for Phonon: need ${Math.ceil(needed / MB)} MB, ` +
          `have ${Math.floor(free / MB)} MB`,
      );
    }
  }

  /**
   * Download `variant`, verify every file, and install it atomically.
   * Any failure removes the partial download and keeps a previous
   * install. A second call while `variant` is downloading joins the
   * running download (both share one staging folder); its `onProgress`
   * is not called.
   */
  downloadModel(
    variant: PhononVariant = this.activeVariant,
    onProgress?: (progress: PhononDownloadProgress) => void,
  ): Promise<void> {
    const running = this.inFlight.get(variant);
    if (running) {
      console.log(
        `[PhononModelManager] ${variant} is already downloading; joining it`,
      );
      return running;
    }
    const task = this.runDownload(variant, onProgress).finally(() => {
      this.inFlight.delete(variant);
    });
    this.inFlight.set(variant, task);
    return task;
  }

  /** True while `variant` is downloading. */
  isDownloading(variant: PhononVariant = this.activeVariant): boolean {
    return this.inFlight.has(variant);
  }

  private async runDownload(
    variant: PhononVariant,
    onProgress?: (progress: PhononDownloadProgress) => void,
    /** installFromDirectory: copy from this folder instead of downloading */
    sourceDir?: string,
  ): Promise<void> {
    this.assertDownloadable(variant);
    const files = await this.getFileList(variant);
    const totalBytes = files.reduce((a, f) => a + f.size, 0);
    await this.checkFreeSpace(totalBytes);

    const root = this.getModelsDirectory();
    const staging = this.stagingDirectory(variant);
    const finalDir = this.getVariantDirectory(variant);

    await RNFS.mkdir(root, {NSURLIsExcludedFromBackupKey: true});
    await this.removeQuietly(staging);
    await RNFS.mkdir(staging, {NSURLIsExcludedFromBackupKey: true});

    let done = 0;
    const report = (current: number, name?: string) =>
      onProgress?.({
        totalBytes,
        downloadedBytes: current,
        progress: totalBytes > 0 ? Math.min(current / totalBytes, 0.99) : 0,
        currentFile: name,
      });

    try {
      const dirs = new Set<string>();
      for (const file of files) {
        const slash = file.path.lastIndexOf('/');
        if (slash > 0) {
          const dir = `${staging}/${file.path.slice(0, slash)}`;
          if (!dirs.has(dir)) {
            await RNFS.mkdir(dir);
            dirs.add(dir);
          }
        }
        console.log(
          `[PhononModelManager] ${sourceDir ? 'Copying' : 'Downloading'} ${file.path}...`,
        );
        const size = sourceDir
          ? await this.copyVerified(
              file,
              `${sourceDir}/${file.path}`,
              `${staging}/${file.path}`,
            )
          : await this.downloadVerified(
              file,
              `${staging}/${file.path}`,
              bytes => report(done + bytes, file.path),
            );
        done += size;
        report(done, file.path);
      }

      if (this.platform === 'android') {
        await RNFS.writeFile(
          `${staging}/${VOICES_JSONL}`,
          curatedVoicesJsonl(),
          'utf8',
        );
      }
      await RNFS.writeFile(
        `${staging}/${INSTALL_MARKER}`,
        JSON.stringify({
          variant,
          platform: this.platform,
          files: files.map(f => ({
            path: f.path,
            size: f.size,
            sha256: f.sha256,
          })),
          source:
            this.platform === 'ios'
              ? `${this.iosMirror.repo}@${this.iosMirror.revision}`
              : `${PINS.checkpoint.repo}@${PINS.checkpoint.revision}`,
          ...(sourceDir ? {copiedFrom: sourceDir} : {}),
          installedAt: new Date().toISOString(),
        }),
        'utf8',
      );

      await this.swapInto(staging, finalDir, variant);
      if (this.platform === 'ios') {
        // The engine requires modelPath to be excluded from backup.
        await RNFS.mkdir(finalDir, {NSURLIsExcludedFromBackupKey: true});
      }
    } catch (error) {
      await this.removeQuietly(staging);
      throw error;
    }

    onProgress?.({totalBytes, downloadedBytes: done, progress: 1});
    await this.checkInstallation(variant);
    console.log(`[PhononModelManager] Phonon ${variant} installed`);
  }

  /**
   * Install `staging` as `finalDir`. A previous install is renamed aside
   * first and restored when the move fails, so a failed swap never
   * leaves the user without a working model.
   */
  private async swapInto(
    staging: string,
    finalDir: string,
    variant: PhononVariant,
  ): Promise<void> {
    const old = `${this.getModelsDirectory()}/.old-${variant}`;
    await this.removeQuietly(old);
    const hadPrevious = await RNFS.exists(finalDir);
    if (hadPrevious) {
      await RNFS.moveFile(finalDir, old);
    }
    try {
      await RNFS.moveFile(staging, finalDir);
    } catch (error) {
      if (hadPrevious) {
        // A partial move may have created finalDir; clear it first.
        await this.removeQuietly(finalDir);
        try {
          await RNFS.moveFile(old, finalDir);
        } catch (restoreError) {
          console.warn(
            `[PhononModelManager] could not restore ${finalDir}:`,
            restoreError,
          );
        }
      }
      throw error;
    }
    await this.removeQuietly(old);
  }

  private async removeQuietly(path: string): Promise<void> {
    try {
      if (await RNFS.exists(path)) {
        await RNFS.unlink(path);
      }
    } catch (error) {
      console.warn(`[PhononModelManager] Failed to remove ${path}:`, error);
    }
  }

  /** Scan every variant; keep the active one if installed. */
  async scanInstalledModel(): Promise<void> {
    const variants = (Object.keys(VARIANTS) as PhononVariant[]).filter(v =>
      VARIANTS[v].platforms.includes(this.platform),
    );
    await Promise.all(variants.map(v => this.checkInstallation(v)));
    if (this.installed.has(this.activeVariant)) {
      return;
    }
    const first = variants.find(v => this.installed.has(v));
    if (first) {
      this.activeVariant = first;
    }
  }

  /**
   * Downloaded variants need their install marker (written last, before
   * the rename). User-provided checkpoints need config, tokenizer and
   * weights.
   */
  async checkInstallation(variant: PhononVariant): Promise<boolean> {
    const dir = this.getVariantDirectory(variant);
    const c = VARIANTS[variant];
    try {
      let ok: boolean;
      if (c.userProvided) {
        const [cfg, tok, ...weights] = await Promise.all([
          RNFS.exists(`${dir}/config.json`),
          RNFS.exists(`${dir}/tokenizer.json`),
          ...CHECKPOINT_WEIGHTS.map(w => RNFS.exists(`${dir}/${w}`)),
        ]);
        ok = cfg && tok && weights.some(Boolean);
      } else {
        ok =
          (await RNFS.exists(`${dir}/${INSTALL_MARKER}`)) &&
          (await RNFS.exists(
            `${dir}/${this.platform === 'ios' ? 'bundle.json' : 'config.json'}`,
          ));
      }
      if (!ok) {
        this.installed.delete(variant);
        return false;
      }
      this.installed.set(variant, {
        variant,
        path: dir,
        size: await this.folderSize(dir),
        voices: await this.listVoices(dir),
        license: c.license,
        description: c.description,
      });
      return true;
    } catch {
      this.installed.delete(variant);
      return false;
    }
  }

  private async folderSize(dir: string): Promise<number> {
    let total = 0;
    for (const item of await RNFS.readDir(dir)) {
      total += item.isDirectory()
        ? await this.folderSize(item.path)
        : Number(item.size);
    }
    return total;
  }

  /** Android: voice file stems in voices/ (plus 'default'). iOS: []. */
  private async listVoices(dir: string): Promise<string[]> {
    if (this.platform === 'ios') {
      return [];
    }
    const out: string[] = [];
    try {
      if (await RNFS.exists(`${dir}/voices`)) {
        for (const item of await RNFS.readDir(`${dir}/voices`)) {
          if (item.isFile() && item.name.endsWith('.safetensors')) {
            out.push(item.name.slice(0, -'.safetensors'.length));
          }
        }
      }
      if (await RNFS.exists(`${dir}/default-voice.safetensors`)) {
        out.push('default');
      }
    } catch {
      // Display only.
    }
    return out.sort();
  }

  getInstalledModel(): PhononModelInfo | null {
    return this.installed.get(this.activeVariant) ?? null;
  }

  getAllInstalledModels(): PhononModelInfo[] {
    return Array.from(this.installed.values());
  }

  async isModelInstalled(
    variant: PhononVariant = this.activeVariant,
  ): Promise<boolean> {
    return this.checkInstallation(variant);
  }

  async deleteModel(
    variant: PhononVariant = this.activeVariant,
  ): Promise<void> {
    await this.removeQuietly(this.getVariantDirectory(variant));
    await this.removeQuietly(this.stagingDirectory(variant));
    await this.removeQuietly(`${this.getModelsDirectory()}/.old-${variant}`);
    this.installed.delete(variant);
    if (variant === this.activeVariant) {
      const remaining = Array.from(this.installed.keys());
      this.activeVariant = remaining[0] ?? DEFAULT_VARIANT;
    }
  }

  /**
   * Engine config for an installed variant. `modelPath` is a plain
   * absolute path (no file:// scheme), as the native loader expects.
   */
  getDownloadedModelConfig(
    variant: PhononVariant = this.activeVariant,
  ): PhononConfig {
    const dir = stripFileScheme(this.getVariantDirectory(variant));
    const config: PhononConfig = {modelPath: dir, language: 'en'};
    if (this.platform === 'android' && !VARIANTS[variant].userProvided) {
      config.voicesMetadataPath = `${dir}/${VOICES_JSONL}`;
    }
    return config;
  }

  getEstimatedModelSize(variant: PhononVariant = this.activeVariant): number {
    return VARIANTS[variant].estimatedSize[this.platform];
  }
}

export const phononModelManager = new PhononModelManager();
