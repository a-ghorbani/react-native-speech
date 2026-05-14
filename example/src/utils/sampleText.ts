/**
 * Demo text per language for the Supertonic v3 picker.
 *
 * Two sentences in each language — short enough to keep the demo
 * responsive (~3-5 seconds of audio), long enough to hear voice
 * timbre and prosody, and roughly parallel content across languages
 * so they're comparable. Used by RootView to auto-swap the speak text
 * when the user changes the Supertonic language picker.
 *
 * The English entry is the canonical app demo paragraph (longer than
 * the others — it doubles as the marketing copy on first launch).
 */

export const ENGLISH_DEFAULT_TEXT =
  'Welcome! This is a quick demo of on-device neural text-to-speech. ' +
  'Everything you hear is synthesized locally — no internet, no cloud ' +
  'API, just the model running on your phone. Switch voices above to ' +
  'hear the difference.';

export const SAMPLE_TEXT: Record<string, string> = {
  en: ENGLISH_DEFAULT_TEXT,
  ko: '오늘 날씨가 정말 좋네요. 좋은 하루 보내세요.',
  ja: '今日はいい天気ですね。良い一日をお過ごしください。',
  ar: 'اليوم الطقس جميل. أتمنى لك يوماً سعيداً.',
  bg: 'Днес времето е хубаво. Желая ви прекрасен ден.',
  cs: 'Dnes je hezké počasí. Přeji vám krásný den.',
  da: 'Vejret er godt i dag. Hav en dejlig dag.',
  de: 'Das Wetter ist heute schön. Einen schönen Tag noch.',
  el: 'Ο καιρός είναι ωραίος σήμερα. Να έχετε μια υπέροχη μέρα.',
  es: 'El tiempo está bueno hoy. Que tengas un buen día.',
  et: 'Ilm on täna ilus. Mõnusat päeva!',
  fi: 'Sää on tänään mukava. Mukavaa päivää!',
  fr: "Il fait beau aujourd'hui. Passez une bonne journée.",
  hi: 'आज मौसम बहुत अच्छा है। आपका दिन शुभ हो।',
  hr: 'Vrijeme je danas lijepo. Ugodan vam dan.',
  hu: 'Ma szép az idő. Szép napot kívánok!',
  id: 'Hari ini cuacanya bagus. Semoga harimu menyenangkan.',
  it: 'Il tempo è bello oggi. Ti auguro una buona giornata.',
  lt: 'Šiandien gražus oras. Gražios dienos!',
  lv: 'Šodien ir jauks laiks. Lai jums brīnišķīga diena!',
  nl: 'Het weer is mooi vandaag. Een fijne dag verder.',
  pl: 'Dziś jest ładna pogoda. Życzę miłego dnia.',
  pt: 'O tempo está bom hoje. Tenha um ótimo dia.',
  ro: 'Vremea este frumoasă astăzi. Să ai o zi minunată.',
  ru: 'Сегодня хорошая погода. Желаю вам прекрасного дня.',
  sk: 'Dnes je pekné počasie. Pekný deň!',
  sl: 'Danes je lepo vreme. Lep dan vam želim.',
  sv: 'Vädret är fint idag. Ha en bra dag.',
  tr: 'Bugün hava güzel. İyi günler dilerim.',
  uk: 'Сьогодні гарна погода. Бажаю гарного дня.',
  vi: 'Hôm nay thời tiết đẹp. Chúc bạn một ngày tốt lành.',
};

/**
 * Set of every sample-text string for fast "is this an unedited demo?"
 * checks — used to decide whether changing the language picker should
 * auto-swap the speak text or leave the user's edits alone.
 */
export const SAMPLE_TEXT_SET: ReadonlySet<string> = new Set(
  Object.values(SAMPLE_TEXT),
);
