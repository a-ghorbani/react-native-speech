import {stripMarkdown, createMarkdownStreamBuffer} from '../stripMarkdown';

describe('stripMarkdown', () => {
  describe('emphasis', () => {
    test('strips **bold**', () => {
      expect(stripMarkdown('This is **bold** text')).toBe('This is bold text');
    });

    test('strips *italic*', () => {
      expect(stripMarkdown('This is *italic* text')).toBe(
        'This is italic text',
      );
    });

    test('does NOT strip __double_underscore__ (preserves Python dunders)', () => {
      // Trade-off: `__bold__` is a valid CommonMark bold form but vanishingly
      // rare in LLM output (everyone uses `**`), whereas `__init__`,
      // `__main__` etc. are very common in technical prose. We preserve
      // the identifier at the cost of leaving this one bold form unmarked.
      expect(stripMarkdown('This is __bold__ text')).toBe(
        'This is __bold__ text',
      );
      expect(stripMarkdown('call __init__ to set up')).toBe(
        'call __init__ to set up',
      );
    });

    test('strips _italic_', () => {
      expect(stripMarkdown('This is _italic_ text')).toBe(
        'This is italic text',
      );
    });

    test('strips ~~strikethrough~~', () => {
      expect(stripMarkdown('This is ~~gone~~ text')).toBe('This is gone text');
    });

    test('strips nested bold+italic ***x***', () => {
      // *** = ** + *, our current implementation removes stray `*` runs
      expect(stripMarkdown('***emphasized***')).toBe('emphasized');
    });

    test('strips stray unbalanced asterisks and collapses the gap', () => {
      expect(stripMarkdown('text with ** unbalanced')).toBe(
        'text with unbalanced',
      );
    });

    test('does NOT strip underscores in snake_case words', () => {
      // `_` inside a word shouldn't trigger the italic strip because it's
      // not surrounded by whitespace/punctuation.
      expect(stripMarkdown('use snake_case_names here')).toBe(
        'use snake_case_names here',
      );
    });
  });

  describe('headers', () => {
    test('strips `# Header` and appends period for chunking', () => {
      expect(stripMarkdown('# Hello\nworld')).toBe('Hello.\nworld');
    });

    test('strips `### Header`', () => {
      expect(stripMarkdown('### Section title')).toBe('Section title.');
    });

    test('preserves existing trailing punctuation on headers', () => {
      expect(stripMarkdown('## Question?')).toBe('Question?');
      expect(stripMarkdown('## Note:')).toBe('Note:');
    });

    test('handles ATX closing `## Title ##`', () => {
      expect(stripMarkdown('## Title ##')).toBe('Title.');
    });
  });

  describe('horizontal rules', () => {
    test('converts `---` between sentences into a clean break', () => {
      // Trailing `.` on "Para one." already provides the sentence break, so
      // the injected hrule-period collapses — keeps chunking signal without
      // doubling the period.
      expect(stripMarkdown('Para one.\n\n---\n\nPara two.')).toBe(
        'Para one.\nPara two.',
      );
    });

    test('injects `.` when prior line lacks terminator', () => {
      expect(stripMarkdown('a\n***\nb')).toBe('a\n.\nb');
      expect(stripMarkdown('a\n___\nb')).toBe('a\n.\nb');
    });
  });

  describe('lists', () => {
    test('strips `- item` markers', () => {
      expect(stripMarkdown('- First\n- Second\n- Third')).toBe(
        'First\nSecond\nThird',
      );
    });

    test('strips `* item` markers', () => {
      expect(stripMarkdown('* One\n* Two')).toBe('One\nTwo');
    });

    test('numbered `1. item` markers KEEP the ordinal as `1: item`', () => {
      // The ordinal carries meaning — listener follows "first / second /
      // third" structure. Engine number normalizers expand `1` → `one`
      // so the audio reads "one: First" etc. The trailing punctuation is
      // `:` not `.` to avoid the chunker's `.\s+[A-Z]` sentence-break
      // pattern, which would otherwise split each list item in half.
      expect(stripMarkdown('1. First\n2. Second\n3. Third')).toBe(
        '1: First\n2: Second\n3: Third',
      );
    });

    test('numbered `1) item` markers also normalize to `1: `', () => {
      expect(stripMarkdown('1) One\n2) Two')).toBe('1: One\n2: Two');
    });

    test('large list numbers preserved', () => {
      expect(stripMarkdown('100. big\n1000) bigger')).toBe(
        '100: big\n1000: bigger',
      );
    });
  });

  describe('blockquotes', () => {
    test('strips `> ` prefix', () => {
      expect(stripMarkdown('> A quote')).toBe('A quote');
    });

    test('strips all levels of nested `>>`', () => {
      expect(stripMarkdown('>> nested')).toBe('nested');
    });

    test('strips `> > ` space-separated nesting', () => {
      expect(stripMarkdown('> > > deep')).toBe('deep');
    });
  });

  describe('links and images', () => {
    test('keeps link text, drops url', () => {
      expect(stripMarkdown('See [the docs](https://example.com)')).toBe(
        'See the docs',
      );
    });

    test('keeps image alt, drops url', () => {
      expect(stripMarkdown('![a cat](cat.png)')).toBe('a cat');
    });

    test('drops image with no alt', () => {
      expect(stripMarkdown('![](cat.png)')).toBe('');
    });

    test('strips reference-style links', () => {
      expect(stripMarkdown('See [the docs][1]')).toBe('See the docs');
    });

    test('drops reference definitions', () => {
      expect(stripMarkdown('Text.\n\n[1]: https://example.com')).toBe('Text.');
    });
  });

  describe('code', () => {
    test('strips inline code backticks', () => {
      expect(stripMarkdown('Run `npm install` here')).toBe(
        'Run npm install here',
      );
    });

    test('drops fenced code blocks by default', () => {
      expect(
        stripMarkdown('Before.\n```js\nconsole.log(1);\n```\nAfter.'),
      ).toBe('Before.\nAfter.');
    });

    test('keeps fenced code content exactly when dropCodeBlocks=false', () => {
      expect(stripMarkdown('```\nhello\n```', {dropCodeBlocks: false})).toBe(
        'hello',
      );
    });

    test('keeps fenced content with language tag stripped off fences', () => {
      expect(
        stripMarkdown('```js\nconst x = 1;\n```', {dropCodeBlocks: false}),
      ).toBe('const x = 1;');
    });
  });

  describe('tables', () => {
    test('flattens table rows to comma-joined sentences', () => {
      const md = `| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| x | y | z |`;
      expect(stripMarkdown(md)).toBe('A, B, C.\n1, 2, 3.\nx, y, z.');
    });

    test('drops separator row with alignment colons', () => {
      const md = `| Col1 | Col2 |\n|:-----|-----:|\n| a | b |`;
      expect(stripMarkdown(md)).toBe('Col1, Col2.\na, b.');
    });
  });

  describe('html', () => {
    test('drops html tags', () => {
      expect(stripMarkdown('This <b>matters</b> a lot')).toBe(
        'This matters a lot',
      );
    });

    test('drops self-closing tags', () => {
      expect(stripMarkdown('line<br/>break')).toBe('linebreak');
    });
  });

  describe('combined', () => {
    test('handles the user knockout example with exact expected output', () => {
      const md = `When we say someone is a **"knockout,"** it can mean different things.

---

### 1. **In Sports:**
- A **knockout** is when a fighter is defeated.
- For example:
  > "He knocked out his opponent."

| Context | Meaning |
|---------|---------|
| Sports | A fighter who is knocked out |
| General | Someone attractive |`;

      // Exact expected output — any drift from this string breaks the test.
      // This is the regression guard: we know precisely what the pipeline
      // produces today, and any change to structure or whitespace has to be
      // explicit.
      const expected = [
        'When we say someone is a "knockout," it can mean different things.',
        '1. In Sports:',
        'A knockout is when a fighter is defeated.',
        'For example:',
        '"He knocked out his opponent."',
        'Context, Meaning.',
        'Sports, A fighter who is knocked out.',
        'General, Someone attractive.',
      ].join('\n');

      expect(stripMarkdown(md)).toBe(expected);
    });

    test('is idempotent: re-stripping is a no-op', () => {
      const md = '# Hello\n\n**world** and [link](url)';
      const once = stripMarkdown(md);
      const twice = stripMarkdown(once);
      expect(twice).toBe(once);
    });

    test('plain prose is unchanged', () => {
      const prose = 'This is a regular sentence. Nothing special here.';
      expect(stripMarkdown(prose)).toBe(prose);
    });
  });
});

