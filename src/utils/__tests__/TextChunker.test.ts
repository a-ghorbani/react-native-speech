import {TextChunker} from '../TextChunker';

describe('TextChunker.chunkBySentences', () => {
  it('keeps the space between sentences grouped into one chunk', () => {
    expect(TextChunker.chunkBySentences('One here. Two here.', 250)).toEqual([
      {text: 'One here. Two here.', startIndex: 0, endIndex: 19},
    ]);
    expect(
      TextChunker.chunkBySentences(
        'Well, as I said before, this is it. The end.',
        250,
      )[0]!.text,
    ).toBe('Well, as I said before, this is it. The end.');
  });

  it('keeps the original separator (newlines, multiple spaces)', () => {
    expect(
      TextChunker.chunkBySentences('First line.\nSecond!  Third?', 250)[0]!
        .text,
    ).toBe('First line.\nSecond!  Third?');
  });

  const cases: [string, number][] = [
    ['One here. Two here.', 250],
    ['  Leading space. And trailing.   ', 250],
    ['First sentence here. Second one now. Third and last.', 25],
    ['A. B! C? D... E', 4],
    ['No punctuation at all', 5],
    ['Ends without stop. Then more text', 20],
    ['Line one.\n\nLine two.\nLine three. ', 12],
    ['Way too long single sentence that exceeds the limit. Short.', 10],
  ];

  it.each(cases)(
    'chunk.text equals text.slice(startIndex, endIndex): %j / %d',
    (text, max) => {
      const chunks = TextChunker.chunkBySentences(text, max);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.text).toBe(text.slice(chunk.startIndex, chunk.endIndex));
        expect(chunk.text).toBe(chunk.text.trim());
      }
      // Chunks are ordered and every non-space character is covered once.
      expect(
        chunks
          .map(c => c.text)
          .join(' ')
          .replace(/\s+/g, ''),
      ).toBe(text.replace(/\s+/g, ''));
    },
  );

  it('still splits at maxChunkSize on sentence boundaries', () => {
    expect(
      TextChunker.chunkBySentences(
        'First sentence here. Second one now. Third and last.',
        25,
      ).map(c => c.text),
    ).toEqual(['First sentence here.', 'Second one now.', 'Third and last.']);
  });
});
