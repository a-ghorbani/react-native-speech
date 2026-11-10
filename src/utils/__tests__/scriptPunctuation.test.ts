import {TextChunker} from '../TextChunker';
import {findFirstClauseEnd} from '../firstClause';
import {stripMarkdown, createMarkdownStreamBuffer} from '../stripMarkdown';
import {StreamingChunker} from '../../engines/StreamingChunker';
import {
  splitInHalves,
  splitOversizedSource,
} from '../../engines/kitten/splitOversized';
import {TextNormalizer} from '../../engines/kokoro/TextNormalizer';

const HI = 'यह पहला वाक्य है। यह दूसरा वाक्य है। यह तीसरा है।';
const AR = 'هل أنت هنا اليوم؟ نعم أنا هنا الآن. شكرا لك.';
const ZH = '今天天气很好。我们去公园散步吧！你觉得怎么样？';
const ZH_RUN = '我们'.repeat(150); // 300 CJK chars, no punctuation, no spaces

function drain(chunker: StreamingChunker): string[] {
  const out: string[] = [];
  let c = chunker.tryPeek();
  while (c) {
    out.push(c.text);
    c = chunker.tryPeek();
  }
  return out;
}

describe('sentence ends in non-Latin scripts', () => {
  test.each([
    [
      'Devanagari danda',
      HI,
      20,
      ['यह पहला वाक्य है।', 'यह दूसरा वाक्य है।', 'यह तीसरा है।'],
    ],
    [
      'Arabic question mark',
      AR,
      20,
      ['هل أنت هنا اليوم؟', 'نعم أنا هنا الآن.', 'شكرا لك.'],
    ],
    ['CJK', ZH, 10, ['今天天气很好。', '我们去公园散步吧！', '你觉得怎么样？']],
  ])('TextChunker splits at the %s', (_name, text, max, expected) => {
    const chunks = TextChunker.chunkBySentences(text as string, max as number);
    expect(chunks.map(c => c.text)).toEqual(expected);
    for (const c of chunks) {
      expect((text as string).slice(c.startIndex, c.endIndex)).toBe(c.text);
    }
  });

  test('Kokoro TextNormalizer splits Chinese at 。！？', () => {
    const chunks = new TextNormalizer().chunkBySentences(ZH, 10);
    expect(chunks).toEqual([
      '今天天气很好。',
      '我们去公园散步吧！',
      '你觉得怎么样？',
    ]);
  });

  test.each([
    ['Hindi', 'यह पहला वाक्य है। ', 'यह पहला वाक्य है। '],
    ['Arabic', 'هل أنت هنا اليوم؟ ', 'هل أنت هنا اليوم؟ '],
  ])(
    'StreamingChunker releases a %s sentence as soon as it ends',
    (_n, input, first) => {
      const chunker = new StreamingChunker(200);
      chunker.append(input + 'और');
      expect(drain(chunker)).toEqual([first]);
    },
  );

  test('the markdown stream buffer emits a Hindi sentence at the danda', () => {
    const buf = createMarkdownStreamBuffer();
    expect(buf.push('यह पहला वाक्य है। यह')).toBe('यह पहला वाक्य है। ');
  });

  test('the markdown stream buffer emits a Chinese sentence at 。 with no space after it', () => {
    const buf = createMarkdownStreamBuffer();
    expect(buf.push('今天天气很好。我们')).toBe('今天天气很好。 ');
  });

  test.each([
    ['# 标题。', '标题。'],
    ['# शीर्षक।', 'शीर्षक।'],
    ['# عنوان؟', 'عنوان؟'],
  ])(
    'a markdown header that already ends a sentence gets no extra period: %s',
    (md, out) => {
      expect(stripMarkdown(md)).toBe(out);
    },
  );
});

describe('clause marks in non-Latin scripts', () => {
  test('the first-clause cut uses the Arabic comma', () => {
    const text = 'ذهبنا إلى السوق صباحا، ثم عدنا إلى البيت';
    expect(text.slice(0, findFirstClauseEnd(text))).toBe(
      'ذهبنا إلى السوق صباحا، ',
    );
  });
});

describe('text without spaces or punctuation', () => {
  test('StreamingChunker cuts a long CJK run at maxChunkSize instead of holding it', () => {
    const chunker = new StreamingChunker(200);
    chunker.append(ZH_RUN);
    const out = drain(chunker);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.length).toBeLessThanOrEqual(200);
    chunker.finalize();
    expect([...out, ...drain(chunker)].join('')).toBe(ZH_RUN);
  });

  test('the markdown stream buffer releases a long CJK run with no punctuation', () => {
    const buf = createMarkdownStreamBuffer();
    const out = buf.push(ZH_RUN);
    expect(out.length).toBeGreaterThan(0);
    expect(out.trim() + buf.flush()).toBe(ZH_RUN);
  });

  test('splitInHalves splits a long CJK run instead of returning it whole', () => {
    const pieces = splitInHalves(ZH_RUN);
    expect(pieces.length).toBe(2);
    expect(pieces.join('')).toBe(ZH_RUN);
  });

  test('splitInHalves splits Chinese at 。', () => {
    expect(splitInHalves(ZH)).toHaveLength(2);
  });

  test('splitOversizedSource splits Hindi at the danda', () => {
    expect(splitOversizedSource(HI)).toEqual([
      'यह पहला वाक्य है।',
      'यह दूसरा वाक्य है।',
      'यह तीसरा है।',
    ]);
  });
});
