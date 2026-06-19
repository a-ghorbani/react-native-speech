/**
 * UnicodeProcessor language-tag tests.
 *
 * Locks the contract that `normalize(text, lang)` wraps text in
 * `<lang>...</lang>` for tag-capable (v2/v3) indexers — including the
 * language-agnostic `'na'` code — and falls back to `'en'` for codes the
 * engine doesn't recognize. Mirrors upstream `helper.py::_preprocess_text`
 * (`text = f"<{lang}>" + text + f"</{lang}>"`).
 */

const mockLoadAssetAsJSON = jest.fn();
jest.mock('../../../utils/AssetLoader', () => ({
  loadAssetAsJSON: (...args: unknown[]) => mockLoadAssetAsJSON(...args),
  loadAssetAsText: jest.fn(),
  loadAssetAsArrayBuffer: jest.fn(),
}));

import {UnicodeProcessor} from '../UnicodeProcessor';

// Indexer: index = code point, value = vocab index. ASCII 32..126 are
// mapped (so '<' at 60 and '>' at 62 are present → language tags enabled).
function tagCapableIndexer(): number[] {
  const indexer = new Array(256).fill(-1);
  for (let i = 32; i < 127; i++) indexer[i] = i - 32;
  return indexer;
}

// v1-style indexer: no '<' / '>' → language tags disabled.
function tagLessIndexer(): number[] {
  const indexer = tagCapableIndexer();
  indexer[60] = -1; // '<'
  indexer[62] = -1; // '>'
  return indexer;
}

async function makeProcessor(indexer: number[]): Promise<UnicodeProcessor> {
  mockLoadAssetAsJSON.mockResolvedValueOnce(indexer);
  const p = new UnicodeProcessor();
  await p.initialize('file:///fake/unicode_indexer.json');
  return p;
}

describe('UnicodeProcessor.normalize — language tags', () => {
  it('wraps text in <en>...</en> for a tag-capable indexer', async () => {
    const p = await makeProcessor(tagCapableIndexer());
    expect(p.hasLanguageTagSupport()).toBe(true);
    expect(p.normalize('Hello world', 'en')).toBe('<en>Hello world.</en>');
  });

  it('wraps the language-agnostic code as <na>...</na>', async () => {
    const p = await makeProcessor(tagCapableIndexer());
    expect(p.normalize('Hello world', 'na')).toBe('<na>Hello world.</na>');
  });

  it('falls back to <en> for an unrecognized language code', async () => {
    const p = await makeProcessor(tagCapableIndexer());
    expect(p.normalize('Hello world', 'zz')).toBe('<en>Hello world.</en>');
  });

  it('adds no language tag when the indexer lacks < and > (v1)', async () => {
    const p = await makeProcessor(tagLessIndexer());
    expect(p.hasLanguageTagSupport()).toBe(false);
    expect(p.normalize('Hello world', 'na')).toBe('Hello world.');
  });
});
