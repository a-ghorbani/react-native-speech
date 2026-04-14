/**
 * NativeDictSource — DictSource backed by the RNSpeech Turbo Module's
 * mmap'd EPD1 binary dict (cpp/native_dict.cpp).
 *
 * One open dict at a time per process; calling openNativeDict() replaces
 * any previously-open dict.
 */
import TurboSpeech from '../NativeSpeech';
import type {DictSource} from './DictSource';

export class NativeDictSource implements DictSource {
  /** Path the dict was opened from. Informational only. */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  lookup(word: string): string | null {
    return TurboSpeech.dictLookup(word);
  }

  // Native side knows the entry count but does not currently expose it.
  // Returning undefined keeps the logging path optional.
  size(): undefined {
    return undefined;
  }

  toString(): string {
    return `NativeDictSource(${this.path})`;
  }
}

/**
 * Open a dict file via the Turbo Module and return a NativeDictSource bound
 * to it. Throws if the open call fails.
 */
export async function openNativeDict(path: string): Promise<NativeDictSource> {
  const ok = await TurboSpeech.dictOpen(path);
  if (!ok) {
    throw new Error(`Failed to open native dict at ${path}`);
  }
  return new NativeDictSource(path);
}
