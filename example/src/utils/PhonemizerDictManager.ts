/**
 * Phonemizer Dictionary Manager
 *
 * Shared downloader for the espeak-ng-derived IPA dictionary used by the
 * GPL-free JS phonemizer (consumed by Kokoro and Kitten engines).
 *
 * The TSV file is language-keyed so adding a new language is a one-line
 * entry in DICT_URLS plus a dict regeneration upstream.
 */

import * as RNFS from '@dr.pogodin/react-native-fs';

// TODO: publish the TSV to a stable location and update these URLs.
// Dict source: react-native-speech/third-party/phonemizer-dicts/en-us.tsv
const DICT_URLS: Record<string, string> = {
  'en-us':
    'https://huggingface.co/datasets/palshub/phonemizer-dicts/resolve/main/en-us.tsv',
};

export type PhonemizerLanguage = keyof typeof DICT_URLS;

export interface DictDownloadProgress {
  language: PhonemizerLanguage;
  totalBytes: number;
  downloadedBytes: number;
  progress: number;
}

export class PhonemizerDictManager {
  private getDictsDirectory(): string {
    return `${RNFS.DocumentDirectoryPath}/phonemizer-dicts`;
  }

  getDictPath(language: PhonemizerLanguage = 'en-us'): string {
    return `file://${this.getDictsDirectory()}/${language}.tsv`;
  }

  async isInstalled(language: PhonemizerLanguage = 'en-us'): Promise<boolean> {
    const path = this.getDictPath(language).replace('file://', '');
    return RNFS.exists(path);
  }

  /**
   * Ensure the dict for the given language is downloaded. No-op if already
   * present. Returns the local file:// path.
   */
  async ensureDict(
    language: PhonemizerLanguage = 'en-us',
    onProgress?: (p: DictDownloadProgress) => void,
  ): Promise<string> {
    const url = DICT_URLS[language];
    if (!url) throw new Error(`No dict URL for language: ${language}`);

    const dictsDir = this.getDictsDirectory();
    const path = `${dictsDir}/${language}.tsv`;

    if (await RNFS.exists(path)) {
      return `file://${path}`;
    }

    await RNFS.mkdir(dictsDir, {NSURLIsExcludedFromBackupKey: true});

    console.log(`[PhonemizerDict] Downloading ${language} dict from ${url}`);
    const result = await RNFS.downloadFile({
      fromUrl: url,
      toFile: path,
      background: false,
      progressInterval: 500,
      progress: res => {
        if (onProgress) {
          onProgress({
            language,
            totalBytes: res.contentLength,
            downloadedBytes: res.bytesWritten,
            progress: res.bytesWritten / res.contentLength,
          });
        }
      },
    }).promise;

    if (result.statusCode !== 200) {
      try {
        await RNFS.unlink(path);
      } catch {}
      throw new Error(`Dict download failed: HTTP ${result.statusCode}`);
    }

    return `file://${path}`;
  }

  async delete(language: PhonemizerLanguage = 'en-us'): Promise<void> {
    const path = this.getDictPath(language).replace('file://', '');
    if (await RNFS.exists(path)) {
      await RNFS.unlink(path);
    }
  }
}

export const phonemizerDictManager = new PhonemizerDictManager();
