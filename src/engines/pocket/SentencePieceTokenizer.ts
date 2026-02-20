/**
 * SentencePiece Tokenizer for Pocket TTS
 *
 * Pure JavaScript implementation of SentencePiece unigram tokenizer.
 * Parses .model files (protobuf format) and implements Viterbi-based
 * tokenization without WASM dependencies (Hermes doesn't support WASM).
 *
 * The .model file is a serialized protobuf (ModelProto) containing:
 * - Vocabulary: array of (piece, score) pairs
 * - Piece types: NORMAL=1, UNKNOWN=2, CONTROL=3, USER_DEFINED=4, UNUSED=5, BYTE=6
 *
 * Implementation follows the same approach as sentencepiece-js and other
 * pure-JS SentencePiece implementations.
 */

import {loadAssetAsArrayBuffer} from '../../utils/AssetLoader';
import {createComponentLogger} from '../../utils/logger';

const log = createComponentLogger('Pocket', 'Tokenizer');

/** Piece types in SentencePiece vocabulary */
const PIECE_TYPE = {
  NORMAL: 1,
  UNKNOWN: 2,
  CONTROL: 3,
  USER_DEFINED: 4,
  UNUSED: 5,
  BYTE: 6,
} as const;

/** SentencePiece uses U+2581 (lower one eighth block) as the space marker */
const SPACE_MARKER = '\u2581';

interface SentencePiece {
  piece: string;
  score: number;
  type: number;
}

/**
 * Protobuf wire types
 */
const WIRE_TYPE = {
  VARINT: 0,
  FIXED64: 1,
  LENGTH_DELIMITED: 2,
  FIXED32: 5,
} as const;

/**
 * Minimal protobuf decoder for SentencePiece ModelProto.
 *
 * ModelProto schema (only fields we need):
 *   message ModelProto {
 *     repeated SentencePiece pieces = 1;  // field 1, length-delimited
 *   }
 *   message SentencePiece {
 *     optional string piece = 1;          // field 1, length-delimited
 *     optional float score = 2;           // field 2, fixed32
 *     optional Type type = 3;             // field 3, varint
 *   }
 */
class ProtobufReader {
  private view: DataView;
  private offset: number;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.offset = 0;
  }

  hasMore(): boolean {
    return this.offset < this.view.byteLength;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.offset < this.view.byteLength) {
      const byte = this.view.getUint8(this.offset++);
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result >>> 0; // Unsigned
      }
      shift += 7;
      if (shift > 35) {
        throw new Error('Varint too long');
      }
    }
    throw new Error('Unexpected end of buffer reading varint');
  }

  readFieldTag(): {fieldNumber: number; wireType: number} {
    const tag = this.readVarint();
    return {
      fieldNumber: tag >>> 3,
      wireType: tag & 0x07,
    };
  }

  readBytes(): Uint8Array {
    const length = this.readVarint();
    if (this.offset + length > this.view.byteLength) {
      throw new Error('Unexpected end of buffer reading bytes');
    }
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.offset,
      length,
    );
    this.offset += length;
    return bytes;
  }

  readString(): string {
    const bytes = this.readBytes();
    // Manual UTF-8 decode — Hermes doesn't have TextDecoder
    let result = '';
    let i = 0;
    while (i < bytes.length) {
      const byte = bytes[i]!;
      if (byte < 0x80) {
        result += String.fromCharCode(byte);
        i += 1;
      } else if ((byte & 0xe0) === 0xc0) {
        result += String.fromCharCode(
          ((byte & 0x1f) << 6) | (bytes[i + 1]! & 0x3f),
        );
        i += 2;
      } else if ((byte & 0xf0) === 0xe0) {
        result += String.fromCharCode(
          ((byte & 0x0f) << 12) |
            ((bytes[i + 1]! & 0x3f) << 6) |
            (bytes[i + 2]! & 0x3f),
        );
        i += 3;
      } else if ((byte & 0xf8) === 0xf0) {
        const codePoint =
          ((byte & 0x07) << 18) |
          ((bytes[i + 1]! & 0x3f) << 12) |
          ((bytes[i + 2]! & 0x3f) << 6) |
          (bytes[i + 3]! & 0x3f);
        // Encode as UTF-16 surrogate pair
        const adjusted = codePoint - 0x10000;
        result += String.fromCharCode(
          0xd800 + (adjusted >> 10),
          0xdc00 + (adjusted & 0x3ff),
        );
        i += 4;
      } else {
        // Invalid byte, skip
        i += 1;
      }
    }
    return result;
  }

  readFloat32(): number {
    if (this.offset + 4 > this.view.byteLength) {
      throw new Error('Unexpected end of buffer reading float32');
    }
    const value = this.view.getFloat32(this.offset, true); // little-endian
    this.offset += 4;
    return value;
  }

  readFixed64(): void {
    // Skip 8 bytes (we don't need 64-bit fixed values)
    this.offset += 8;
  }

  skipField(wireType: number): void {
    switch (wireType) {
      case WIRE_TYPE.VARINT:
        this.readVarint();
        break;
      case WIRE_TYPE.FIXED64:
        this.readFixed64();
        break;
      case WIRE_TYPE.LENGTH_DELIMITED:
        this.readBytes();
        break;
      case WIRE_TYPE.FIXED32:
        this.offset += 4;
        break;
      default:
        throw new Error(`Unknown wire type: ${wireType}`);
    }
  }

  getOffset(): number {
    return this.offset;
  }

  setOffset(offset: number): void {
    this.offset = offset;
  }

  getLength(): number {
    return this.view.byteLength;
  }
}

