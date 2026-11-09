import {StreamingChunker, findFirstClauseEnd} from '../StreamingChunker';
import {createMarkdownStreamBuffer} from '../../utils/stripMarkdown';

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('StreamingChunker', () => {
  test('yields a chunk once a sentence boundary appears', async () => {
    const chunker = new StreamingChunker();
    chunker.append('Hello world. ');
    const chunk = await chunker.getNextChunk();
    expect(chunk).not.toBeNull();
    expect(chunk!.text).toBe('Hello world. ');
    expect(chunk!.startIndex).toBe(0);
    expect(chunk!.endIndex).toBe(13);
  });

  test('does not split after a non-terminal abbreviation', async () => {
    const chunker = new StreamingChunker();
    chunker.append('Ask Dr. Smith, e.g. today. Then go. ');
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('Ask Dr. Smith, e.g. today. Then go. ');
  });

  test('abbreviation periods become boundaries once past maxChunkSize', async () => {
    const chunker = new StreamingChunker(40);
    chunker.append(
      'Ask Dr. Smith and Dr. Jones and Dr. Brown and Dr. Lee and ',
    );
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text.length).toBeLessThanOrEqual(40);
    expect(chunk!.text).toMatch(/Dr\. $/);
  });

  test('blocks until a sentence boundary arrives', async () => {
    const chunker = new StreamingChunker();
    chunker.append('Hello');

    let resolved = false;
    const chunkPromise = chunker.getNextChunk().then(c => {
      resolved = true;
      return c;
    });

    await flushMicrotasks();
    expect(resolved).toBe(false);

    chunker.append(' world. ');
    const chunk = await chunkPromise;
    expect(resolved).toBe(true);
    expect(chunk!.text).toBe('Hello world. ');
  });

  test('groups multiple sentences up to maxChunkSize', async () => {
    const chunker = new StreamingChunker(100);
    chunker.append('One. Two. Three. ');
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('One. Two. Three. ');
  });

  test('splits when buffer exceeds maxChunkSize', async () => {
    const chunker = new StreamingChunker(15);
    chunker.append('Short. Longer sentence here. ');

    const chunk1 = await chunker.getNextChunk();
    expect(chunk1!.text).toBe('Short. ');
    expect(chunk1!.startIndex).toBe(0);

    const chunk2 = await chunker.getNextChunk();
    expect(chunk2!.text).toBe('Longer sentence here. ');
    expect(chunk2!.startIndex).toBe(7);
  });

  test('finalize drains remaining text without sentence boundary', async () => {
    const chunker = new StreamingChunker();
    chunker.append('no sentence end');
    chunker.finalize();
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('no sentence end');
    expect(chunk!.startIndex).toBe(0);
    expect(chunk!.endIndex).toBe(15);

    const done = await chunker.getNextChunk();
    expect(done).toBeNull();
  });

  test('finalize with nothing buffered returns null immediately', async () => {
    const chunker = new StreamingChunker();
    chunker.finalize();
    const chunk = await chunker.getNextChunk();
    expect(chunk).toBeNull();
  });

  test('cancel resolves blocked getNextChunk with null', async () => {
    const chunker = new StreamingChunker();
    chunker.append('waiting');

    const chunkPromise = chunker.getNextChunk();
    chunker.cancel();

    const chunk = await chunkPromise;
    expect(chunk).toBeNull();
  });

  test('append after finalize is ignored', async () => {
    const chunker = new StreamingChunker();
    chunker.append('Hello. ');
    chunker.finalize();
    chunker.append('Should be ignored. ');

    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('Hello. ');

    const done = await chunker.getNextChunk();
    expect(done).toBeNull();
  });

  test('absolute offsets are monotonically increasing across chunks', async () => {
    const chunker = new StreamingChunker(20);
    chunker.append('First. Second. Third. ');
    chunker.finalize();

    const chunks = [];
    let chunk = await chunker.getNextChunk();
    while (chunk) {
      chunks.push(chunk);
      chunk = await chunker.getNextChunk();
    }

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startIndex).toBe(chunks[i - 1]!.endIndex);
    }
  });

  test('CJK: flushes on 。 without trailing whitespace', async () => {
    const chunker = new StreamingChunker();
    chunker.append('你好。');
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('你好。');
  });

  test('CJK: mixed ASCII and CJK punctuation', async () => {
    const chunker = new StreamingChunker(100);
    chunker.append('Hello! 你好。再見。');
    const chunk = await chunker.getNextChunk();
    expect(chunk!.text).toBe('Hello! 你好。再見。');
  });

  test('totalAppended tracks cumulative input size', async () => {
    const chunker = new StreamingChunker();
    expect(chunker.totalAppended).toBe(0);
    chunker.append('Hello. ');
    expect(chunker.totalAppended).toBe(7);
    await chunker.getNextChunk();
    expect(chunker.totalAppended).toBe(7);
    chunker.append('World. ');
    expect(chunker.totalAppended).toBe(14);
  });

  test('tryPeek returns undefined when waiting, null when done', async () => {
    const chunker = new StreamingChunker();
    expect(chunker.tryPeek()).toBeUndefined();

    chunker.append('Hello. ');
    const peeked = chunker.tryPeek();
    expect(peeked).not.toBeNull();
    expect(peeked).not.toBeUndefined();
    expect(peeked!.text).toBe('Hello. ');

    chunker.finalize();
    await chunker.getNextChunk();
    expect(chunker.tryPeek()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Integration: MarkdownStreamBuffer → StreamingChunker
//
// The bug pattern: an isolated horizontal-rule line (`---`) flows through
// `createMarkdownStreamBuffer`, which converts it to `.\n` and emits as a
// complete-line batch. When that batch lands in StreamingChunker between
// other content, it can be the ENTIRE buffer at the moment of extraction
// — so the chunker emits a 2-char `.\n` chunk by itself. Engines like
// Kitten that don't tolerate trivial inputs then crash.
//
// These tests pin the contract that no-content chunks ARE produced under
// realistic interleaving, so downstream consumers (engines, sessions)
// must be designed to skip them rather than assume every chunk has
// synthesizable content.
// ─────────────────────────────────────────────────────────────────────────
describe('integration: MarkdownStreamBuffer → StreamingChunker', () => {
  function hasContent(text: string): boolean {
    return /[\p{L}\p{N}]/u.test(text);
  }

  /**
   * Drive the stream the same way realistic consumers do: append small
   * fragments, drain whatever's ready after each. This reproduces the
   * "engine consumes chunks faster than tokens arrive" race that surfaces
   * the no-content chunk.
   */
  async function streamThrough(
    text: string,
    fragmenter: (s: string) => string[],
    maxChunkSize = 500,
  ) {
    const chunker = new StreamingChunker(maxChunkSize);
    const buf = createMarkdownStreamBuffer();
    const chunks: Array<{text: string; startIndex: number; endIndex: number}> =
      [];
    for (const frag of fragmenter(text)) {
      const emit = buf.push(frag);
      if (emit) chunker.append(emit);
      let ready = chunker.tryPeek();
      while (ready !== undefined && ready !== null) {
        chunks.push(ready);
        ready = chunker.tryPeek();
      }
    }
    const tail = buf.flush();
    if (tail) chunker.append(tail);
    chunker.finalize();
    let final = chunker.tryPeek();
    while (final !== undefined && final !== null) {
      chunks.push(final);
      final = chunker.tryPeek();
    }
    return chunks;
  }

  test('isolated --- between paragraphs yields a no-content chunk under interleaved drain', async () => {
    const chunks = await streamThrough(
      'Hello world. This is paragraph one.\n\n---\n\nThis is paragraph two.',
      // Word-by-word — what `tokenize(text)` in StreamingView produces.
      s => s.match(/\S+\s*|\s+/g) ?? [s],
    );

    // We expect at least one chunk to be the bare `.\n` from the stripped
    // hrule. If this test starts to fail, either the stripper changed how
    // it represents structural breaks (then update the engine guards to
    // match), or the chunker started filtering — either way, downstream
    // assumptions need to be revisited.
    const noContent = chunks.filter(c => !hasContent(c.text));
    expect(noContent.length).toBeGreaterThan(0);
    expect(noContent.every(c => c.text.length <= 4)).toBe(true);

    // Surrounding content survives intact.
    const joined = chunks.map(c => c.text).join('');
    expect(joined).toContain('Hello world.');
    expect(joined).toContain('This is paragraph two.');
  });

  test('full markdown sample: chunker emits zero, one, or many no-content chunks', async () => {
    // The full StreamingView sample (procrastination guide) — a robust
    // test that the integration produces SOME chunks worth synthesizing
    // and any no-content artifacts are short.
    const sample = `# Title

A paragraph.

---

## Section

Another paragraph.

---

### Sub

| A | B |
|---|---|
| 1 | 2 |

End.`;
    const chunks = await streamThrough(
      sample,
      s => s.match(/\S+\s*|\s+/g) ?? [s],
    );

    expect(chunks.length).toBeGreaterThan(0);
    // Every no-content chunk must be tiny — if a large chunk has no
    // letters/digits, something is upstream-mangled and we shouldn't
    // hand it to a TTS model regardless.
    for (const c of chunks) {
      if (!hasContent(c.text)) {
        expect(c.text.length).toBeLessThanOrEqual(4);
      }
    }
    // At least one content-bearing chunk landed.
    expect(chunks.some(c => hasContent(c.text))).toBe(true);
  });

  test('stripping disabled: hrule flows through verbatim and triggers a different chunk pattern', async () => {
    // Sanity check: when consumers opt out of stripping (`stripMarkdown:
    // false`), they DON'T get a `.\n` chunk because the hrule never gets
    // converted. They get the raw `---` text instead. This confirms the
    // no-content chunk is specifically a stripping artifact.
    const chunker = new StreamingChunker(500);
    const tokens = 'Hello.\n\n---\n\nWorld.'.match(/\S+\s*|\s+/g) ?? [];
    for (const t of tokens) chunker.append(t);
    chunker.finalize();
    const chunks: string[] = [];
    let c;
    while ((c = await chunker.getNextChunk()) !== null) {
      chunks.push(c.text);
    }
    const joined = chunks.join('');
    expect(joined).toContain('---');
    // No `.\n`-only chunk in the unstripped path.
    expect(chunks.every(t => /[\p{L}\p{N}-]/u.test(t))).toBe(true);
  });
});

describe('findFirstClauseEnd', () => {
  test('does not end the first clause at an abbreviation', () => {
    const text = 'Dr. Smith and Mr. Jones agreed, so we went. ';
    expect(text.slice(0, findFirstClauseEnd(text))).toBe(
      'Dr. Smith and Mr. Jones agreed, ',
    );
    expect(findFirstClauseEnd('Ask Dr. ')).toBe(-1);
  });

  test('returns -1 when no boundary has arrived', () => {
    expect(findFirstClauseEnd('Well, I think')).toBe(-1);
  });

  test('ignores clause marks before the minimum word count', () => {
    expect(findFirstClauseEnd('Well, yes, ')).toBe(-1);
  });

  test('ends at the first clause mark after 3 words', () => {
    const text = 'Sure thing friend, here it is. ';
    expect(text.slice(0, findFirstClauseEnd(text))).toBe('Sure thing friend, ');
  });

  test('prefers an earlier sentence end', () => {
    const text = 'Hi. Then more words, here. ';
    expect(text.slice(0, findFirstClauseEnd(text))).toBe('Hi. ');
  });

  test('caps at 12 complete words without punctuation', () => {
    const words = Array.from({length: 14}, (_, i) => `w${i}`).join(' ') + ' ';
    const end = findFirstClauseEnd(words);
    expect(words.slice(0, end).trim().split(/\s+/)).toHaveLength(12);
  });

  test('CJK clause marks use a character minimum', () => {
    const zh = '我觉得，这个方案很好，但是还需要改进';
    expect(zh.slice(0, findFirstClauseEnd(zh))).toBe('我觉得，这个方案很好，');
    const ja = '今日は、とても良い天気ですね、本当に';
    expect(ja.slice(0, findFirstClauseEnd(ja))).toBe(
      '今日は、とても良い天気ですね、',
    );
    expect(findFirstClauseEnd('我，你')).toBe(-1);
  });

  test('punctuation-only tokens do not count as words', () => {
    expect(findFirstClauseEnd('   , , , one two')).toBe(-1);
    const text = '   , , , one two three, four';
    expect(text.slice(0, findFirstClauseEnd(text))).toBe(
      '   , , , one two three, ',
    );
    expect(findFirstClauseEnd('one two — three')).toBe(-1);
  });

  test('accepts em dash, semicolon and colon', () => {
    for (const mark of ['—', ';', ':']) {
      const text = `one two three${mark} four. `;
      expect(text.slice(0, findFirstClauseEnd(text))).toBe(
        `one two three${mark} `,
      );
    }
  });
});

// The two first sentences from the field report: 19 and 16 words, no comma
// after >= 3 words, so the default 12-word cap splits them mid-sentence.
const REPORTED = [
  'Did you read the Anthropic article saying small models like us could spread into toasters and smart TVs? ',
  "Oh no, the house is now a giant graveyard and I'm so scared we'll be stuck. ",
];

describe('findFirstClauseEnd maxWords', () => {
  test('default cuts the reported sentences at word 12', () => {
    const [a, b] = REPORTED as [string, string];
    expect(a.slice(0, findFirstClauseEnd(a))).toBe(
      'Did you read the Anthropic article saying small models like us could ',
    );
    expect(b.slice(0, findFirstClauseEnd(b))).toBe(
      "Oh no, the house is now a giant graveyard and I'm so ",
    );
  });

  test.each(REPORTED)('a limit of 25 keeps %j whole', text => {
    expect(findFirstClauseEnd(text, 25)).toBe(text.length);
  });

  test('cuts at the given word count without a natural break', () => {
    const text = 'one two three four five six seven. ';
    expect(text.slice(0, findFirstClauseEnd(text, 5))).toBe(
      'one two three four five ',
    );
  });

  test('a natural break within the limit still ends the chunk early', () => {
    const comma = 'Sure thing friend, here it is and more words follow. ';
    expect(comma.slice(0, findFirstClauseEnd(comma, 25))).toBe(
      'Sure thing friend, ',
    );
    const sentence = 'Hi there. Then a much longer second sentence. ';
    expect(sentence.slice(0, findFirstClauseEnd(sentence, 25))).toBe(
      'Hi there. ',
    );
  });
});

async function drain(chunker: StreamingChunker): Promise<string[]> {
  const out: string[] = [];
  let c;
  while ((c = await chunker.getNextChunk()) !== null) out.push(c.text);
  return out;
}

describe('StreamingChunker firstChunkMaxWords', () => {
  const tokens = (t: string) => t.match(/\S+\s*/g) ?? [];

  test.each(REPORTED)(
    'a limit of 25 streams %j as one first chunk',
    async sentence => {
      const chunker = new StreamingChunker(400, 'clause', 25);
      const pending = chunker.getNextChunk();
      for (const tok of tokens(sentence + 'Next one. ')) chunker.append(tok);
      expect((await pending)!.text).toBe(sentence);
    },
  );

  test('the default still cuts at word 12', async () => {
    const chunker = new StreamingChunker(400, 'clause');
    for (const tok of tokens(REPORTED[0]!)) chunker.append(tok);
    chunker.finalize();
    expect((await drain(chunker))[0]).toBe(
      'Did you read the Anthropic article saying small models like us could ',
    );
  });

  test.each([0, -1, 2.5, NaN])('rejects a limit of %p', value => {
    expect(() => new StreamingChunker(400, 'clause', value)).toThrow(
      `firstChunkMaxWords must be a positive integer (got ${value})`,
    );
  });

  test('the limit is ignored in sentence mode', async () => {
    const chunker = new StreamingChunker(400, 'sentence', 3);
    chunker.append('one two three four five');
    expect(chunker.tryPeek()).toBeUndefined();
  });

  test.each(REPORTED)(
    'markdown buffer + chunker with a limit of 25 keep %j whole',
    async sentence => {
      const md = createMarkdownStreamBuffer({
        firstChunk: 'clause',
        firstChunkMaxWords: 25,
      });
      const chunker = new StreamingChunker(400, 'clause', 25);
      for (const tok of tokens(sentence + 'Next one.')) {
        chunker.append(md.push(tok));
      }
      chunker.append(md.flush());
      chunker.finalize();
      expect((await drain(chunker))[0]!.trim()).toBe(sentence.trim());
    },
  );
});

describe("StreamingChunker firstChunk: 'clause'", () => {
  const text = 'Sure thing friend, here it is, and more. Second sentence, ok. ';

  test('default mode waits for the sentence end', async () => {
    const chunker = new StreamingChunker();
    chunker.append('Sure thing friend, here it is');
    expect(chunker.tryPeek()).toBeUndefined();
  });

  test('first chunk flushes at a clause, later chunks at sentences', async () => {
    const chunker = new StreamingChunker(400, 'clause');
    chunker.append(text);
    chunker.finalize();

    const c1 = await chunker.getNextChunk();
    expect(c1!.text).toBe('Sure thing friend, ');
    expect(c1!.startIndex).toBe(0);
    expect(c1!.endIndex).toBe(19);

    const c2 = await chunker.getNextChunk();
    expect(c2!.text).toBe('here it is, and more. Second sentence, ok. ');
    expect(c2!.startIndex).toBe(19);
    expect(c2!.endIndex).toBe(text.length);

    expect(await chunker.getNextChunk()).toBeNull();
  });

  test('wakes a blocked consumer as soon as the clause arrives', async () => {
    const chunker = new StreamingChunker(400, 'clause');
    const pending = chunker.getNextChunk();
    chunker.append('Sure thing');
    await flushMicrotasks();
    chunker.append(' friend, here');
    const chunk = await pending;
    expect(chunk!.text).toBe('Sure thing friend, ');
  });

  test('a finalized remainder counts as the first chunk', async () => {
    const chunker = new StreamingChunker(400, 'clause');
    chunker.append('Hi');
    chunker.finalize();
    expect((await chunker.getNextChunk())!.text).toBe('Hi');
    expect(await chunker.getNextChunk()).toBeNull();
  });

  test('markdown buffer + chunker keep the early first clause', async () => {
    const md = createMarkdownStreamBuffer({firstChunk: 'clause'});
    const chunker = new StreamingChunker(400, 'clause');
    chunker.append(md.push('Sure thing friend, here it is'));
    const first = chunker.tryPeek();
    expect(first).toBeTruthy();
    expect((first as {text: string}).text).toBe('Sure thing friend, ');
  });
});

// #48: a reply with commas but no sentence end ("count to forty").
const ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];
const TEENS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty'];
const numberWord = (n: number) =>
  n < 10
    ? ONES[n]!
    : n < 20
      ? TEENS[n - 10]!
      : TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : '');
const COUNT = Array.from({length: 40}, (_, i) => numberWord(i + 1)).join(', ');

/** Append `text` in `size`-char pieces, draining ready chunks after each; then finalize. */
function streamInPieces(chunker: StreamingChunker, text: string, size: number) {
  const open: TextChunkLike[] = [];
  const afterFinalize: TextChunkLike[] = [];
  const take = (into: TextChunkLike[]) => {
    let c = chunker.tryPeek();
    while (c) {
      into.push(c);
      c = chunker.tryPeek();
    }
  };
  for (let i = 0; i < text.length; i += size) {
    chunker.append(text.slice(i, i + size));
    take(open);
  }
  chunker.finalize();
  take(afterFinalize);
  return {open, afterFinalize, all: [...open, ...afterFinalize]};
}
type TextChunkLike = {text: string; startIndex: number; endIndex: number};

function expectContiguous(chunks: TextChunkLike[], text: string) {
  expect(chunks.map(c => c.text).join('')).toBe(text);
  let at = 0;
  for (const c of chunks) {
    expect(c.startIndex).toBe(at);
    at = c.endIndex;
  }
}

describe('StreamingChunker: text without a sentence end (#48)', () => {
  test('the count text is the reported ~400 chars', () => {
    expect(COUNT.length).toBe(399);
  });

  test.each(['clause', 'sentence'] as const)(
    'firstChunk %s: comma text is cut at clauses while the stream is open',
    mode => {
      const {open, afterFinalize, all} = streamInPieces(
        new StreamingChunker(200, mode),
        COUNT,
        6,
      );
      expectContiguous(all, COUNT);
      // Less than one chunk's worth waits for finalize.
      const heldBack = afterFinalize.reduce((n, c) => n + c.text.length, 0);
      expect(heldBack).toBeLessThan(200);
      expect(open.length).toBeGreaterThanOrEqual(mode === 'clause' ? 2 : 1);
      for (const c of all) expect(c.text.length).toBeLessThanOrEqual(200);
      // Cuts land after a comma.
      for (const c of open) expect(c.text).toMatch(/, $/);
    },
  );

  test('the first clause chunk is unchanged', () => {
    const {all} = streamInPieces(new StreamingChunker(200, 'clause'), COUNT, 6);
    expect(all[0]!.text).toBe('one, two, three, ');
  });

  test('bulk comma text is split at clauses within maxChunkSize', () => {
    const text = `${COUNT}, ${COUNT}, ${COUNT}`;
    const {all} = streamInPieces(new StreamingChunker(200), text, text.length);
    expectContiguous(all, text);
    for (const c of all) expect(c.text.length).toBeLessThanOrEqual(200);
    for (const c of all.slice(0, -1)) {
      expect(c.text.length).toBeGreaterThan(150);
    }
    for (const c of all.slice(0, -1)) expect(c.text).toMatch(/, $/);
  });

  test('a multi-word clause is kept whole rather than cut at a word', () => {
    const text = 'and then we counted the sheep very slowly, '.repeat(12);
    const {open, all} = streamInPieces(new StreamingChunker(200), text, 6);
    expectContiguous(all, text);
    expect(open.length).toBeGreaterThan(0);
    for (const c of open) expect(c.text).toMatch(/slowly, $/);
  });

  test('text with no punctuation at all is cut at a word within maxChunkSize', () => {
    const text = COUNT.replace(/,/g, '').repeat(2);
    const {open, all} = streamInPieces(new StreamingChunker(200), text, 6);
    expectContiguous(all, text);
    expect(open.length).toBeGreaterThanOrEqual(2);
    for (const c of all) expect(c.text.length).toBeLessThanOrEqual(200);
    for (const c of open) expect(c.text).toMatch(/\S $/);
  });

  test('CJK clause marks also cut a long run', () => {
    const text = '我们今天去公园散步，'.repeat(30);
    const {open, all} = streamInPieces(new StreamingChunker(200), text, 5);
    expectContiguous(all, text);
    expect(open.length).toBeGreaterThan(0);
    for (const c of open) expect(c.text).toMatch(/，$/);
  });

  test('a sentence end still decides the cut when one is present', () => {
    const text = `${COUNT.slice(0, 150)}. Then the rest, and more. `;
    const chunker = new StreamingChunker(200);
    chunker.append(text);
    expect(chunker.tryPeek()!.text).toBe(text);
  });

  test('comma text shorter than maxChunkSize waits for more input', () => {
    const chunker = new StreamingChunker(200);
    chunker.append(COUNT.slice(0, COUNT.lastIndexOf(', ', 190) + 2));
    expect(chunker.tryPeek()).toBeUndefined();
  });

  test('markdown buffer releases comma text to the chunker while open', () => {
    const md = createMarkdownStreamBuffer();
    let emitted = '';
    for (let i = 0; i < COUNT.length; i += 6)
      emitted += md.push(COUNT.slice(i, i + 6));
    expect(COUNT.length - emitted.length).toBeLessThan(100);
    expect((emitted + md.flush()).replace(/\s+/g, ' ').trim()).toBe(COUNT);
  });
});
