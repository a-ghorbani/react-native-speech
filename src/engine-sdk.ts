/**
 * Building blocks for engine add-ons:
 * `import {EngineStreamSession} from '@pocketpalai/react-native-speech/engine-sdk'`.
 *
 * @experimental May change in a minor release until a second add-on
 * exists; add-ons should pin a tilde range (`~2.7.0`). The engine
 * contract itself (`TTSEngineInterface`, `EngineId`, `Speech.registerEngine`,
 * ...) is exported from the package root. See docs/USAGE.md
 * "Engine add-on API".
 */

/** Pipelined synth + play loop for streaming engines. */
export {EngineStreamSession} from './engines/EngineStreamSession';
export type {EngineStreamSessionConfig} from './engines/EngineStreamSession';
/** The shared neural audio player. */
export {
  NeuralAudioPlayer,
  neuralAudioPlayer,
} from './engines/NeuralAudioPlayer';
export type {PlaybackOptions} from './engines/NeuralAudioPlayer';
/** Text chunking used by the neural engines. */
export {TextChunker} from './utils/TextChunker';
export type {TextChunk} from './utils/TextChunker';
export {StreamingChunker} from './engines/StreamingChunker';
export {findFirstClauseEnd} from './utils/firstClause';
export {stripMarkdown} from './utils/stripMarkdown';
/** Asset and logging helpers. */
export {base64ToArrayBuffer, loadAssetAsText} from './utils/AssetLoader';
export {createComponentLogger} from './utils/logger';
