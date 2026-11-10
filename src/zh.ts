/**
 * Opt-in Mandarin Chinese for the Kokoro engine (voices `zf_*`, `zm_*`).
 *
 *   import '@pocketpalai/react-native-speech/zh';
 *
 * Needs the optional peer dependency `pinyin-pro`.
 */
import {chineseToKokoroPhonemes} from './engines/kokoro/chinese';
import {registerKokoroG2P} from './engines/kokoro/languageG2P';

registerKokoroG2P('zh', chineseToKokoroPhonemes);

export {chineseToKokoroPhonemes};