/**
 * Parse a single SentencePiece message from a sub-buffer
 */
function parseSentencePieceMessage(bytes: Uint8Array): SentencePiece {
  const reader = new ProtobufReader(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );

  let piece = '';
  let score = 0.0;
  let type: number = PIECE_TYPE.NORMAL;

  while (reader.hasMore()) {
    const {fieldNumber, wireType} = reader.readFieldTag();

    switch (fieldNumber) {
      case 1: // piece (string)
        piece = reader.readString();
        break;
      case 2: // score (float)
        score = reader.readFloat32();
        break;
      case 3: // type (enum as varint)
        type = reader.readVarint();
        break;
      default:
        reader.skipField(wireType);
        break;
    }
  }

  return {piece, score, type};
}

export class SentencePieceTokenizer {
  private pieces: SentencePiece[] = [];
  private pieceToId: Map<string, number> = new Map();
  private initialized = false;

  // Special token IDs (set during model loading)
  private unkId = 0;
  private bosId = 1;
  private eosId = 2;

  // Longest piece length (for Viterbi search window)
  private maxPieceLength = 0;

  /**
   * Initialize from a SentencePiece .model file path
   */
  async initialize(modelPath: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    log.info('Loading SentencePiece model from:', modelPath);

    const buffer = await loadAssetAsArrayBuffer(modelPath);
    this.parseModelProto(buffer);

    log.info(
      `SentencePiece model loaded: ${this.pieces.length} pieces, maxPieceLength=${this.maxPieceLength}`,
    );
    this.initialized = true;
  }

  /**
   * Parse the protobuf ModelProto to extract vocabulary
   */
  private parseModelProto(buffer: ArrayBuffer): void {
    const reader = new ProtobufReader(buffer);
    this.pieces = [];
    this.pieceToId.clear();
    this.maxPieceLength = 0;

    while (reader.hasMore()) {
      const {fieldNumber, wireType} = reader.readFieldTag();

      if (fieldNumber === 1 && wireType === WIRE_TYPE.LENGTH_DELIMITED) {
        // Field 1 = repeated SentencePiece pieces
        const pieceBytes = reader.readBytes();
        const piece = parseSentencePieceMessage(pieceBytes);
        const id = this.pieces.length;

        this.pieces.push(piece);
        this.pieceToId.set(piece.piece, id);

        // Track special tokens
        if (piece.type === PIECE_TYPE.UNKNOWN) {
          this.unkId = id;
        } else if (piece.type === PIECE_TYPE.CONTROL) {
          if (piece.piece === '<s>') {
            this.bosId = id;
          } else if (piece.piece === '</s>') {
            this.eosId = id;
          }
        }

        // Track max piece length for Viterbi window
        if (
          piece.type === PIECE_TYPE.NORMAL ||
          piece.type === PIECE_TYPE.USER_DEFINED
        ) {
          this.maxPieceLength = Math.max(
            this.maxPieceLength,
            piece.piece.length,
          );
        }
      } else {
        // Skip other fields (trainer_spec, normalizer_spec, etc.)
        reader.skipField(wireType);
      }
    }

    if (this.pieces.length === 0) {
      throw new Error('No vocabulary pieces found in SentencePiece model');
    }
  }

