/**
 * Dictionary loader for the GPL-free phonemizer.
 *
 * Parses a TSV of `word<TAB>ipa` lines (e.g. pre-generated from espeak-ng
 * via a one-time CLI invocation). Results are cached by path so repeated
 * engine initializations do not re-parse the 2+ MB file.
 */

import {loadAssetAsText} from '../utils/AssetLoader';

const cache = new Map<string, Record<string, string>>();

export async function loadDict(path: string): Promise<Record<string, string>> {
  const cached = cache.get(path);
  if (cached) return cached;

  const text = await loadAssetAsText(path);
  const dict: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab > 0) {
      dict[line.slice(0, tab)] = line.slice(tab + 1);
    }
  }

  cache.set(path, dict);
  return dict;
}

export function clearDictCache(): void {
  cache.clear();
}
