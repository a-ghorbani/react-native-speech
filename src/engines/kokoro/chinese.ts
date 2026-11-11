/**
 * Mandarin text → Kokoro v1.0 phonemes.
 *
 * Pinyin comes from `pinyin-pro` (an optional peer dependency, loaded only
 * through the `@pocketpalai/react-native-speech/zh` entry). Each syllable is
 * mapped to the IPA-with-tone-arrows format the Kokoro v1.0 model was trained
 * on, ported from misaki's `transcription.py` (Apache-2.0), which adapts
 * stefantaubert/pinyin-to-ipa (MIT). Digits are read as Chinese numbers, and
 * runs of other text (Latin words) go to `phonemizeOther`.
 */
import {pinyin} from 'pinyin-pro';

const DIGITS = '零一二三四五六七八九';

function fourDigitsToChinese(q: string): string {
  const units = ['', '十', '百', '千'];
  const trimmed = q.replace(/^0+/, '');
  let out = '';
  let zero = false;
  for (let i = 0; i < trimmed.length; i++) {
    const d = Number(trimmed[i]);
    if (d === 0) {
      zero = true;
      continue;
    }
    if (zero && out) out += '零';
    zero = false;
    out += DIGITS[d]! + units[trimmed.length - 1 - i]!;
  }
  return out;
}

function integerToChinese(digits: string): string {
  const s = digits.replace(/^0+(?=\d)/, '');
  if (s === '0') return '零';
  if (s.length > 12) return [...s].map(c => DIGITS[Number(c)]).join('');
  const groups: string[] = [];
  for (let end = s.length; end > 0; end -= 4) {
    groups.unshift(s.slice(Math.max(0, end - 4), end));
  }
  const big = ['', '万', '亿'];
  let out = '';
  groups.forEach((group, i) => {
    const part = fourDigitsToChinese(group);
    if (!part) return;
    if (out && group[0] === '0') out += '零';
    out += part + big[groups.length - 1 - i];
  });
  return out.startsWith('一十') ? out.slice(1) : out;
}

/**
 * Digits → Chinese numerals: 3.5 → 三点五, 40% → 百分之四十, 1,000 → 一千; a
 * four-digit year is read digit by digit (2013年 → 二零一三年). Full-width
 * digits count as digits.
 */
export function numbersToChinese(text: string): string {
  return text
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/\d{4}(?=年)/g, (y, at: number, all: string) =>
      // 5000年 is a quantity (five thousand years); 2000年1月, 2000年代 are dates.
      /^[1-9]000$/.test(y) &&
      !/^年(?:代|\d|[一二三四五六七八九十]+月)/.test(all.slice(at + 4))
        ? y
        : [...y].map(c => DIGITS[Number(c)]).join(''),
    )
    .replace(/(\d+(?:\.\d+)?)%/g, (_m, n: string) => '百分之' + n)
    .replace(/\d+(?:\.\d+)?/g, m => {
      const [int, frac] = m.split('.');
      return (
        integerToChinese(int!) +
        (frac ? '点' + [...frac].map(c => DIGITS[Number(c)]).join('') : '')
      );
    });
}

const PUNCT: Record<string, string> = {
  '、': ', ',
  '，': ', ',
  '。': '. ',
  '．': '. ',
  '！': '! ',
  '：': ': ',
  '；': '; ',
  '？': '? ',
  '«': ' “',
  '»': '” ',
  '《': ' “',
  '》': '” ',
  '「': ' “',
  '」': '” ',
  '【': ' “',
  '】': '” ',
  '（': ' (',
  '）': ') ',
};