  /**
   * Encode text to token IDs using Viterbi algorithm.
   *
   * @param text - Input text to tokenize
   * @returns BigInt64Array of token IDs (for ONNX int64 tensors)
   */
  encode(text: string): BigInt64Array {
    if (!this.initialized) {
      throw new Error('SentencePieceTokenizer not initialized');
    }

    if (text.length === 0) {
      return new BigInt64Array(0);
    }

    // Normalize text (NFKC, matching SentencePiece defaults)
    const normalized = this.normalize(text);

    // Replace spaces with the SentencePiece space marker
    // and add leading space marker (SentencePiece convention)
    const processed = SPACE_MARKER + normalized.replace(/ /g, SPACE_MARKER);

    // Run Viterbi tokenization
    const tokenStrings = this.viterbiTokenize(processed);

    // Convert to token IDs
    const ids = new BigInt64Array(tokenStrings.length);
    for (let i = 0; i < tokenStrings.length; i++) {
      const token = tokenStrings[i]!;
      const id = this.pieceToId.get(token);
      ids[i] = BigInt(id !== undefined ? id : this.unkId);
    }

    return ids;
  }

  /**
   * Viterbi tokenization - find optimal segmentation.
   *
   * Uses dynamic programming to find the segmentation that maximizes
   * total log-probability from the unigram model.
   *
   * Algorithm:
   * 1. best[i] = best score achievable for text[0..i]
   * 2. For each position i, try all pieces ending at i
   * 3. Backtrack from best[n] to reconstruct the optimal segmentation
   */
  private viterbiTokenize(text: string): string[] {
    const n = text.length;

    // best[i] = {score, pieceLen} for best segmentation of text[0..i]
    const best: Array<{score: number; pieceLen: number}> = new Array(n + 1);
    best[0] = {score: 0, pieceLen: 0};

    for (let i = 1; i <= n; i++) {
      best[i] = {score: -Infinity, pieceLen: 1}; // Default: single-char UNK

      // Try all possible pieces ending at position i
      const maxLen = Math.min(i, this.maxPieceLength);
      for (let len = 1; len <= maxLen; len++) {
        const start = i - len;
        const substr = text.substring(start, i);
        const id = this.pieceToId.get(substr);

        if (id !== undefined) {
          const piece = this.pieces[id]!;

          // Skip control and unused tokens
          if (
            piece.type === PIECE_TYPE.CONTROL ||
            piece.type === PIECE_TYPE.UNUSED
          ) {
            continue;
          }

          const prevScore = best[start]!.score;
          const candidateScore = prevScore + piece.score;

          if (candidateScore > best[i]!.score) {
            best[i] = {score: candidateScore, pieceLen: len};
          }
        }
      }

      // If no piece was found, fall back to single character (UNK)
      if (best[i]!.score === -Infinity) {
        const prevScore = best[i - 1]!.score;
        // Assign a very low score for unknown characters
        best[i] = {score: prevScore - 100, pieceLen: 1};
      }
    }

    // Backtrack to find optimal segmentation
    const tokens: string[] = [];
    let pos = n;
    while (pos > 0) {
      const pieceLen = best[pos]!.pieceLen;
      const start = pos - pieceLen;
      tokens.push(text.substring(start, pos));
      pos = start;
    }

    tokens.reverse();
    return tokens;
  }

  /**
   * Normalize text (NFKC), matching SentencePiece defaults.
   * Hermes supports String.prototype.normalize().
   */
  private normalize(text: string): string {
    return text.normalize('NFKC');
  }

  /**
   * Decode token IDs back to text
   */
  decode(ids: number[] | BigInt64Array): string {
    if (!this.initialized) {
      throw new Error('SentencePieceTokenizer not initialized');
    }

    const parts: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = Number(ids[i]);
      if (id >= 0 && id < this.pieces.length) {
        const piece = this.pieces[id]!;
        if (
          piece.type !== PIECE_TYPE.CONTROL &&
          piece.type !== PIECE_TYPE.UNUSED
        ) {
          parts.push(piece.piece);
        }
      }
    }

    // Join and convert space markers back to spaces
    return parts.join('').replace(new RegExp(SPACE_MARKER, 'g'), ' ').trim();
  }

  /** Get BOS token ID */
  getBosId(): number {
    return this.bosId;
  }

  /** Get EOS token ID */
  getEosId(): number {
    return this.eosId;
  }

  /** Get PAD token ID (same as UNK in many SentencePiece models) */
  getPadId(): number {
    return 0;
  }

  /** Get vocabulary size */
  getVocabSize(): number {
    return this.pieces.length;
  }

  isReady(): boolean {
    return this.initialized;
  }

  clear(): void {
    this.pieces = [];
    this.pieceToId.clear();
    this.maxPieceLength = 0;
    this.initialized = false;
  }
}
