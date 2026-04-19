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
// `splitCamelCase` is intentionally NOT re-exported. It's an internal
// preprocessing helper used by the engine normalizers; exposing it would
// freeze the regex behavior as part of the package's semver contract.
export {
  TextPreprocessor,
  type TextPreprocessorConfig,
  chunkText,
  ensurePunctuation,
  numberToWords,
  floatToWords,
} from './KittenPreprocessor';
