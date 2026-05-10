/**
 * Kitten TTS specific types
 *
 * Kitten TTS is a 15M-parameter StyleTTS 2-based neural TTS engine.
 * Uses a single ONNX model with phonemization:
 * 1. Text normalization
 * 2. G2P phonemization (pure-JS GPL-free dictionary lookup)
 * 3. Character-level IPA tokenization
 * 4. Single ONNX forward pass → audio waveform
 *
 * Features: 8 built-in voices, 24kHz output, length-dependent voice styling.
 * English only.
 */

import type {SynthesisOptions} from './Engine';
import type {ExecutionProvider} from './Kokoro';

export type KittenLanguage = 'en';

/**
 * Built-in Kitten TTS voice identifiers
 */
export type KittenBuiltinVoice =
  | 'Bella'
  | 'Jasper'
  | 'Luna'
  | 'Bruno'
  | 'Rosie'
  | 'Hugo'
  | 'Kiki'
  | 'Leo';

export interface KittenVoice {
  /** Voice identifier (e.g., 'Bella', 'Jasper') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Voice description */
  description?: string;
  /** Language code */
  language: KittenLanguage;
  /** Voice gender */
  gender: 'male' | 'female';
}

export interface KittenSynthesisOptions extends SynthesisOptions {
  /** Voice identifier for Kitten TTS */
  voiceId: string;
  /** Speed control (0.5 - 2.0) */
  speed?: number;
}

export interface KittenConfig {
  /** Path to ONNX model file */
  modelPath: string;
  /** Path to voices JSON file (pre-converted from NPZ) or manifest JSON */
  voicesPath: string;
  /**
   * Path to tokenizer vocab JSON file (IPA character → token ID mapping).
   * If not provided, uses the built-in symbol table.
   */
  tokenizerPath?: string;
  /**
   * Path to the IPA dictionary TSV file (word<TAB>ipa per line).
   * Required for the GPL-free JS phonemizer. Accepts file:// and https:// URLs.
   */
  dictPath?: string;
  /**
   * Maximum chunk size in characters for text splitting (default: 400)
   * Smaller values = faster first audio & more progress events
   * Larger values = fewer inference calls
   */
  maxChunkSize?: number;
  /**
   * Execution providers for ONNX Runtime inference, in fallback order.
   * Defaults to CoreML+xnnpack+cpu on iOS, xnnpack+cpu on Android when
   * omitted. See `KokoroConfig.executionProviders` for full semantics.
   */
  executionProviders?: ExecutionProvider[];
}
