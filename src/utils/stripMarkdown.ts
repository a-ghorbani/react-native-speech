/**
 * Strip markdown formatting so the output reads cleanly through a TTS
 * phonemizer that only knows prose.
 *
 * Design goals:
 *   - Remove inline markers (`**`, `*`, `_`, `~~`, backticks) — content stays.
 *   - Turn block-level structure (headers, horizontal rules, list items,
 *     blockquotes, table rows) into plain sentences separated by `.` so the
 *     downstream sentence chunker (`[.!?]+` splitter) picks up natural
 *     breaks. Without this, an entire markdown section lands in one chunk
 *     with no pauses and garbled symbol pronunciations.
 *   - Drop link URLs, keep link text. Same for images (alt text only).
 *   - Drop fenced + inline code wrapping; keep the content. Code pronounced
 *     as prose is imperfect but better than literal backticks.
 *
 * This runs BEFORE the engine's existing text normalization / chunking so
 * the chunker benefits from the structural breaks we inject.
 *
 * Not a CommonMark parser — regex-based, pragmatic. Handles the shapes LLMs
 * actually emit. Order of operations matters: fenced code first (so its
 * contents aren't mis-parsed), then block structure, then inline.
 */

/**
 * Options for markdown stripping. All default to sensible TTS behavior.
 */
export interface StripMarkdownOptions {
  /**
   * If true (default), fenced code blocks (``` ... ```) are dropped
   * entirely. If false, their contents are kept (fences removed). Most
   * code is unreadable out loud, so dropping is usually better.
   */
  dropCodeBlocks?: boolean;
}

const DEFAULTS: Required<StripMarkdownOptions> = {
  dropCodeBlocks: true,
};

/**
 * Strip markdown syntax from text, producing TTS-friendly prose.
 *
 * Idempotent: re-applying to already-stripped text is a no-op (no markdown
 * tokens to strip).
 */
