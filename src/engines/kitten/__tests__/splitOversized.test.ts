import {splitOversizedSource, concatAudioBuffers} from '../splitOversized';
import type {AudioBuffer} from '../../../types';

describe('splitOversizedSource', () => {
  describe('sentence-level splits (highest prosody quality)', () => {
    test('splits on `.` followed by whitespace', () => {
      expect(splitOversizedSource('First. Second. Third.')).toEqual([
        'First.',
        'Second.',
        'Third.',
      ]);
    });

    test('splits on `!` and `?`', () => {
      expect(splitOversizedSource('Wow! Really? Yes!')).toEqual([
        'Wow!',
        'Really?',
        'Yes!',
      ]);
    });

    test('splits on `.\\n` (sentence + newline, common after stripper)', () => {
      expect(splitOversizedSource('First sentence.\nSecond sentence.')).toEqual(
        ['First sentence.', 'Second sentence.'],
      );
    });

    test('sentence tier wins over clause tier when both present', () => {
      // Input has both `,` and `.` boundaries — sentence should win
      // because it's tier 1 (better prosody).
      const out = splitOversizedSource('a, b. c, d.');
      // Sentence split: ['a, b.', 'c, d.']
      // Clause split would be: ['a,', 'b.', 'c,', 'd.']
      expect(out).toEqual(['a, b.', 'c, d.']);
    });
  });

  describe('clause-level splits (when no sentence boundaries)', () => {
    test('splits on commas + space', () => {
      expect(splitOversizedSource('one, two, three, four')).toEqual([
        'one,',
        'two,',
        'three,',
        'four',
      ]);
    });

    test('splits on semicolons', () => {
      expect(splitOversizedSource('alpha; beta; gamma')).toEqual([
        'alpha;',
        'beta;',
        'gamma',
      ]);
    });

    test('splits on colons', () => {
      expect(splitOversizedSource('header: body content here')).toEqual([
        'header:',
        'body content here',
      ]);
    });

    test('keeps punctuation with the preceding piece (lookbehind)', () => {
      // The piece-level prosody is more natural when ',' stays attached.
      const pieces = splitOversizedSource('first, second, third');
      expect(pieces[0]).toMatch(/,$/);
      expect(pieces[1]).toMatch(/,$/);
      expect(pieces[2]).not.toMatch(/[,;:]$/);
    });

    test('mixed clause separators', () => {
      expect(splitOversizedSource('item: a, b; c, d')).toEqual([
        'item:',
        'a,',
        'b;',
        'c,',
        'd',
      ]);
    });
  });

  describe('bare newline splits (when no sentence/clause punctuation)', () => {
    test('splits on \\n between non-punctuated lines', () => {
      // Stripped list items lose their `-` markers; if multiple line
      // items lack final punctuation, only `\n` separates them.
      expect(splitOversizedSource('item one\nitem two\nitem three')).toEqual([
        'item one',
        'item two',
        'item three',
      ]);
    });

    test('punctuation+newline takes the higher tier (cascade returns at first ≥2 split)', () => {
      // `:\n` triggers the clause tier (2); since that produces 2
      // pieces, the cascade STOPS there and tier 3 (bare newlines)
      // doesn't run. The trailing piece keeps both bullets as one — if
      // it's still oversized when re-tokenized in the engine, the
      // recursive call will split on bare newlines next pass. This is
      // the documented behavior; it allows the engine to make a
      // single-pass minimal split per recursion.
      const out = splitOversizedSource('header:\nbullet a\nbullet b');
      expect(out).toEqual(['header:', 'bullet a\nbullet b']);
    });

    test('recursive split with size threshold flattens punctuation+newline cases', () => {
      // Simulate what KittenEngine.synthesizeTextChunk does: each piece
      // recurses ONLY if still over its budget. Otherwise the engine
      // stops splitting and synthesizes that piece.
      function deepSplit(text: string, threshold: number): string[] {
        if (text.length <= threshold) return [text];
        const pieces = splitOversizedSource(text);
        if (pieces.length <= 1) return pieces;
        return pieces.flatMap(p => deepSplit(p, threshold));
      }
      // Pretend each piece must be ≤ 12 chars to mimic an oversize cap.
      // The trailing 'bullet a\nbullet b' is 17 chars, so it splits
      // again on bare newline; individual bullets (8 chars) are under
      // threshold and stop.
      expect(deepSplit('header:\nbullet a\nbullet b', 12)).toEqual([
        'header:',
        'bullet a',
        'bullet b',
      ]);
    });

    test('multiple consecutive newlines collapse into one split', () => {
      expect(splitOversizedSource('para one\n\n\npara two')).toEqual([
        'para one',
        'para two',
      ]);
    });

    test('newline tier yields ≥2 pieces for paragraph-style input', () => {
      // No sentence/clause punctuation, only newlines.
      const out = splitOversizedSource(
        'block one with no terminator\nblock two same\nblock three',
      );
      expect(out.length).toBe(3);
    });
  });

  describe('tier ordering (highest-prosody wins)', () => {
    test('sentence > clause > bare-newline > word', () => {
      // Input crafted so each tier WOULD split, but only the highest
      // tier (sentence) actually fires.
      const input = 'Hello world. Goodbye, world\nseparated text here';
      const out = splitOversizedSource(input);
      // Sentence boundary at `Hello world. ` produces 2 pieces.
      expect(out).toEqual([
        'Hello world.',
        'Goodbye, world\nseparated text here',
      ]);
      // The trailing piece still contains comma and newline — those
      // would split on their own tiers, but the cascade returns at the
      // first tier that produced ≥2 pieces. Recursion in the engine
      // calls splitOversizedSource on the trailing piece if it's STILL
      // oversized, which then falls to clause/newline tiers.
    });

    test('falls through to clause when no sentence boundary present', () => {
      const out = splitOversizedSource('a, b, c, d');
      expect(out).toEqual(['a,', 'b,', 'c,', 'd']);
    });

    test('falls through to newline when no sentence/clause boundary present', () => {
      const out = splitOversizedSource('alpha\nbeta\ngamma');
      expect(out).toEqual(['alpha', 'beta', 'gamma']);
    });

    test('falls through to word when no other boundaries present', () => {
      const out = splitOversizedSource('one two three four five six');
      // No punctuation, no \n — uses midpoint word boundary.
      expect(out).toHaveLength(2);
      expect(out.join(' ')).toBe('one two three four five six');
    });
  });

  describe('word-boundary splits (fallback)', () => {
    test('splits at whitespace near midpoint when no clause punctuation', () => {
      // No `,;:` in this string — falls back to whitespace.
      const text = 'one two three four five six seven eight nine ten';
      const pieces = splitOversizedSource(text);
      expect(pieces).toHaveLength(2);
      expect(pieces.join(' ')).toBe(text);
      // Both halves should be roughly balanced (within a word).
      const lengths = pieces.map(p => p.length);
      expect(Math.abs(lengths[0]! - lengths[1]!)).toBeLessThan(10);
    });

    test('searches outward from midpoint for whitespace', () => {
      // The midpoint lands inside a word; helper finds the nearest space.
      const text = 'aa bb ccccccccccccc dd ee';
      const pieces = splitOversizedSource(text);
      expect(pieces).toHaveLength(2);
      expect(pieces.join(' ')).toBe(text);
    });
  });

  describe('unsplittable inputs (give up)', () => {
    test('single very long word returns one piece', () => {
      const blob = 'a'.repeat(600);
      expect(splitOversizedSource(blob)).toEqual([blob]);
    });

    test('empty string returns empty array', () => {
      expect(splitOversizedSource('')).toEqual([]);
    });

    test('whitespace-only returns empty array', () => {
      expect(splitOversizedSource('   \n  ')).toEqual([]);
    });

    test('single short word returns itself', () => {
      expect(splitOversizedSource('hello')).toEqual(['hello']);
    });
  });

  describe('edge whitespace', () => {
    test('trims pieces of leading/trailing whitespace', () => {
      const pieces = splitOversizedSource('  hello,   world,   bye  ');
      expect(pieces).toEqual(['hello,', 'world,', 'bye']);
    });
  });

  describe('regression: anti-loop guarantee', () => {
    // The recursive caller in KittenEngine relies on this contract: if
    // the input couldn't be split into ≥2 pieces, we return length 1
    // (or 0). Otherwise the caller would loop forever on a stubbornly
    // oversized input.
    const inputs = [
      '',
      '   ',
      'x',
      'longwordnowhitespaceatall',
      'a'.repeat(1000),
    ];
    test.each(inputs.map(i => [i]))(
      'unsplittable input returns ≤ 1 piece for %j',
      input => {
        const out = splitOversizedSource(input);
        expect(out.length).toBeLessThanOrEqual(1);
      },
    );

    // Conversely: any input with at least one clause separator OR enough
    // whitespace MUST split into ≥2 pieces, so the caller progresses.
    test('splittable input always returns ≥2 pieces', () => {
      const splittable = [
        'a, b',
        'a; b',
        'a: b',
        'one two three four five',
        'short, longer second clause here',
      ];
      for (const s of splittable) {
        const out = splitOversizedSource(s);
        expect(out.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});

describe('concatAudioBuffers', () => {
  function makeBuf(values: number[], rate = 24000, channels = 1): AudioBuffer {
    return {
      samples: new Float32Array(values),
      sampleRate: rate,
      channels,
      duration: values.length / rate,
    };
  }

  test('single buffer is returned as-is', () => {
    const a = makeBuf([0.1, 0.2, 0.3]);
    expect(concatAudioBuffers([a])).toBe(a);
  });

  test('two buffers concatenated in order', () => {
    // Use values that round-trip exactly through Float32Array so toEqual
    // works (avoid 0.1, 0.2, etc. — those lose precision in Float32).
    const a = makeBuf([1, 2]);
    const b = makeBuf([3, 4, 5]);
    const result = concatAudioBuffers([a, b]);
    expect(Array.from(result.samples)).toEqual([1, 2, 3, 4, 5]);
    expect(result.sampleRate).toBe(24000);
    expect(result.channels).toBe(1);
    expect(result.duration).toBeCloseTo(5 / 24000);
  });

  test('many buffers preserve sample order across all of them', () => {
    const bufs = [
      makeBuf([1]),
      makeBuf([2, 3]),
      makeBuf([4]),
      makeBuf([5, 6, 7]),
    ];
    const result = concatAudioBuffers(bufs);
    expect(Array.from(result.samples)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('throws on empty input rather than returning a misleading buffer', () => {
    expect(() => concatAudioBuffers([])).toThrow(/at least one buffer/);
  });

  test('throws on sampleRate mismatch (loud failure beats silent corruption)', () => {
    expect(() =>
      concatAudioBuffers([makeBuf([0.1], 24000), makeBuf([0.2], 22050)]),
    ).toThrow(/mismatch/);
  });

  test('throws on channels mismatch', () => {
    expect(() =>
      concatAudioBuffers([makeBuf([0.1], 24000, 1), makeBuf([0.2], 24000, 2)]),
    ).toThrow(/mismatch/);
  });

  test('zero-length buffers are valid (concatenate to empty samples)', () => {
    // After filtering, the engine should have already removed empty
    // buffers, but the helper shouldn't crash if one slips through.
    const a = makeBuf([]);
    const b = makeBuf([0.5]);
    const result = concatAudioBuffers([a, b]);
    expect(Array.from(result.samples)).toEqual([0.5]);
  });
});
