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

  it('does not split on decimals, currency, or mid-word punctuation', () => {
    expect(round('Pi is 3.14 approximately.', 400)).toEqual([
      {text: 'Pi is 3.14 approximately.', start: 0, end: 25},
    ]);
    expect(round('It costs $1.50 total.', 400)).toEqual([
      {text: 'It costs $1.50 total.', start: 0, end: 21},
    ]);
    expect(round('Version 2.0.0 is out.', 400)).toEqual([
      {text: 'Version 2.0.0 is out.', start: 0, end: 21},
    ]);
  });

  it('splits only when punctuation is followed by whitespace + uppercase', () => {
    const t = 'First. Second. Third.';
    const r = round(t, 400);
    expect(r.map(c => c.text)).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('does not split abbreviations followed by lowercase', () => {
    // "etc. and" — lowercase after, should NOT split
    expect(round('Apples, oranges, etc. and bananas.', 400)).toEqual([
      {text: 'Apples, oranges, etc. and bananas.', start: 0, end: 34},
    ]);
  });

  it('treats ellipsis as a single boundary, not three', () => {
    const r = round('Hi... wait. Go on.', 400);
    // "..." followed by " w" (lowercase) → no split. "." after "wait" + " G" → split.
    expect(r.map(c => c.text)).toEqual(['Hi... wait.', 'Go on.']);
  });

  it('handles mixed punctuation like "?!"', () => {
    const r = round('Really?! Yes! Done.', 400);
    expect(r.map(c => c.text)).toEqual(['Really?!', 'Yes!', 'Done.']);
  });

  it('handles multiple whitespace between sentences', () => {
    const t = 'First.\n\n  Second.';
    const r = round(t, 400);
    expect(r).toHaveLength(2);
    expect(t.slice(r[0]!.start, r[0]!.end)).toBe('First.');
    expect(t.slice(r[1]!.start, r[1]!.end)).toBe('Second.');
  });

  it('strips leading whitespace from the first chunk', () => {
    const r = round('   Hello world.', 400);
    expect(r).toEqual([{text: 'Hello world.', start: 3, end: 15}]);
  });

  it('exclamation at end closes the chunk', () => {
    expect(round('Done!', 400)).toEqual([{text: 'Done!', start: 0, end: 5}]);
  });

  it('chunk end never exceeds text length', () => {
    // Regression guard: the boundary regex can consume trailing whitespace
    // past end-of-string via `$`; make sure we never emit end > text.length.
    const t = 'Done.';
    const [chunk] = round(t, 400);
    expect(chunk!.end).toBeLessThanOrEqual(t.length);
  });
});
