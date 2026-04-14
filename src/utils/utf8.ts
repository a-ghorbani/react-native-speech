/**
 * UTF-8 decoding helper for Hermes.
 *
 * React Native's Hermes engine does not ship the `TextDecoder` global, so
 * this is a hand-rolled UTF-8 byte loop. Handles 1–4 byte sequences;
 * invalid continuation bytes emit U+FFFD (replacement character) rather
 * than throwing, matching the WHATWG decoder's "replacement" error mode.
 */

const REPLACEMENT = 0xfffd;

export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++]!;
    let cp: number;
    let extra: number;

    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      continue;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = b0 & 0x1f;
      extra = 1;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = b0 & 0x0f;
      extra = 2;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp = b0 & 0x07;
      extra = 3;
    } else {
      out += String.fromCharCode(REPLACEMENT);
      continue;
    }

    if (i + extra > bytes.length) {
      out += String.fromCharCode(REPLACEMENT);
      break;
    }

    let valid = true;
    for (let k = 0; k < extra; k++) {
      const bk = bytes[i + k]!;
      if ((bk & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      cp = (cp << 6) | (bk & 0x3f);
    }

    if (!valid) {
      out += String.fromCharCode(REPLACEMENT);
      continue;
    }
    i += extra;

    if (cp <= 0xffff) {
      out += String.fromCharCode(cp);
    } else {
      // Supplementary plane: encode as UTF-16 surrogate pair
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
    }
  }
  return out;
}
