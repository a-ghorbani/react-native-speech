import {ensurePunctuation} from '../../phonemization/KittenPreprocessor';

/**
 * Split text into per-sentence chunks, preserving original-text positions
 * for ChunkProgressEvent so HighlightedText stays in sync with the input.
 * Matches the behavior of the upstream kittentts chunker (split on .!? and
 * ensure trailing punctuation), but tracks the start/end of each sentence
 * within the unmodified input string. Oversize sentences fall back to
 * whitespace splitting, still in original-text space.
 */
export function chunkTextWithPositions(
  text: string,
  maxLen: number,
): Array<{text: string; startIndex: number; endIndex: number}> {
  const out: Array<{text: string; startIndex: number; endIndex: number}> = [];
  // Only treat .!? as a sentence boundary when followed by whitespace + an
  // uppercase letter (new sentence) or end-of-string. Avoids splitting on
  // decimals like "0.76", currency like "$1.50", and abbreviations like
  // "Mr. Smith" (when lowercase) — matches TextNormalizer's smart pattern.
  // The boundary pattern consumes trailing whitespace so we advance the
  // cursor past it; but we end the CHUNK at the punctuation itself so
  // highlight ranges don't extend into the inter-sentence space.
  const boundary = /([.!?]+)(?:\s+(?=[A-Z])|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const chunkEnd = match.index + match[1]!.length;
    const advanceTo = match.index + match[0].length;
    pushSentence(text, cursor, chunkEnd, maxLen, out);
    cursor = advanceTo;
  }
  if (cursor < text.length) {
    pushSentence(text, cursor, text.length, maxLen, out);
  }
  return out;
}

function pushSentence(
  src: string,
  start: number,
  end: number,
  maxLen: number,
  out: Array<{text: string; startIndex: number; endIndex: number}>,
): void {
  let s = start;
  while (s < end && /\s/.test(src[s]!)) s++;
  if (s >= end) return;
  const raw = src.slice(s, end).trimEnd();
  if (!raw) return;

  if (raw.length <= maxLen) {
    out.push({text: ensurePunctuation(raw), startIndex: s, endIndex: end});
    return;
  }

  let wordStart = s;
  let bufferStart = s;
  let buffer = '';
  for (let i = s; i <= end; i++) {
    const atEnd = i === end;
    const isSpace = !atEnd && /\s/.test(src[i]!);
    if (isSpace || atEnd) {
      const word = src.slice(wordStart, i);
      if (word) {
        const candidate = buffer ? buffer + ' ' + word : word;
        if (candidate.length > maxLen && buffer) {
          out.push({
            text: ensurePunctuation(buffer),
            startIndex: bufferStart,
            endIndex: wordStart - 1,
          });
          buffer = word;
          bufferStart = wordStart;
        } else {
          buffer = candidate;
          if (!buffer || buffer === word) bufferStart = wordStart;
        }
      }
      if (!atEnd) wordStart = i + 1;
    }
  }
  if (buffer) {
    out.push({
      text: ensurePunctuation(buffer),
      startIndex: bufferStart,
      endIndex: end,
    });
  }
}
