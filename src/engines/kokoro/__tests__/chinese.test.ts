import {
  chineseToKokoroPhonemes,
  numbersToChinese,
  pinyinSyllableToIpa,
} from '../chinese';
import fixtures from './fixtures/chinese-phonemes.json';

const noOther = async (t: string) => `<${t}>`;

describe('Mandarin → Kokoro v1.0 phonemes', () => {
  // Fixtures: the spike's converter output on FLORES-200 sentences, which
  // Whisper large-v3 read back at CER 0.097 vs misaki's 0.092 (#14).
  test.each(fixtures.map(f => [f.text, f.phonemes]))(
    '%s',
    async (text, phonemes) => {
      expect(await chineseToKokoroPhonemes(text, noOther)).toBe(phonemes);
    },
  );

  test.each([
    ['zhong1', 'ꭧʊ→ŋ'],
    ['wen2', 'wə↗n'],
    ['lv4', 'ly↘'],
    ['shi4', 'ʂɨ↘'],
    ['zi3', 'ʦɨ↓'],
    ['de5', 'tɤ'],
    ['er2', 'ɚ↗'],
    ['xue2', 'ɕɥe↗'],
    ['yo1', 'jɔ→'],
  ])('syllable %s → %s', (py, ipa) => {
    expect(pinyinSyllableToIpa(py)).toBe(ipa);
  });

  test.each([
    ['2013年', '二零一三年'],
    ['1,000元', '一千元'],
    ['第１２章', '第十二章'],
    ['1990年代', '一九九零年代'],
    ['10', '十'],
    ['3.5', '三点五'],
    ['40%', '百分之四十'],
    ['100000', '十万'],
  ])('number %s → %s', (input, output) => {
    expect(numbersToChinese(input)).toBe(output);
  });

  test('Latin runs go to the other-script phonemizer, Chinese does not', async () => {
    const seen: string[] = [];
    const out = await chineseToKokoroPhonemes('我用 iPhone 拍照。', async t => {
      seen.push(t);
      return 'AIFOWN';
    });
    expect(seen).toEqual(['iPhone']);
    expect(out).toContain('AIFOWN');
    expect(out).not.toMatch(/[一-鿿]/);
  });
});