const INITIALS = [
  'zh',
  'ch',
  'sh',
  'b',
  'p',
  'm',
  'f',
  'd',
  't',
  'n',
  'l',
  'g',
  'k',
  'h',
  'j',
  'q',
  'x',
  'r',
  'z',
  'c',
  's',
];
const INITIAL_IPA: Record<string, string> = {
  b: 'p',
  c: 'ʦʰ',
  ch: 'ꭧʰ',
  d: 't',
  f: 'f',
  g: 'k',
  h: 'x',
  j: 'ʨ',
  k: 'kʰ',
  l: 'l',
  m: 'm',
  n: 'n',
  p: 'pʰ',
  q: 'ʨʰ',
  r: 'ɻ',
  s: 's',
  sh: 'ʂ',
  t: 'tʰ',
  x: 'ɕ',
  z: 'ʦ',
  zh: 'ꭧ',
};
// `0` marks where the tone arrow goes.
const FINAL_IPA: Record<string, string> = {
  a: 'a0',
  ai: 'ai0',
  an: 'a0n',
  ang: 'a0ŋ',
  ao: 'au0',
  e: 'ɤ0',
  ei: 'ei0',
  en: 'ə0n',
  eng: 'ə0ŋ',
  i: 'i0',
  ia: 'ja0',
  ian: 'jɛ0n',
  iang: 'ja0ŋ',
  iao: 'jau0',
  ie: 'je0',
  in: 'i0n',
  iou: 'jou0',
  ing: 'i0ŋ',
  iong: 'jʊ0ŋ',
  ong: 'ʊ0ŋ',
  ou: 'ou0',
  u: 'u0',
  uei: 'wei0',
  ua: 'wa0',
  uai: 'wai0',
  uan: 'wa0n',
  uen: 'wə0n',
  uang: 'wa0ŋ',
  ueng: 'wə0ŋ',
  uo: 'wo0',
  o: 'wo0',
  ü: 'y0',
  üe: 'ɥe0',
  üan: 'ɥɛ0n',
  ün: 'y0n',
};
const WHOLE_SYLLABLE_IPA: Record<string, string> = {
  m: 'm0',
  n: 'n0',
  ng: 'ŋ0',
  hm: 'hm0',
  hng: 'hŋ0',
  er: 'ɚ0',
  o: 'ɔ0',
  ê: 'ɛ0',
  io: 'jɔ0',
};
const TONE_ARROW = ['', '→', '↗', '↓', '↘', ''];
const RETROFLEX_OR_SIBILANT = ['zh', 'ch', 'sh', 'r', 'z', 'c', 's'];

/** One numbered-tone pinyin syllable (`zhong1`, `lv4`, `de5`) → Kokoro v1.0 IPA. */
export function pinyinSyllableToIpa(syllable: string): string {
  const m = /^([a-züv]+)([0-5])?$/.exec(syllable);
  if (!m) return syllable;
  const tone = Number(m[2] ?? 5) || 5;
  const py = m[1]!.replace(/v/g, 'ü');
  let ipa: string | undefined = WHOLE_SYLLABLE_IPA[py];
  if (ipa === undefined) {
    let initial = '';
    let final = py;
    if (py[0] === 'y') {
      const rest = py.slice(1);
      final =
        rest[0] === 'i'
          ? rest
          : rest[0] === 'u'
            ? 'ü' + rest.slice(1)
            : 'i' + rest;
    } else if (py[0] === 'w') {
      const rest = py.slice(1);
      final = rest === 'u' ? 'u' : 'u' + rest;
    } else {
      initial =
        INITIALS.find(i => py.startsWith(i) && py.length > i.length) ?? '';
      final = py.slice(initial.length);
      if ('jqx'.includes(initial) && initial && final[0] === 'u') {
        final = 'ü' + final.slice(1);
      }
    }
    final =
      ({iu: 'iou', ui: 'uei', un: 'uen', ue: 'üe'} as Record<string, string>)[
        final
      ] ?? final;
    if (final === 'io')
      return WHOLE_SYLLABLE_IPA.io!.replace('0', TONE_ARROW[tone]!); // 哟 yo
    let finalIpa = FINAL_IPA[final];
    if (final === 'i' && RETROFLEX_OR_SIBILANT.includes(initial))
      finalIpa = 'ɨ0';
    if (finalIpa === undefined) return '';
    ipa = (INITIAL_IPA[initial] ?? '') + finalIpa;
  }
  return ipa.replace('0', TONE_ARROW[tone]!);
}

const HAN_RUN_RE = /[㐀-鿿]+/g;
const HAS_LETTER_RE = /\p{L}/u;

/**
 * Mandarin text (may contain digits, punctuation and Latin words) → one
 * Kokoro v1.0 phoneme string. `phonemizeOther` phonemizes the non-Chinese
 * runs (the English path).
 */
export async function chineseToKokoroPhonemes(
  text: string,
  phonemizeOther: (text: string) => Promise<string>,
): Promise<string> {
  let prepared = numbersToChinese(text);
  for (const [k, v] of Object.entries(PUNCT)) {
    prepared = prepared.split(k).join(v);
  }
  const parts: string[] = [];
  let last = 0;
  const pushOther = async (other: string) => {
    if (HAS_LETTER_RE.test(other)) {
      parts.push(await phonemizeOther(other.trim()));
    } else if (other.trim()) {
      parts.push(other.trim());
    }
  };
  for (const m of prepared.matchAll(HAN_RUN_RE)) {
    await pushOther(prepared.slice(last, m.index));
    // pinyin-pro applies 一/不 tone sandhi; misaki's v1.0 path did not.
    const syllables = pinyin(m[0], {toneType: 'num', type: 'array', v: true});
    parts.push(syllables.map(pinyinSyllableToIpa).join(''));
    last = m.index! + m[0].length;
  }
  await pushOther(prepared.slice(last));
  return parts
    .join(' ')
    .replace(/ +/g, ' ')
    .replace(/ ([,.!?;:)”])/g, '$1')
    .trim();
}
