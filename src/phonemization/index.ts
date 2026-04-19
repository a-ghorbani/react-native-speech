/**
 * GPL-free phonemization pipeline.
 *
 * Shared by neural TTS engines (Kokoro, Kitten) that need a dict-based
 * phonemizer plus hans00/phonemize OOV fallback.
 */

export {loadDict, loadNativeDict, clearDictCache} from './dict';
export type {DictSource} from './DictSource';
export {JsDictSource} from './JsDictSource';
export {NativeDictSource, openNativeDict} from './NativeDictSource';
export {HansPhonemizer, type HansPhonemizerOptions} from './HansPhonemizer';
export {splitCamelCase} from './splitCamelCase';
export {
  TextPreprocessor,
  type TextPreprocessorConfig,
  chunkText,
  ensurePunctuation,
  numberToWords,
  floatToWords,
} from './KittenPreprocessor';
