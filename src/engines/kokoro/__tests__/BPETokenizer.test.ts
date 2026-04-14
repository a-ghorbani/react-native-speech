/**
 * BPETokenizer behavioural tests.
 *
 * Kokoro's tokenizer is character-level (despite the BPE name) and drops
 * any characters not in the vocab. These tests pin the contract:
 * deterministic encode, boundary-token wrapping, drop-on-unknown,
 * round-trip stability, and multi-byte support.
 */

import {BPETokenizer} from '../BPETokenizer';

const baseVocab: Record<string, number> = {
  $: 0, // boundary
  ' ': 1,
  a: 2,
  b: 3,
  c: 4,
  d: 5,
  e: 6,
  f: 7,
  g: 8,
  h: 9,
  i: 10,
  l: 11,
  o: 12,
  r: 13,
  t: 14,
  w: 15,
  é: 16, // multi-byte (single char though)
  '😀': 17, // surrogate pair
  ɪ: 18, // IPA
  ʊ: 19,
};

async function makeTokenizer(): Promise<BPETokenizer> {
  const t = new BPETokenizer();
  await t.loadFromData(baseVocab, []);
  return t;
}

describe('BPETokenizer - parity & contract', () => {
  it('throws if encode is called before init', () => {
    const t = new BPETokenizer();
    expect(() => t.encode('abc')).toThrow(/not initialized/);
  });

  it('wraps output in boundary tokens (BOS=EOS=$ id 0)', async () => {
    const t = await makeTokenizer();
    const out = t.encode('a');
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(0);
    expect(out).toEqual([0, 2, 0]);
  });

  it('encode is deterministic for identical inputs', async () => {
    const t = await makeTokenizer();
    const a = t.encode('hello world');
    const b = t.encode('hello world');
    expect(a).toEqual(b);
  });

  it('handles empty string (just boundaries)', async () => {
    const t = await makeTokenizer();
    expect(t.encode('')).toEqual([0, 0]);
  });

  it('handles whitespace-only input', async () => {
    const t = await makeTokenizer();
    expect(t.encode('   ')).toEqual([0, 1, 1, 1, 0]);
  });

  it('handles a single ASCII char', async () => {
    const t = await makeTokenizer();
    expect(t.encode('a')).toEqual([0, 2, 0]);
  });

  it('drops characters not in the vocab silently', async () => {
    const t = await makeTokenizer();
    // 'x' and 'y' are not in vocab — should be dropped, not produce UNK.
    expect(t.encode('xay')).toEqual([0, 2, 0]);
  });

  it('handles multi-byte (Latin-1) characters', async () => {
    const t = await makeTokenizer();
    expect(t.encode('café')).toEqual([0, 4, 2, 7, 16, 0]);
  });

  it('handles emoji (surrogate pair) as a single token', async () => {
    const t = await makeTokenizer();
    // String iteration in BPETokenizer uses for..of, so 😀 is one code point.
    expect(t.encode('😀')).toEqual([0, 17, 0]);
  });

  it('handles IPA phoneme strings (real use case)', async () => {
    const t = await makeTokenizer();
    expect(t.encode('hɪʊ')).toEqual([0, 9, 18, 19, 0]);
  });

  it('encodes a contraction (apostrophe is dropped if not in vocab)', async () => {
    const t = await makeTokenizer();
    // "don't" — only d, o, t, n? n is not in baseVocab — n dropped, ' dropped.
    expect(t.encode("don't")).toEqual([0, 5, 12, 14, 0]);
  });

  it('decode returns characters joined, skipping boundary tokens', async () => {
    const t = await makeTokenizer();
    expect(t.decode([0, 9, 6, 11, 11, 12, 0])).toBe('hello');
  });

  it('round-trips text that consists only of in-vocab characters', async () => {
    const t = await makeTokenizer();
    const encoded = t.encode('hello');
    expect(t.decode(encoded)).toBe('hello');
  });

  it('clear() resets to uninitialized state', async () => {
    const t = await makeTokenizer();
    expect(t.isReady()).toBe(true);
    t.clear();
    expect(t.isReady()).toBe(false);
    expect(() => t.encode('a')).toThrow(/not initialized/);
  });
});
