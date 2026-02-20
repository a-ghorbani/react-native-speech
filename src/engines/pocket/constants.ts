/**
 * Pocket TTS Engine Constants
 *
 * Centralized constants from the Pocket TTS model architecture.
 * Pocket TTS is a 100M-parameter CALM-based TTS by Kyutai Labs.
 *
 * Tensor names and shapes come from the community ONNX export:
 * https://huggingface.co/KevinAHM/pocket-tts-onnx
 *
 * The pipeline uses 4 ONNX models with a multi-pass inference strategy:
 * 1. text_conditioner: token_ids → embeddings
 * 2. flow_lm_main: voice pass → text pass → autoregressive generation
 * 3. flow_lm_flow: Euler ODE integration (noise → latent)
 * 4. mimi_decoder: latent chunks → audio frames
 */

export const POCKET_CONSTANTS = {
  // Synthesis defaults
  /** Default maximum characters per chunk for sentence-level chunking */
  DEFAULT_MAX_CHUNK_SIZE: 300,
  /** Default number of LSD flow decode steps */
  DEFAULT_LSD_STEPS: 4,
  /** Default temperature for autoregressive sampling */
  DEFAULT_TEMPERATURE: 0.7,
  /** Default EOS raw logit threshold (compared directly, not sigmoid) */
  DEFAULT_EOS_THRESHOLD: -4.0,
  /** Default maximum autoregressive tokens per generation */
  DEFAULT_MAX_TOKENS: 500,
  /** Number of extra frames to generate after EOS detection */
  FRAMES_AFTER_EOS: 3,

  // Audio output
  /** Output sample rate in Hz */
  SAMPLE_RATE: 24000,
  /** Audio channels (mono) */
  CHANNELS: 1,
  /** Frame rate in Hz (latent frames per second) */
  FRAME_RATE: 12.5,

  // Model dimensions
  /** Flow latent dimension (sequence/noise/velocity space) */
  LATENT_DIM: 32,
  /** Transformer hidden / text embedding dimension */
  HIDDEN_DIM: 1024,
  /** Number of latent frames per mimi decoder chunk */
  DECODER_CHUNK_SIZE: 15,

  // State tensor naming convention
  /** Prefix for input state tensors */
  STATE_INPUT_PREFIX: 'state_',
  /** Prefix for output state tensors */
  STATE_OUTPUT_PREFIX: 'out_state_',

  // Tokenizer
  /** BOS token ID */
  BOS_TOKEN_ID: 1,
  /** EOS token ID */
  EOS_TOKEN_ID: 2,
  /** PAD token ID */
  PAD_TOKEN_ID: 0,

  // Built-in voices
  BUILTIN_VOICES: [
    'alba',
    'marius',
    'javert',
    'jean',
    'fantine',
    'cosette',
    'eponine',
    'azelma',
  ] as const,

  // Voice metadata
  VOICE_DATA: {
    alba: {
      name: 'Alba',
      gender: 'f' as const,
      description: 'Clear, warm female voice',
    },
    marius: {
      name: 'Marius',
      gender: 'm' as const,
      description: 'Young, expressive male voice',
    },
    javert: {
      name: 'Javert',
      gender: 'm' as const,
      description: 'Deep, authoritative male voice',
    },
    jean: {
      name: 'Jean',
      gender: 'm' as const,
      description: 'Calm, measured male voice',
    },
    fantine: {
      name: 'Fantine',
      gender: 'f' as const,
      description: 'Gentle, soft female voice',
    },
    cosette: {
      name: 'Cosette',
      gender: 'f' as const,
      description: 'Bright, youthful female voice',
    },
    eponine: {
      name: 'Eponine',
      gender: 'f' as const,
      description: 'Strong, confident female voice',
    },
    azelma: {
      name: 'Azelma',
      gender: 'f' as const,
      description: 'Light, playful female voice',
    },
  },

  /**
   * Tensor names for each ONNX model session.
   * Discovered from the community ONNX export (KevinAHM/pocket-tts-onnx).
   *
   * State tensors (state_0...state_N) are discovered dynamically at runtime
   * via session.inputNames — only non-state I/O names are pinned here.
   */
  TENSOR_NAMES: {
    // text_conditioner.onnx
    TEXT_COND_INPUT: 'token_ids',
    TEXT_COND_OUTPUT: 'embeddings',

    // flow_lm_main.onnx (stateful)
    FLOW_MAIN_SEQUENCE: 'sequence',
    FLOW_MAIN_TEXT_EMBEDDINGS: 'text_embeddings',
    FLOW_MAIN_CONDITIONING: 'conditioning',
    FLOW_MAIN_EOS_LOGIT: 'eos_logit',

    // flow_lm_flow.onnx
    FLOW_C: 'c',
    FLOW_S: 's',
    FLOW_T: 't',
    FLOW_X: 'x',
    FLOW_DIR: 'flow_dir',

    // mimi_decoder.onnx (stateful)
    DECODER_LATENT: 'latent',
    DECODER_AUDIO: 'audio_frame',
  },
} as const;

/**
 * Type for built-in voice IDs
 */
export type PocketBuiltinVoiceId =
  (typeof POCKET_CONSTANTS.BUILTIN_VOICES)[number];