export function stripMarkdown(
  text: string,
  options: StripMarkdownOptions = {},
): string {
  const opts = {...DEFAULTS, ...options};
  let out = text;

  // 1. Fenced code blocks — handle first so their contents don't get parsed
  // as markdown. Match ```lang\n...\n``` and ~~~lang\n...\n~~~ variants.
  out = out.replace(
    /^```[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm,
    (_m, code: string) => (opts.dropCodeBlocks ? '' : code),
  );
  out = out.replace(
    /^~~~[^\n]*\n([\s\S]*?)\n~~~[ \t]*$/gm,
    (_m, code: string) => (opts.dropCodeBlocks ? '' : code),
  );

  // 2. Images: ![alt](url) → alt (or empty if no alt). Drop the URL.
  // Keep this before links since the syntax is a superset.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 3. Links: [text](url) → text. Drop URL.
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 4. Reference-style links: [text][ref] → text
  out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  // And drop reference definitions: `[ref]: url`
  out = out.replace(/^\s*\[[^\]]+\]:\s+\S.*$/gm, '');

  // 5. HTML tags — drop. Kitten's preprocessor already does this but we
  // unify so Kokoro gets it too.
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // 6. Table rows — flatten `| a | b | c |` to "a, b, c." with a sentence
  // break. Must run before we strip stray pipes elsewhere. We require the
  // line to START or END with `|` (possibly after whitespace) — a lone
  // mid-sentence pipe like "use | to pipe output" is NOT a table row and
  // must stay intact.
  //
  // 6a. Drop separator rows first: `|---|---|` (optionally with alignment
  // colons `|:---:|`). Require at least two dashes so we don't eat real
  // content that happens to contain a single hyphen between pipes. Require
  // a leading/trailing `|` for the same reason.
  out = out.replace(
    /^[ \t]*\|[\s:|-]*-{2,}[\s:|-]*\|?[ \t]*$|^[ \t]*\|?[\s:|-]*-{2,}[\s:|-]*\|[ \t]*$/gm,
    '',
  );
  // 6b. Convert data/header rows to comma-joined sentences. The line must
  // (a) start with `|` and have another `|`, or (b) end with `|` and have
  // another `|`. This keeps prose sentences with a stray single pipe
  // untouched ("use | to pipe output" stays verbatim).
  out = out.replace(
    /^[ \t]*\|(.+\|.*)[ \t]*$|^[ \t]*(.*\|.+)\|[ \t]*$/gm,
    (_line, leading?: string, trailing?: string) => {
      const inner = leading ?? trailing ?? '';
      const cells = inner
        .split('|')
        .map(c => c.trim())
        .filter(c => c.length > 0);
      if (cells.length < 2) return _line;
      return cells.join(', ') + '.';
    },
  );

  // 7. Emphasis markers: strip `**`, `__`, `*`, `_`, `~~` around text.
  // MUST run before headers + lists — otherwise a header like
  // `### **Title:**` ends with `**`, header regex doesn't detect the `:`
  // terminator, and a stray `.` gets injected → `Title:.`
  //
  // All emphasis patterns require delimiter-adjacency to whitespace,
  // punctuation, or string edges. This keeps intraword underscores
  // (snake_case, Python dunders like `__init__`) and stray asterisks in
  // prose (`*.txt`, `C * pointer`) from getting chewed.
  const emphasisPre = '(^|[\\s({\\[])';
  const emphasisPost = '(?=[\\s.,;:!?)}\\]]|$)';
  out = out.replace(
    new RegExp(`${emphasisPre}\\*\\*([^*\\n]+?)\\*\\*${emphasisPost}`, 'g'),
    '$1$2',
  );
  // Note: no `__...__` pass. Python dunders (`__init__`, `__main__`) show
  // up in technical prose often enough that preserving them matters more
  // than handling the rare CommonMark `__bold__` form — almost everyone
  // uses `**` for bold. If an LLM emits `__foo__` it'll pass through
  // intact; that's a better failure mode than destroying identifiers.
  out = out.replace(
    new RegExp(`${emphasisPre}~~([^~\\n]+?)~~${emphasisPost}`, 'g'),
    '$1$2',
  );
  out = out.replace(
    new RegExp(`${emphasisPre}\\*([^*\\n]+?)\\*${emphasisPost}`, 'g'),
    '$1$2',
  );
  out = out.replace(
    new RegExp(`${emphasisPre}_([^_\\n]+?)_${emphasisPost}`, 'g'),
    '$1$2',
  );

  // 8. List markers.
  //   - Bullets `-`/`*`/`+` at line start: strip entirely (no spoken form).
  //   - Numbered `1.`/`1)` at line start: KEEP the ordinal, replace the
  //     trailing punctuation with `:` so engines read "one: item one"
  //     instead of dropping the number. Using `:` instead of the original
  //     `.` matters because the downstream sentence chunkers treat
  //     `.\s+[A-Z]` as a sentence boundary; that would split every list
  //     item into two chunks ("one." | "Item one.") with a long pause
  //     between them. `:` is a softer prosody pause and not a chunker
  //     boundary.
  //
  // Run BEFORE headers so a numbered-body header (`### 1. Title`) doesn't
  // get its `1.` stripped once headers peel off the `###` prefix.
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  out = out.replace(/^[ \t]*(\d+)[.)][ \t]+/gm, '$1: ');

  // 9. Headers `#{1,6} text` → `text.` so the sentence chunker breaks here.
  // Strip optional trailing `#` (ATX closing syntax).
  out = out.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_m, body) => {
    const trimmed = (body as string).replace(/\s+$/, '');
    return /[.!?:]$/.test(trimmed) ? trimmed : trimmed + '.';
  });

  // 8. Setext-style headers: underline with `===` or `---` on the next line.
  // Replace `---` / `===` underline with a period-ending line (handled by
  // hrule pass below for stray `---`). Convert inline setext to period.
  out = out.replace(/^(.+)\n[=]{2,}[ \t]*$/gm, (_m, body) => {
    const trimmed = (body as string).trim();
    return /[.!?:]$/.test(trimmed) ? trimmed : trimmed + '.';
  });
  // Require that the `---` underline is NOT immediately followed by another
  // `---` line — cascaded dashes are multiple hrules, not "setext heading
  // with a dashes title". The negative lookahead prevents the FIRST body
  // from being eaten as a heading when what follows is actually more
  // hrules.
  out = out.replace(
    /^(.+)\n[-]{2,}[ \t]*$(?!\n[ \t]*[-]{2,})/gm,
    (_m, body) => {
      const trimmed = (body as string).trim();
      if (!trimmed) return _m;
      if (/^[-*_ \t]+$/.test(trimmed)) return _m;
      return /[.!?:]$/.test(trimmed) ? trimmed : trimmed + '.';
    },
  );

  // 9. Horizontal rules — `---`, `***`, `___` on their own line → `.`
  // (inject a sentence break so the chunker splits here).
  out = out.replace(/^[ \t]*(?:[-*_][ \t]*){3,}[ \t]*$/gm, '.');

  // 10. Blockquotes: strip leading `>` and any run of them for nested
  // quotes (`>>`, `> > `, etc.) in a single pass.
  out = out.replace(/^[ \t]*(?:>[ \t]?)+/gm, '');

  // 13. Inline code: `x` → x. Triple-backtick inline is rare but handle
  // it before single-backtick so the triple pattern wins.
  out = out.replace(/```([^`\n]+)```/g, '$1');
  out = out.replace(/``([^`\n]+)``/g, '$1');
  out = out.replace(/`([^`\n]+)`/g, '$1');

  // 14. Clean up any stray leftover runs of the markers we just processed
  // that didn't form a matched pair (LLMs often emit unbalanced `**`, and
  // streaming buffers can flush across a fence line that never found its
  // closer this pass). ONLY strip runs of 2+ so single `*` in prose
  // (`C * pointer`, `*.txt`) survives — a lone `*` that was supposed to
  // open emphasis without a closer is rare, and stripping it would
  // destroy legitimate content far more often.
  out = out.replace(/\*{2,}/g, '');
  out = out.replace(/~{2,}/g, '');
  out = out.replace(/`{3,}/g, '');

  // 15. Backslash-escapes: `\*` → `*`. Strip the escape; since we removed
  // the markers above, literal `\*` becomes `*` which then gets cleaned up.
  // Handle common escapes only — don't touch e.g. `\n` in prose.
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');

  // 16. Collapse runs of blank lines to a single newline (helps the
  // downstream chunker treat paragraphs cleanly).
  out = out.replace(/\n{2,}/g, '\n');

  // 17. Trim trailing whitespace on each line AND collapse runs of spaces
  // within a line. Stripping `![](url)` or stray `**` mid-sentence otherwise
  // leaves a double space ("Before  after") that pins brittle assertions.
  // Single spaces and newlines are preserved; tabs collapse too.
  out = out
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''))
    .join('\n');

  // 18. Collapse redundant `.` lines left behind by hrule/header rules:
  //   - when the preceding line already ended with a terminator, drop the
  //     extra `.` (keep the separating `\n` so paragraphs don't glue).
  //   - when multiple hrules stack (each having been converted to its own
  //     `.` line), fold the run into a single `.` line.
  out = out.replace(/([.!?:])[ \t]*\n\.(?=[ \t]*(?:\n|$))/g, '$1');
  out = out.replace(/\.[ \t]*\n(?:\.[ \t]*\n)+/g, '.\n');

  return out.trim();
}

