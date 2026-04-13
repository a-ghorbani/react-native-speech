/**
 * GPL-free phonemization pipeline.
 *
 * Shared by neural TTS engines (Kokoro, Kitten) that need a dict-based
 * phonemizer plus hans00/phonemize OOV fallback.
 */

export {loadDict, clearDictCache} from './dict';
export {HansPhonemizer, type HansPhonemizerOptions} from './HansPhonemizer';
export {
  TextPreprocessor,
  type TextPreprocessorConfig,
  chunkText,
  ensurePunctuation,
  numberToWords,
  floatToWords,
} from './KittenPreprocessor';
