import {chunkTextWithPositions} from '../chunkTextWithPositions';

const round = (
  t: string,
  max: number,
): Array<{text: string; start: number; end: number}> =>
  chunkTextWithPositions(t, max).map(c => ({
    text: c.text,
    start: c.startIndex,
    end: c.endIndex,
  }));

describe('chunkTextWithPositions', () => {
  it('returns a single chunk for a single sentence under max', () => {
    const r = round('Hello world.', 400);
    expect(r).toEqual([{text: 'Hello world.', start: 0, end: 12}]);
  });

  it('emits one chunk per sentence with original-text positions', () => {
    const t = 'Hi. How are you? Good.';
    const r = round(t, 400);
    expect(r).toHaveLength(3);
    // Each returned start..end slices back to the sentence we chunked.
    for (const c of r) {
      expect(t.slice(c.start, c.end).trim()).toMatch(
        /^(Hi\.|How are you\?|Good\.)$/,
      );
    }
  });

  it("appends ',' to sentences that lack terminal punctuation", () => {
    const r = round('Hello world', 400);
    expect(r).toEqual([{text: 'Hello world,', start: 0, end: 11}]);
  });

  it('preserves positions across a sentence boundary with extra whitespace', () => {
    const t = 'First.   Second sentence.';
    const r = round(t, 400);
    expect(r).toHaveLength(2);
    expect(t.slice(r[0]!.start, r[0]!.end)).toBe('First.');
    expect(t.slice(r[1]!.start, r[1]!.end)).toBe('Second sentence.');
  });

  it('falls back to word-splitting only when a single sentence exceeds max', () => {
    // 50-char sentence; cap at 20 forces split.
    const t = 'The quick brown fox jumps over the lazy dog today.';
    const r = round(t, 20);
    expect(r.length).toBeGreaterThan(1);
    // Every chunk must slice back to a real substring of the original text.
    for (const c of r) {
      const slice = t.slice(c.start, c.end);
      expect(slice.length).toBeGreaterThan(0);
      // Chunk text (minus ensurePunctuation tail) is contained in the slice.
      const withoutTail = c.text.replace(/[,]$/, '');
      expect(slice).toContain(
        withoutTail
          .replace(/[.!?]+$/, '')
          .trimStart()
          .split(/\s+/)[0]!,
      );
    }
  });

  it('produces non-overlapping monotonic ranges', () => {
    const t = 'A. B. C. D.';
    const r = round(t, 400);
    for (let i = 1; i < r.length; i++) {
      expect(r[i]!.start).toBeGreaterThanOrEqual(r[i - 1]!.end);
    }
  });

  it('handles empty and whitespace-only input safely', () => {
    expect(round('', 400)).toEqual([]);
    expect(round('   ', 400)).toEqual([]);
  });
});