/**
 * Line-buffered markdown stripper for streaming input.
 *
 * Engines' streaming paths hand text to `StreamingChunker` which splits on
 * `[.!?]+\s+` — so inline markers (`**`, backticks, pipes) survived the
 * chunker in the pre-fix baseline, and structural markers (`---`, `###`)
 * never produced chunk breaks because the chunker didn't recognize them.
 *
 * This buffer solves both: callers push incremental text via `push()`,
 * which flushes complete lines through `stripMarkdown` and returns the
 * cleaned text (with a trailing `\n` preserved so the chunker's `.!?\s`
 * boundary still fires). Partial lines stay buffered. `flush()` strips
 * and emits whatever's left, for end-of-stream.
 *
 * Processing per-line instead of per-append avoids partial-token bugs:
 * `"### Hea"` alone would otherwise get a period injected mid-word once
 * the header regex sees an end-of-string. By waiting for the closing
 * `\n`, we only strip truly complete lines.
 *
 * Fenced code blocks that span multiple lines are the one edge case —
 * opening fence in one flush, closing in another — handled by the stray
 * `` ``` `` cleanup in `stripMarkdown` step 14 so leftover fence markers
 * don't leak into phonemes.
 */
export interface MarkdownStreamBuffer {
  push(text: string): string;
  flush(): string;
}

export function createMarkdownStreamBuffer(
  options: StripMarkdownOptions = {},
): MarkdownStreamBuffer {
  let buffer = '';
  return {
    push(text: string): string {
      buffer += text;
      const lastNl = buffer.lastIndexOf('\n');
      if (lastNl === -1) return '';
      const complete = buffer.slice(0, lastNl + 1);
      buffer = buffer.slice(lastNl + 1);
      const stripped = stripMarkdown(complete, options);
      // Reattach a trailing newline so `StreamingChunker`'s SENTENCE_END_RE
      // (which requires whitespace after `.!?`) can still find boundaries.
      // `stripMarkdown` ends with `.trim()` and would otherwise glue this
      // batch's last char to the next batch's first.
      return stripped ? stripped + '\n' : '';
    },
    flush(): string {
      if (!buffer) return '';
      const out = stripMarkdown(buffer, options);
      buffer = '';
      return out;
    },
  };
}
