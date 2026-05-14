/**
 * Canonical test sentence per Supertonic-supported language.
 *
 * Each sentence is short (~15-40 chars), uses natural orthography, and
 * roughly translates to "The weather is nice today" — pragmatic choice
 * for ASR round-trip because:
 *   - common vocabulary in every Whisper-large training set
 *   - no proper nouns or acronyms that could trip pronunciation
 *   - similar length keeps timing comparable across languages
 *
 * Used by `scripts/verify-supertonic-multilingual.ts`.
 */
export const TEST_SENTENCES: Record<string, string> = {
  en: 'The weather is nice today.',
  ko: '오늘 날씨가 정말 좋네요.',
  ja: '今日はいい天気ですね。',
  ar: 'اليوم الطقس جميل.',
  bg: 'Днес времето е хубаво.',
  cs: 'Dnes je hezké počasí.',
  da: 'Vejret er godt i dag.',
  de: 'Das Wetter ist heute schön.',
  el: 'Ο καιρός είναι ωραίος σήμερα.',
  es: 'El tiempo está bueno hoy.',
  et: 'Ilm on täna ilus.',
  fi: 'Sää on tänään mukava.',
  fr: "Il fait beau aujourd'hui.",
  hi: 'आज मौसम बहुत अच्छा है।',
  hr: 'Vrijeme je danas lijepo.',
  hu: 'Ma szép az idő.',
  id: 'Hari ini cuacanya bagus.',
  it: 'Il tempo è bello oggi.',
  lt: 'Šiandien gražus oras.',
  lv: 'Šodien ir jauks laiks.',
  nl: 'Het weer is mooi vandaag.',
  pl: 'Dziś jest ładna pogoda.',
  pt: 'O tempo está bom hoje.',
  ro: 'Vremea este frumoasă astăzi.',
  ru: 'Сегодня хорошая погода.',
  sk: 'Dnes je pekné počasie.',
  sl: 'Danes je lepo vreme.',
  sv: 'Vädret är fint idag.',
  tr: 'Bugün hava güzel.',
  uk: 'Сьогодні гарна погода.',
  vi: 'Hôm nay thời tiết đẹp.',
};

export const ALL_LANGS = Object.keys(TEST_SENTENCES);
