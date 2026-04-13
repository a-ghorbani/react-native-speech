/**
 * JsDictSource — in-memory dict backed by a plain object.
 *
 * Used as a fallback / for tests / for non-RN environments. Production
 * (React Native) uses NativeDictSource which mmap's the binary dict file
 * via the Turbo Module.
 */
import type {DictSource} from './DictSource';

export class JsDictSource implements DictSource {
  private readonly dict: Record<string, string>;

  constructor(dict: Record<string, string>) {
    this.dict = dict;
  }

  lookup(word: string): string | null {
    return this.dict[word] ?? null;
  }

  size(): number {
    return Object.keys(this.dict).length;
  }
}
