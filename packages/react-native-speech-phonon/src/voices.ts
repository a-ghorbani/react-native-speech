/**
 * Phonon voice metadata.
 *
 * Native reports bare voice ids (the names the voices were saved under).
 * Display metadata comes from an optional `voices.jsonl` subset of the
 * `gradium/phonon-voices` catalog: one JSON object per line with `name`
 * and `filename`, and optionally `voice_id`, `language`, `description`.
 */

import type {PhononVoice} from './types';

export interface PhononCatalogEntry {
  name: string;
  filename?: string;
  voice_id?: string;
  language?: string;
  description?: string;
  gender?: string;
}

/**
 * Parse a voices.jsonl document. Blank lines are skipped; malformed
 * lines and objects without a string `name` are dropped.
 */
export function parseVoicesJsonl(text: string): PhononCatalogEntry[] {
  const out: PhononCatalogEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj && typeof obj.name === 'string' && obj.name.length > 0) {
        const str = (k: string) =>
          typeof obj[k] === 'string' ? (obj[k] as string) : undefined;
        out.push({
          name: obj.name,
          filename: str('filename'),
          voice_id: str('voice_id'),
          language: str('language'),
          description: str('description'),
          gender: str('gender'),
        });
      }
    } catch {
      // Ignore malformed lines; metadata is display-only.
    }
  }
  return out;
}

/** Case- and accent-insensitive key, matching upstream's catalog lookup. */
export function foldVoiceName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Build `PhononVoice`s for the native voice ids, enriched from catalog
 * entries matched by folded name or `voice_id`. Order follows `ids`.
 */
export function buildVoices(
  ids: readonly string[],
  catalog: readonly PhononCatalogEntry[],
  fallbackLanguage?: string,
): PhononVoice[] {
  const byName = new Map<string, PhononCatalogEntry>();
  const byId = new Map<string, PhononCatalogEntry>();
  for (const entry of catalog) {
    byName.set(foldVoiceName(entry.name), entry);
    if (entry.voice_id) {
      byId.set(entry.voice_id, entry);
    }
  }
  return ids.map(id => {
    const entry = byName.get(foldVoiceName(id)) ?? byId.get(id);
    const voice: PhononVoice = {id, name: entry?.name ?? id};
    const language = entry?.language ?? fallbackLanguage;
    if (language) {
      voice.language = language;
    }
    if (entry?.gender) {
      voice.gender = entry.gender;
    }
    if (entry?.description) {
      voice.description = entry.description;
    }
    return voice;
  });
}
