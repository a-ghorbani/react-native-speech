import {isAbbreviationPeriod} from '../abbreviations';
import {chunkTextWithPositions} from '../../engines/kitten/chunkTextWithPositions';
import {TextNormalizer} from '../../engines/kokoro/TextNormalizer';

const dot = (t: string, before: string) =>
  isAbbreviationPeriod(t, t.indexOf(before) + before.length);

describe('isAbbreviationPeriod', () => {
  test.each([
    ['Dr. Smith', 'Dr'],
    ['Ask Mrs. Jones', 'Mrs'],
    ['Use one, e.g. Python', 'e.g'],
    ['cats vs. Dogs', 'vs'],
    ['John F. Kennedy', 'F'],
  ])('%s is non-terminal', (t, before) => {
    expect(dot(t, before)).toBe(true);
  });

  test.each([
    ['It works. Then', 'works'],
    ['So do I. Then', 'I'],
    ['and so on, etc. Next', 'etc'],
    ['Wait... Then', 'Wait'],
  ])('%s is a sentence end', (t, before) => {
    expect(dot(t, before)).toBe(false);
  });
});

describe('chunkers keep abbreviations inside a sentence', () => {
  const text = 'Dr. Smith met Mr. Jones. They talked.';

  test('Kitten chunkTextWithPositions', () => {
    expect(chunkTextWithPositions(text, 200).map(c => c.text)).toEqual([
      'Dr. Smith met Mr. Jones.',
      'They talked.',
    ]);
  });

  test('Kokoro chunkBySentencesWithMetadata', () => {
    expect(
      new TextNormalizer()
        .chunkBySentencesWithMetadata(text, 30)
        .map(c => c.text),
    ).toEqual(['Dr. Smith met Mr. Jones.', 'They talked.']);
  });
});
