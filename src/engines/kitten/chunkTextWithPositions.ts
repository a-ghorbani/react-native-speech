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
  const boundary = /[.!?]+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    pushSentence(text, cursor, end, maxLen, out);
    cursor = end;
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
