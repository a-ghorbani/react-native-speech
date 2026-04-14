/**
 * Kitten TTS Engine Constants
 *
 * Centralized constants for the Kitten neural TTS engine.
 * These values are derived from the Kitten model architecture (StyleTTS 2).
 */

import type {KittenVoice} from '../../types/Kitten';

/**
 * Core Kitten constants
 */
export const KITTEN_CONSTANTS = {
  // Audio output
  /** Sample rate in Hz for Kitten audio output */
  SAMPLE_RATE: 24000,
  /** Audio channels (mono) */
  CHANNELS: 1,

  // Synthesis limits
  /** Default maximum chunk size in characters for text splitting */
  DEFAULT_MAX_CHUNK_SIZE: 400,

  // Tokenizer
  /** Boundary/pad token ID (the '$' character, index 0) */
  BOUNDARY_TOKEN_ID: 0,
  /** End-of-sequence token ID (index 10, the '…' character in the symbol table) */
  EOS_TOKEN_ID: 10,

  // Post-processing
  /** Number of trailing samples to trim from audio output to remove artifacts */
  TRIM_SAMPLES: 5000,

  // Phonemization
  /** Language code for the dict+hans00 phonemizer */
  PHONEMIZER_LANGUAGE: 'en-us',

  // Supported languages
  AVAILABLE_LANGS: ['en-us'] as const,
} as const;

/**
 * Symbol table components for Kitten TTS TextCleaner.
 * Must match the reference implementation exactly for correct token IDs.
 * Source: KittenTTS onnx_model.py / StyleTTS2 text_utils.py
 *
 * symbols = [_pad] + list(_punctuation) + list(_letters) + list(_letters_ipa)
 *
 * IMPORTANT: The symbols array preserves duplicates (e.g., " appears 3 times
 * in _punctuation at indices 11, 14, 15). The vocab dict uses last-occurrence-
 * wins, matching Python's dict comprehension behavior.
 */
const KITTEN_PAD = '$';
const KITTEN_PUNCTUATION = ';:,.!?\u00A1\u00BF\u2014\u2026"«»"" ';
const KITTEN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KITTEN_LETTERS_IPA =
  'ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧ' +
  'ʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘' +
  "'\u0329'ᵻ";

/**
 * Build the default symbol-to-ID mapping matching the reference TextCleaner.
 * Constructs the full symbols array (with duplicates preserved) and builds
 * the vocab dict with last-occurrence-wins, matching Python's behavior.
 */
export function buildDefaultVocab(): Record<string, number> {
  const symbols = [
    KITTEN_PAD,
    ...Array.from(KITTEN_PUNCTUATION),
    ...Array.from(KITTEN_LETTERS),
    ...Array.from(KITTEN_LETTERS_IPA),
  ];
  const vocab: Record<string, number> = {};
  for (let i = 0; i < symbols.length; i++) {
    vocab[symbols[i]!] = i;
  }
  return vocab;
}

/**
 * Voice aliases: friendly name → internal NPZ key.
 * From config.json in the HuggingFace model repo.
 */
export const KITTEN_VOICE_ALIASES: Record<string, string> = {
  Bella: 'expr-voice-2-f',
  Jasper: 'expr-voice-2-m',
  Luna: 'expr-voice-3-f',
  Bruno: 'expr-voice-3-m',
  Rosie: 'expr-voice-4-f',
  Hugo: 'expr-voice-4-m',
  Kiki: 'expr-voice-5-f',
  Leo: 'expr-voice-5-m',
};

/**
 * Per-voice speed priors from config.json.
 * Multiplied with user-requested speed for better quality.
 * Keyed by internal voice name.
 */
export const KITTEN_SPEED_PRIORS: Record<string, number> = {
  'expr-voice-2-f': 1.0,
  'expr-voice-2-m': 1.0,
  'expr-voice-3-f': 1.0,
  'expr-voice-3-m': 1.0,
  'expr-voice-4-f': 1.0,
  'expr-voice-4-m': 1.0,
  'expr-voice-5-f': 1.0,
  'expr-voice-5-m': 1.0,
};

/**
 * Built-in voice metadata for the 8 Kitten TTS voices.
 * IDs use the internal NPZ key names that match the voice embedding files.
 */
export const KITTEN_BUILTIN_VOICES: KittenVoice[] = [
  {id: 'expr-voice-2-f', name: 'Bella', gender: 'female', language: 'en'},
  {id: 'expr-voice-2-m', name: 'Jasper', gender: 'male', language: 'en'},
  {id: 'expr-voice-3-f', name: 'Luna', gender: 'female', language: 'en'},
  {id: 'expr-voice-3-m', name: 'Bruno', gender: 'male', language: 'en'},
  {id: 'expr-voice-4-f', name: 'Rosie', gender: 'female', language: 'en'},
  {id: 'expr-voice-4-m', name: 'Hugo', gender: 'male', language: 'en'},
  {id: 'expr-voice-5-f', name: 'Kiki', gender: 'female', language: 'en'},
  {id: 'expr-voice-5-m', name: 'Leo', gender: 'male', language: 'en'},
];
