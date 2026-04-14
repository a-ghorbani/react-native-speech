import {decodeUtf8} from '../utf8';

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe('decodeUtf8', () => {
  it('decodes ASCII', () => {
    expect(decodeUtf8(bytes(0x68, 0x69))).toBe('hi');
    expect(decodeUtf8(bytes())).toBe('');
  });

  it('decodes 2-byte sequences (Latin-1 supplement)', () => {
    // U+00E9 (é) = 0xC3 0xA9
    expect(decodeUtf8(bytes(0xc3, 0xa9))).toBe('é');
  });

  it('decodes 3-byte sequences (BMP)', () => {
    // IPA primary stress U+02C8 = 0xCB 0x88
    expect(decodeUtf8(bytes(0xcb, 0x88))).toBe('\u02c8');
    // CJK: 日 U+65E5 = 0xE6 0x97 0xA5
    expect(decodeUtf8(bytes(0xe6, 0x97, 0xa5))).toBe('日');
  });

  it('decodes 4-byte sequences (supplementary plane, surrogate pair)', () => {
    // 😀 U+1F600 = 0xF0 0x9F 0x98 0x80
    expect(decodeUtf8(bytes(0xf0, 0x9f, 0x98, 0x80))).toBe('😀');
  });

  it('replaces invalid lead bytes with U+FFFD', () => {
    expect(decodeUtf8(bytes(0xff, 0x41))).toBe('\ufffdA');
  });

  it('replaces truncated sequences with U+FFFD', () => {
    expect(decodeUtf8(bytes(0xc3))).toBe('\ufffd');
    expect(decodeUtf8(bytes(0xe6, 0x97))).toBe('\ufffd');
  });

  it('replaces invalid continuation bytes with U+FFFD and retries the lead byte', () => {
    // 0xC3 (2-byte lead) followed by non-continuation 0x41 ('A'):
    // matches WHATWG behavior — emit U+FFFD, then retry 0x41 as a fresh lead.
    expect(decodeUtf8(bytes(0xc3, 0x41))).toBe('\ufffdA');
  });

  it('handles voice-id-shaped ASCII', () => {
    // Matches the real Kokoro voice-id format: af_bella
    expect(
      decodeUtf8(bytes(0x61, 0x66, 0x5f, 0x62, 0x65, 0x6c, 0x6c, 0x61)),
    ).toBe('af_bella');
  });
});