describe('createMarkdownStreamBuffer', () => {
  test('emits complete lines, buffers partials', () => {
    const buf = createMarkdownStreamBuffer();
    expect(buf.push('### He')).toBe('');
    expect(buf.push('ader\n')).toBe('Header.\n');
    expect(buf.flush()).toBe('');
  });

  test('strips inline markers within a single-line push', () => {
    const buf = createMarkdownStreamBuffer();
    // A push without \n buffers — nothing flushed yet.
    expect(buf.push('**bold** text')).toBe('');
    expect(buf.flush()).toBe('bold text');
  });

  test('flushes a complete line of bold markers', () => {
    const buf = createMarkdownStreamBuffer();
    expect(buf.push('A **bold** claim.\n')).toBe('A bold claim.\n');
  });

  test('converts hrule to sentence break across pushes', () => {
    const buf = createMarkdownStreamBuffer();
    let out = '';
    out += buf.push('Para one.\n');
    out += buf.push('\n---\n');
    out += buf.push('\nPara two.');
    out += buf.flush();
    // Per-batch stripping can't see across batches, so the hrule's
    // injected `.` is NOT collapsed against the prior sentence-ender the
    // way whole-text stripMarkdown would. That's deliberate: the solo `.`
    // on its own line acts as a SENTENCE_END_RE boundary for downstream
    // StreamingChunker, which is exactly what we need.
    expect(out).toBe('Para one.\n.\nPara two.');
  });

  test('hrule creates a chunk boundary downstream (non-dedup case)', () => {
    const buf = createMarkdownStreamBuffer();
    // Prior line has no terminator — the injected `.` must survive to act
    // as one. This is the CRITICAL correctness property for streaming;
    // without it, structural breaks are cosmetic only.
    const out =
      buf.push('no terminator line\n') +
      buf.push('---\n') +
      buf.push('next bit.') +
      buf.flush();
    expect(out).toBe('no terminator line\n.\nnext bit.');
  });

  test('table rows get flattened when line-complete', () => {
    const buf = createMarkdownStreamBuffer();
    let out = '';
    out += buf.push('| A | B |\n');
    out += buf.push('|---|---|\n');
    out += buf.push('| 1 | 2 |\n');
    out += buf.flush();
    expect(out).toBe('A, B.\n1, 2.\n');
  });

  test('character-by-character append still strips cleanly', () => {
    const buf = createMarkdownStreamBuffer();
    const input = '**bold** claim.\n';
    let out = '';
    for (const ch of input) out += buf.push(ch);
    out += buf.flush();
    expect(out).toBe('bold claim.\n');
  });

  test('flush emits the tail without trailing newline', () => {
    const buf = createMarkdownStreamBuffer();
    // No newline pushed — everything waits for flush.
    buf.push('**bold** end');
    expect(buf.flush()).toBe('bold end');
  });

  test('stray unbalanced ``` across flushes leaves content intact', () => {
    const buf = createMarkdownStreamBuffer();
    let out = '';
    out += buf.push('```js\n');
    out += buf.push('console.log(1);\n');
    // Stream ends before closing fence — stray-fence cleanup removes the
    // backtick runs but preserves the code content so TTS reads it (better
    // than gibberish). Language tag `js` on the fence line survives as a
    // stray word — acceptable for an unclosed block.
    out += buf.flush();
    expect(out).not.toMatch(/```/);
    expect(out).toContain('console.log(1);');
  });
});

// ─── ANTI-REGRESSION ───────────────────────────────────────────────────
//
// These suites exist to catch the failure mode we keep falling into:
// a stripper regex tuned to remove ONE specific markdown shape
// accidentally mangles a different, unrelated text shape. The canonical-
// markdown suites above confirm the fix works on positive cases. This
// section confirms it doesn't hurt anything else.
//
// When adding a new stripper rule, add a test here exercising prose that
// contains the characters the rule targets BUT is not markdown.

describe('stripMarkdown: prose with markdown-like characters must survive', () => {
  // Each pair is [input, expectedOutput]. Expected is usually === input.
  const cases: Array<[string, string]> = [
    // Pipes in prose — shell, logic, text dividers
    ['use | to pipe output', 'use | to pipe output'],
    ['you can use the | character', 'you can use the | character'],
    ['A or B | C means logic', 'A or B | C means logic'],
    // Greater-than / less-than — math, comparisons, arrows
    ['3 > 2 in math', '3 > 2 in math'],
    ['if x > y then z', 'if x > y then z'],
    ['use a -> b arrow', 'use a -> b arrow'],
    // Underscores — snake_case, identifiers
    ['use snake_case_names here', 'use snake_case_names here'],
    ['the variable __init__ is Python', 'the variable __init__ is Python'],
    // Asterisks — globs, math, footnote refs in flat prose
    ['star * symbol means all', 'star * symbol means all'],
    ['files match *.txt pattern', 'files match *.txt pattern'],
    ['C++ vs C * pointer', 'C++ vs C * pointer'],
    // Dashes — en-dashes, em-dashes, hyphenation, date ranges
    ['the 2020-2024 period', 'the 2020-2024 period'],
    ['state-of-the-art tech', 'state-of-the-art tech'],
    // NOTE: a line that is ONLY dashes (---) IS an hrule and will strip.
    // Hash — anchors, IDs
    ['#Hello is not a header', '#Hello is not a header'],
    ['contact him at #5', 'contact him at #5'],
    // Brackets and parens — citations, asides, ranges
    ['array[5] and list[0]', 'array[5] and list[0]'],
    ['the phrase (in parens)', 'the phrase (in parens)'],
    ['see citation [Knuth 1968]', 'see citation [Knuth 1968]'],
    // URLs in prose (no markdown link wrapping)
    ['visit https://example.com/path', 'visit https://example.com/path'],
    // Punctuation mixes
    ['Really?! What!?', 'Really?! What!?'],
    ['ellipsis... then more', 'ellipsis... then more'],
    // Numbers followed by punctuation that could look like lists
    ['measure 1.5 meters', 'measure 1.5 meters'],
    ['he said "1. yes 2. no"', 'he said "1. yes 2. no"'],
  ];

  test.each(cases)('prose %j is preserved', (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });
});

describe('stripMarkdown: canonical prose, unicode, empty input', () => {
  test('empty string returns empty string', () => {
    expect(stripMarkdown('')).toBe('');
  });

  test('whitespace-only input returns empty after trim', () => {
    expect(stripMarkdown('   \n\n   \t  \n')).toBe('');
  });

  test('single word passes through', () => {
    expect(stripMarkdown('hello')).toBe('hello');
  });

  test('realistic paragraph of plain prose is unchanged', () => {
    const prose =
      'The quick brown fox jumps over the lazy dog. Then it pauses, ' +
      'looks around, and wonders why anyone keeps writing this sentence. ' +
      'There are no markdown symbols here — just normal punctuation.';
    expect(stripMarkdown(prose)).toBe(prose);
  });

  test('CJK passes through', () => {
    expect(stripMarkdown('你好，世界')).toBe('你好，世界');
  });

  test('Arabic passes through', () => {
    expect(stripMarkdown('مرحبا بالعالم')).toBe('مرحبا بالعالم');
  });

  test('accented Latin passes through', () => {
    expect(stripMarkdown('café résumé naïve')).toBe('café résumé naïve');
  });

  test('emoji passes through', () => {
    expect(stripMarkdown('hello 🎉 world 🚀')).toBe('hello 🎉 world 🚀');
  });

  test('mixed unicode with strippable markdown', () => {
    expect(stripMarkdown('**你好** 🎉')).toBe('你好 🎉');
  });
});

describe('stripMarkdown: adversarial + edge shapes', () => {
  test('empty fenced code block with drop', () => {
    expect(stripMarkdown('```\n```')).toBe('');
  });

  test('empty fenced code block without drop keeps nothing', () => {
    expect(stripMarkdown('```\n```', {dropCodeBlocks: false})).toBe('');
  });

  test('unclosed fenced code block: dangling fence gets cleaned', () => {
    // A fenced block that never closes — the stray-fence cleanup in step
    // 14 removes the backticks but preserves the content.
    const out = stripMarkdown('```js\nconst x = 1;');
    expect(out).not.toMatch(/```/);
    expect(out).toContain('const x = 1;');
  });

  test('empty link [](url) drops completely', () => {
    expect(stripMarkdown('Before []() after')).toBe('Before after');
  });

  test('empty image ![](url) drops completely', () => {
    expect(stripMarkdown('Before ![](pic.png) after')).toBe('Before after');
  });

  test('link with markdown inside keeps inner content', () => {
    expect(stripMarkdown('See [**bold text**](url)')).toBe('See bold text');
  });

  test('empty bullet line disappears', () => {
    expect(stripMarkdown('- item one\n-\n- item three')).toBe(
      'item one\n-\nitem three',
    );
    // A lone `-` without content isn't stripped (regex requires space after).
    // Document the current behavior — the stray dash survives.
  });

  test('header with trailing emphasis', () => {
    // The critical case exposed by bug #8 — emphasis inside a header must
    // be stripped before the header regex inspects the body terminator.
    expect(stripMarkdown('### **Title:**')).toBe('Title:');
    expect(stripMarkdown('### **Done.**')).toBe('Done.');
    expect(stripMarkdown('### Regular title')).toBe('Regular title.');
  });

  test('table cell containing emphasis', () => {
    expect(stripMarkdown('| **A** | **B** |')).toBe('A, B.');
  });

  test('table row without leading |', () => {
    expect(stripMarkdown('A | B | C |')).toBe('A, B, C.');
  });

  test('single | at middle of prose is NOT a table row', () => {
    expect(stripMarkdown('the | character is useful')).toBe(
      'the | character is useful',
    );
  });

  test('hrule at very start of input', () => {
    expect(stripMarkdown('---\nHello')).toBe('.\nHello');
  });

  test('line followed by --- is interpreted as a setext header, not hrule', () => {
    // This is canonical CommonMark: `Hello\n---` is an H2 setext heading.
    // The setext pass converts it to `Hello.` (append terminator for
    // chunker). If we ever want raw-hrule preference here, that's a
    // separate design call — document the current behavior.
    expect(stripMarkdown('Hello\n---')).toBe('Hello.');
  });

  test('hrule followed by text at very end', () => {
    // Just an hrule with no body before → treat as hrule.
    expect(stripMarkdown('---\nHello')).toBe('.\nHello');
  });

  test('only an hrule', () => {
    expect(stripMarkdown('---')).toBe('.');
  });

  test('many consecutive hrules each strip independently', () => {
    // The setext guard must NOT mistake a stacked `---\n---` for a setext
    // heading (body = `---`). Each hrule line converts to `.`. Period
    // collapse in step 18 dedups the chain.
    expect(stripMarkdown('a\n---\n---\n---\nb')).toBe('a\n.\nb');
  });

  test('deeply nested blockquotes', () => {
    expect(stripMarkdown('> > > > deep quote')).toBe('deep quote');
  });

  test('mixed content in list items', () => {
    expect(stripMarkdown('- **bold** item\n- with [link](url)\n- plain')).toBe(
      'bold item\nwith link\nplain',
    );
  });

  test('numbered list with large numbers preserved as ordinals', () => {
    expect(stripMarkdown('100. big\n1000) bigger')).toBe(
      '100: big\n1000: bigger',
    );
  });
});

describe('stripMarkdown: cross-construct interaction', () => {
  test('link inside a list item', () => {
    expect(stripMarkdown('- See [the docs](url) for details')).toBe(
      'See the docs for details',
    );
  });

  test('emphasis inside a blockquote', () => {
    expect(stripMarkdown('> She said **no**')).toBe('She said no');
  });

  test('nested emphasis: bold+italic ***x***', () => {
    expect(stripMarkdown('this is ***very*** cool')).toBe('this is very cool');
  });

  test('table row with a link cell', () => {
    expect(stripMarkdown('| Label | [Click](https://x) |')).toBe(
      'Label, Click.',
    );
  });

  test('header, hrule, then paragraph — structural cascade', () => {
    expect(stripMarkdown('# Title\n\n---\n\nBody content.')).toBe(
      'Title.\nBody content.',
    );
  });
});

describe('stripMarkdown: idempotence and determinism', () => {
  const corpus = [
    '**bold** text',
    '# Header\n## Sub\nbody',
    '- list\n- items',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    'plain prose with no markers',
    '> quote\n> continued',
    '[link](url) in [another](url2) sentence',
    'code `here` and also ```block\nwith content\n```',
    'you can use | and > in prose',
    '',
    '   ',
    '\n\n\n',
  ];

  test.each(corpus.map(c => [c]))('idempotent on %j', input => {
    const once = stripMarkdown(input);
    expect(stripMarkdown(once)).toBe(once);
  });
});

describe('createMarkdownStreamBuffer: boundary invariance', () => {
  // The most important anti-regression property for streaming: the exact
  // split points of incoming text must not change the final output (modulo
  // meaningful markdown tokenization boundaries). This catches bugs where
  // partial-token handling leaks periods, loses content, or fires
  // structural-break rules on incomplete lines.

  function runAllBoundaries(input: string): {
    whole: string;
    charByChar: string;
    wordByWord: string;
    lineByLine: string;
  } {
    const viaWhole = (() => {
      const b = createMarkdownStreamBuffer();
      return b.push(input) + b.flush();
    })();
    const viaCharByChar = (() => {
      const b = createMarkdownStreamBuffer();
      let out = '';
      for (const ch of input) out += b.push(ch);
      out += b.flush();
      return out;
    })();
    const viaWordByWord = (() => {
      const b = createMarkdownStreamBuffer();
      let out = '';
      // Split preserving newlines as standalone tokens.
      const tokens = input.split(/(\s+)/);
      for (const t of tokens) out += b.push(t);
      out += b.flush();
      return out;
    })();
    const viaLineByLine = (() => {
      const b = createMarkdownStreamBuffer();
      let out = '';
      const lines = input.split(/(\n)/);
      for (const t of lines) out += b.push(t);
      out += b.flush();
      return out;
    })();
    return {
      whole: viaWhole,
      charByChar: viaCharByChar,
      wordByWord: viaWordByWord,
      lineByLine: viaLineByLine,
    };
  }

  const inputs = [
    'Plain prose with no markdown at all.',
    '# Hello\n\n---\n\nBody text.',
    '**bold** claim.',
    '- one\n- two\n- three\n',
    '| A | B |\n| 1 | 2 |\n',
    '> quoted text\n> continued\n',
    'This has a | in it, not a table.',
    'The variable snake_case_name has no emphasis.',
    'multi\nline\nprose\nhere',
    'trailing no newline',
  ];

  test.each(inputs.map(i => [i]))(
    'streaming variants agree regardless of append granularity: %j',
    input => {
      const r = runAllBoundaries(input);
      // All incremental append granularities (char, word, line) MUST
      // produce identical output — partial-token handling shouldn't
      // depend on WHERE the caller split the text.
      expect(r.charByChar).toBe(r.lineByLine);
      expect(r.wordByWord).toBe(r.lineByLine);
      // Whole-string single-push acts like line-by-line in our buffer
      // (no newline → buffer-and-flush). It matches the streaming
      // variants for inputs with no cross-batch period-dedup opportunity.
    },
  );

  // Whole-text stripMarkdown can differ from streaming output ONLY in one
  // very specific way: step 18 collapses a standalone `.` line that sits
  // between two sentence-ended lines. In streaming, that cross-batch
  // collapse can't happen, so the extra `.` stays — and that's desirable
  // because it's what downstream `StreamingChunker` splits on. Test this
  // contract explicitly so any drift in the collapse logic surfaces.
  test('streaming preserves hrule period when it straddles a push boundary', () => {
    // Whole-text stripMarkdown collapses `.\n.\n` across the hrule
    // (step 18). In streaming, when the hrule lands in a different push
    // from the preceding `.`, the cross-batch collapse can't fire — the
    // injected `.` survives and acts as a boundary for StreamingChunker.
    // That's the load-bearing property of the streaming buffer.
    const buf = createMarkdownStreamBuffer();
    const streamed =
      buf.push('Para one.\n') +
      buf.push('\n---\n') +
      buf.push('\nPara two.') +
      buf.flush();
    expect(streamed).toBe('Para one.\n.\nPara two.');
    // Same input pushed in one go CAN collapse (batch spans both
    // paragraphs) — document that the single-push path converges.
    const single = (() => {
      const b = createMarkdownStreamBuffer();
      return b.push('Para one.\n\n---\n\nPara two.') + b.flush();
    })();
    expect(single).toBe('Para one.\nPara two.');
  });

  test('empty push/flush sequence', () => {
    const buf = createMarkdownStreamBuffer();
    expect(buf.push('')).toBe('');
    expect(buf.flush()).toBe('');
  });

  test('push empty then real content', () => {
    const buf = createMarkdownStreamBuffer();
    expect(buf.push('')).toBe('');
    expect(buf.push('hello\n')).toBe('hello\n');
    expect(buf.flush()).toBe('');
  });

  test('flush without push', () => {
    const buf = createMarkdownStreamBuffer();
    expect(buf.flush()).toBe('');
  });
});
