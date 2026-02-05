# Kokoro TTS Implementation - Refactoring Plan

This document outlines the recommended improvements for the Kokoro TTS implementation based on a comprehensive architecture and code quality review.

## Important Context

### Pre-Release Status

**This code has NOT been released yet.** This gives us significant freedom:

1. **No backward compatibility required** - We can make breaking changes to APIs, rename functions, restructure modules, and remove deprecated code without concern for existing users.

2. **Clean slate for public API** - We should design the API correctly from the start rather than carrying forward compromises.

3. **Remove all legacy code** - Any deprecated functions, unused exports, or compatibility shims should be deleted entirely, not preserved.

### Code Comments Guidelines

**Comments should reflect the CURRENT state, not historical changes:**

- **DO NOT** write comments like "// Removed old implementation" or "// Previously this was X"
- **DO NOT** leave `TODO: cleanup` comments for things that should just be cleaned up now
- **DO** write comments that explain WHY the current code works the way it does
- **DO** document complex algorithms, non-obvious decisions, and external dependencies
- **DELETE** commented-out code entirely - we have git history if needed

**Example - Bad:**
```typescript
// Old implementation used Map, now using array for performance
// TODO: Consider switching back to Map if needed
const indexer = buildIndexerArray();
```

**Example - Good:**
```typescript
// Array lookup is O(1) and faster than Map for Unicode codepoint indexing
const indexer = buildIndexerArray();
```

---

## Overview

**Current Assessment: C+** (Functional foundation with significant issues)

The implementation is functional and follows reasonable patterns, but has several areas that need attention for production readiness.

| Area | Grade | Notes |
|------|-------|-------|
| Code Readability | B | Generally clean, inconsistent naming conventions |
| Type Safety | D | Heavy use of `any` types undermines TypeScript benefits |
| Architecture | C+ | Good separation, but race conditions and error handling issues |
| Error Handling | D | Incomplete, silent failures, no recovery |
| Maintainability | C+ | Scattered constants, embedded utilities |
| Performance | B- | Reasonable, but race conditions in lazy loading |

---

## Priority 1: Must-Fix Issues

### 1.1 Remove RemotePhonemizer

RemotePhonemizer was for testing purposes.

**File**: `src/engines/kokoro/Phonemizer.ts`

---

### 1.2 Improve Type Safety - Eliminate `any` Types

**Files**:
- `src/engines/kokoro/KokoroEngine.ts`
- `src/engines/kokoro/AssetLoader.ts`

**Problem**: Heavy use of `any` types:
```typescript
// Current - loses all type safety
let InferenceSession: any;
let Tensor: any;
private session: any = null;
function resolveExecutionProviders(...): any[] { }
```

**Solution**:
1. Create type declarations for ONNX Runtime (can share with Supertonic):

```typescript
// src/types/OnnxRuntime.ts
export interface OnnxTensor {
  data: ArrayLike<number> | ArrayLike<bigint>;
  dims: readonly number[];
  type: string;
}

export interface OnnxInferenceSession {
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
}

export interface OnnxSessionOptions {
  executionProviders: Array<string | Record<string, unknown>>;
}

export type ExecutionProvider =
  | 'cpu'
  | 'coreml'
  | { name: 'coreml'; useCPUOnly?: boolean };
```

2. Update KokoroEngine.ts to use proper types
3. Fix `loadAssetAsJSON<T>()` return type in AssetLoader.ts

**Effort**: Medium (~2 hours)

---

### 1.3 Add Tensor/Embedding Shape Validation

**Files**:
- `src/engines/kokoro/VoiceLoader.ts`
- `src/engines/kokoro/KokoroEngine.ts`

**Problem**: Silent failures when tensor shapes are wrong:
```typescript
// Current - wrong size leads to incorrect slice
const embedding = fullVoiceData.slice(offset, offset + STYLE_DIM);
// No validation that fullVoiceData has correct total size
```

**Solution**:
```typescript
// Expected dimensions for Kokoro voice embeddings
const KOKORO_EMBEDDING_CONSTANTS = {
  STYLE_DIM: 256,           // Each embedding is 256 floats
  MAX_TOKENS: 509,          // Maximum token positions
  TOTAL_EMBEDDINGS: 510,    // Total embeddings per voice (509 + 1)
  EXPECTED_VOICE_SIZE: 130560, // 510 * 256 = 130,560 floats
} as const;

private validateVoiceEmbedding(voiceId: string, data: Float32Array): void {
  const { EXPECTED_VOICE_SIZE, STYLE_DIM, TOTAL_EMBEDDINGS } = KOKORO_EMBEDDING_CONSTANTS;

  if (data.length !== EXPECTED_VOICE_SIZE) {
    throw new Error(
      `Invalid voice embedding size for '${voiceId}': ` +
      `expected ${EXPECTED_VOICE_SIZE} (${TOTAL_EMBEDDINGS} × ${STYLE_DIM}), ` +
      `got ${data.length}`
    );
  }
}

async getVoiceEmbedding(voiceId: string, numTokens: number = 0): Promise<Float32Array> {
  const fullVoiceData = await this.loadVoice(voiceId);
  this.validateVoiceEmbedding(voiceId, fullVoiceData);

  const { STYLE_DIM, MAX_TOKENS } = KOKORO_EMBEDDING_CONSTANTS;
  const adjustedTokens = Math.min(Math.max(numTokens - 2, 0), MAX_TOKENS);
  const offset = adjustedTokens * STYLE_DIM;

  return fullVoiceData.slice(offset, offset + STYLE_DIM);
}
```

**Effort**: Low (~1 hour)

---

### 1.4 Fix Race Condition in Lazy Voice Loading

**File**: `src/engines/kokoro/VoiceLoader.ts`

**Problem**: Concurrent calls to `getVoiceEmbedding()` for the same voice will both attempt to load.

**Solution**:
```typescript
private loadingPromises: Map<string, Promise<Float32Array>> = new Map();

async getVoiceEmbedding(voiceId: string, numTokens: number = 0): Promise<Float32Array> {
  let fullVoiceData = this.voiceEmbeddings.get(voiceId);

  if (!fullVoiceData && this.lazyLoadingEnabled) {
    // Check if already loading
    const existingPromise = this.loadingPromises.get(voiceId);
    if (existingPromise) {
      fullVoiceData = await existingPromise;
    } else {
      // Start loading and cache the promise
      const loadPromise = this.lazyLoadVoice(voiceId).then(data => {
        this.loadingPromises.delete(voiceId);
        return data;
      }).catch(error => {
        this.loadingPromises.delete(voiceId);
        throw error;
      });

      this.loadingPromises.set(voiceId, loadPromise);
      fullVoiceData = await loadPromise;
    }
  }

  if (!fullVoiceData) {
    throw new Error(`Voice '${voiceId}' not found`);
  }

  // ... rest of method
}
```

**Effort**: Medium (~1 hour)

---

### 1.5 Improve Error Recovery in Initialize

**File**: `src/engines/kokoro/KokoroEngine.ts`

**Problem**: If initialization fails partway through, partial state may remain.

**Solution**:
```typescript
async initialize(config?: KokoroConfig): Promise<void> {
  if (this.isInitialized) return;
  if (this.isLoading) {
    throw new Error('Engine is already initializing');
  }

  this.isLoading = true;
  this.initError = null;

  try {
    await this.loadTokenizerFromHF(this.config.tokenizerPath);
    await this.loadVoices(this.config.voicesPath);
    await this.loadModel(this.config.modelPath);
    this.isInitialized = true;
  } catch (error) {
    // Clean up any partial initialization
    await this.destroy();
    this.initError = error instanceof Error ? error.message : 'Unknown error';
    console.error('[KokoroEngine] Initialization failed:', error);
    throw error;
  } finally {
    this.isLoading = false;
  }
}

async destroy(): Promise<void> {
  // Reset all state
  this.session = null;
  this.tokenizer = null;
  this.voiceLoader = null;
  this.isInitialized = false;
  this.isLoading = false;
}
```

**Effort**: Low (~30 minutes)

---

### 1.6 Add Input Validation in synthesizeChunk

**File**: `src/engines/kokoro/KokoroEngine.ts`

**Problem**: No validation of inputs before creating tensors.

**Solution**:
```typescript
private async synthesizeChunk(
  tokens: number[],
  voiceId: string,
  options?: KokoroSynthesisOptions,
): Promise<AudioBuffer> {
  // Validate inputs
  if (!tokens || tokens.length === 0) {
    throw new Error('Cannot synthesize empty token array');
  }

  if (tokens.length > MAX_TOKEN_LIMIT) {
    throw new Error(
      `Token count ${tokens.length} exceeds maximum ${MAX_TOKEN_LIMIT}. ` +
      'Use synthesize() for automatic chunking.'
    );
  }

  if (!voiceId) {
    throw new Error('Voice ID is required');
  }

  // Validate voice exists before creating tensors
  const availableVoices = this.voiceLoader?.getVoiceIds() ?? [];
  if (!availableVoices.includes(voiceId)) {
    throw new Error(
      `Voice '${voiceId}' not found. Available voices: ${availableVoices.join(', ')}`
    );
  }

  // ... rest of method
}
```

**Effort**: Low (~30 minutes)

---

## Priority 2: Should-Fix Issues

### 2.1 Consolidate Constants

**Solution**: Create a dedicated constants file:

```typescript
// src/engines/kokoro/constants.ts
export const KOKORO_CONSTANTS = {
  // Synthesis limits
  MAX_TOKEN_LIMIT: 500,
  DEFAULT_MAX_CHUNK_SIZE: 400,

  // Tokenizer
  BOUNDARY_TOKEN_ID: 0,

  // Voice embeddings
  STYLE_DIM: 256,
  MAX_TOKENS: 509,
  TOTAL_EMBEDDINGS: 510,
  EXPECTED_VOICE_SIZE: 130560,  // 510 * 256

  // Audio output
  SAMPLE_RATE: 24000,

  // Phonemization
  PUNCTUATION_CHARS: '.!?;:,',
  PUNCTUATION_REGEX: /([.!?;:,])/g,

  // Supported languages
  AVAILABLE_LANGS: ['en-us', 'en-gb', 'ja', 'zh', 'ko'] as const,
} as const;

export type SupportedLanguage = typeof KOKORO_CONSTANTS.AVAILABLE_LANGS[number];
```

**Effort**: Medium (~1 hour)

---

### 2.2 Add Volume Bounds Checking

**File**: `src/engines/kokoro/KokoroEngine.ts`

**Problem**: Volume adjustment can cause clipping or phase inversion.

**Solution**:
```typescript
if (options?.volume !== undefined && options.volume !== 1.0) {
  const clampedVolume = Math.max(0, Math.min(2, options.volume)); // Allow up to 2x
  for (let i = 0; i < audioBuffer.samples.length; i++) {
    const sample = audioBuffer.samples[i];
    if (sample !== undefined) {
      // Apply volume and clamp to prevent clipping
      const adjusted = sample * clampedVolume;
      audioBuffer.samples[i] = Math.max(-1, Math.min(1, adjusted));
    }
  }
}
```

**Effort**: Low (~15 minutes)

---

### 2.3 Add Missing Return Type Annotations

**Files**: Multiple

**Problem**: Some methods lack explicit return types.

**Solution**: Add return type annotations to:
- `KokoroEngine.getStatus(): EngineStatus`
- `KokoroEngine.parseVoiceId(): { name: string; style: string } | null`
- `VoiceLoader.getVoiceIds(): string[]`
- `VoiceLoader.getVoices(): KokoroVoice[]`
- `resolveExecutionProviders(): ExecutionProvider[]`
- `AssetLoader.loadAssetAsJSON<T>(): Promise<T>`

**Effort**: Low (~30 minutes)

---

### 2.4 Clean Up Dead/Deprecated Exports

**File**: `src/engines/kokoro/index.ts`

**Problem**: Some exports may be internal implementation details.

**Solution**:
1. Review if `BPETokenizer` and `VoiceLoader` should be public API
2. Either document them as public or mark as `@internal`
3. Consider creating a separate `internal.ts` for implementation details

```typescript
// src/engines/kokoro/index.ts - Public API
export {KokoroEngine} from './KokoroEngine';
export type {
  KokoroConfig,
  KokoroSynthesisOptions,
  KokoroVoice,
} from '../../types/Kokoro';

// Only export if intentionally public
// export {BPETokenizer} from './BPETokenizer';
// export {VoiceLoader} from './VoiceLoader';
```

**Effort**: Low (~30 minutes)

---

### 2.5 Add Voice Style Validation in VoiceLoader

**File**: `src/engines/kokoro/VoiceLoader.ts`

**Problem**: No validation of loaded voice data structure.

**Solution**:
```typescript
private validateVoiceData(voiceId: string, data: Float32Array): void {
  if (!data || data.length === 0) {
    throw new Error(`Voice '${voiceId}' has empty embedding data`);
  }

  if (data.length !== KOKORO_CONSTANTS.EXPECTED_VOICE_SIZE) {
    throw new Error(
      `Voice '${voiceId}' has invalid size: ` +
      `expected ${KOKORO_CONSTANTS.EXPECTED_VOICE_SIZE}, got ${data.length}`
    );
  }

  // Check for NaN/Infinity values
  for (let i = 0; i < Math.min(data.length, 1000); i++) {
    if (!Number.isFinite(data[i])) {
      throw new Error(
        `Voice '${voiceId}' contains invalid value at index ${i}: ${data[i]}`
      );
    }
  }
}
```

**Effort**: Low (~30 minutes)

---

### 2.6 Reduce Development Logging

**File**: `src/engines/kokoro/KokoroEngine.ts`

**Problem**: 92 `console.log()` calls throughout the engine.

**Solution**: Create a logger utility (can share with Supertonic):

```typescript
// src/engines/kokoro/utils/logger.ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_PREFIX = '[Kokoro]';
const DEBUG_ENABLED = __DEV__ ?? false;

export const logger = {
  debug: (component: string, message: string, ...args: unknown[]) => {
    if (DEBUG_ENABLED) {
      console.log(`${LOG_PREFIX}[${component}] ${message}`, ...args);
    }
  },
  info: (component: string, message: string, ...args: unknown[]) => {
    console.log(`${LOG_PREFIX}[${component}] ${message}`, ...args);
  },
  warn: (component: string, message: string, ...args: unknown[]) => {
    console.warn(`${LOG_PREFIX}[${component}] ${message}`, ...args);
  },
  error: (component: string, message: string, ...args: unknown[]) => {
    console.error(`${LOG_PREFIX}[${component}] ${message}`, ...args);
  },
};
```

**Effort**: Medium (~1.5 hours)

---

## Priority 3: Nice-to-Have Improvements

### 3.1 Extract Text Chunking Utility

**File**: `src/engines/kokoro/KokoroEngine.ts`

**Problem**: Text chunking logic is embedded in the engine class.

**Solution**: Create a shared utility (can be used by both Kokoro and Supertonic):

```typescript
// src/utils/TextChunker.ts
export interface TextChunk {
  text: string;
  startIndex: number;
  endIndex: number;
}

export class TextChunker {
  /**
   * Split text into chunks by sentences, respecting max size
   */
  static chunkBySentences(text: string, maxChunkSize: number): TextChunk[] {
    // ... implementation
  }
}
```

**Effort**: Medium (~1 hour)

---

### 3.2 Extract Phonemization Utilities

**File**: `src/engines/kokoro/Phonemizer.ts`

**Problem**: Utility functions embedded in phonemizer module.

**Solution**: Extract to separate utilities:

```typescript
// src/engines/kokoro/utils/phonemeUtils.ts
export const PUNCTUATION = {
  CHARS: '.!?;:,',
  REGEX: /([.!?;:,])/g,
} as const;

export function splitOnPunctuation(text: string): string[] {
  // ... implementation
}

export function rejoinChunks(chunks: string[]): string[] {
  // ... implementation
}

export function postProcessPhonemes(phonemes: string, lang: string): string {
  // ... implementation
}
```

**Effort**: Medium (~1 hour)

---

### 3.3 Add Comprehensive JSDoc Documentation

**Files**: Multiple

**Problem**: Complex functions lack detailed documentation.

**Solution**: Add JSDoc with examples:

```typescript
/**
 * Split text into chunks separated by punctuation marks.
 * Punctuation marks are preserved as separate chunks.
 *
 * @example
 * splitOnPunctuation("Hello, world!")
 * // returns ["Hello", ",", " world", "!"]
 *
 * @param text - The input text to split
 * @returns Array of text chunks with punctuation as separate elements
 */
export function splitOnPunctuation(text: string): string[] {
  // ... implementation
}

/**
 * Get voice embedding for a specific token position.
 *
 * Voice embeddings are stored as a sequence of 510 embeddings (positions 0-509),
 * each with 256 float values. The embedding at position N represents the voice
 * characteristics for token N in the sequence.
 *
 * @example
 * // Get embedding for 5th token
 * const embedding = await voiceLoader.getVoiceEmbedding('af_bella', 5);
 * // embedding.length === 256
 *
 * @param voiceId - The voice identifier (e.g., 'af_bella', 'am_michael')
 * @param numTokens - Token position (0-509), defaults to 0
 * @returns Float32Array with 256 embedding values
 * @throws Error if voice not found or embedding data is invalid
 */
async getVoiceEmbedding(voiceId: string, numTokens: number = 0): Promise<Float32Array> {
  // ... implementation
}
```

**Effort**: Medium (~2 hours)

---

### 3.4 Add Voice File Format Type Definition

**File**: `src/types/Kokoro.ts`

**Problem**: Binary voice file format only documented in comments.

**Solution**:
```typescript
/**
 * Binary voice file format specification.
 *
 * The .bin voice file contains multiple voice embeddings concatenated:
 *
 * For each voice:
 * - voice_id_length: 4 bytes (uint32, little-endian)
 * - voice_id: N bytes (UTF-8 string)
 * - embedding_dim: 4 bytes (uint32, little-endian) - always 130560
 * - embedding_data: 130560 × 4 bytes (float32 array, little-endian)
 *
 * Each voice has 510 embeddings × 256 floats = 130,560 total floats.
 */
export interface VoiceFileFormat {
  voices: Array<{
    voiceId: string;
    embeddings: Float32Array; // 130,560 floats
  }>;
}

export const VOICE_FILE_CONSTANTS = {
  EMBEDDINGS_PER_VOICE: 510,
  FLOATS_PER_EMBEDDING: 256,
  TOTAL_FLOATS_PER_VOICE: 130560,
} as const;
```

**Effort**: Low (~30 minutes)

---

### 3.5 Remove Unused Parameter in BPETokenizer

**File**: `src/engines/kokoro/BPETokenizer.ts`

**Problem**: `_mergesData` parameter is ignored.

**Solution**:
```typescript
// Option 1: Remove the parameter if merges are not needed
async loadFromData(vocabData: Record<string, number>): Promise<void> {
  // ... implementation
}

// Option 2: Document why it's ignored
/**
 * Load tokenizer from vocabulary data.
 *
 * @param vocabData - Token to ID mapping
 * @param _mergesData - BPE merge rules (currently unused, reserved for future)
 * @deprecated mergesData parameter - BPE merges not used in current implementation
 */
async loadFromData(
  vocabData: Record<string, number>,
  _mergesData?: Array<string>, // Made optional
): Promise<void> {
  // ... implementation
}
```

**Effort**: Low (~15 minutes)

---

## Implementation Order

### Phase 1: Critical Fixes
1. [ ] 1.1 - Remove hardcoded developer IP
2. [ ] 1.3 - Add tensor shape validation
3. [ ] 1.5 - Improve error recovery in initialize
4. [ ] 1.6 - Add input validation in synthesizeChunk
5. [ ] 2.2 - Add volume bounds checking
6. [ ] 2.3 - Add missing return type annotations

### Phase 2: Type Safety
1. [ ] 1.2 - Create ONNX type declarations
2. [ ] 2.5 - Add voice style validation

### Phase 3: Robustness
1. [ ] 1.4 - Fix lazy loading race condition
2. [ ] 2.1 - Consolidate constants
3. [ ] 2.4 - Clean up dead/deprecated exports

### Phase 4: Code Quality
1. [ ] 2.6 - Reduce development logging
2. [ ] 3.1 - Extract text chunking utility
3. [ ] 3.2 - Extract phonemization utilities
4. [ ] 3.3 - Add comprehensive documentation
5. [ ] 3.4 - Add voice file format types
6. [ ] 3.5 - Remove unused parameter

---

## Testing Recommendations

### Unit Tests to Add
1. `VoiceLoader.getVoiceEmbedding()` - validation, bounds checking, race conditions
2. `KokoroEngine.synthesizeChunk()` - input validation, tensor shapes
3. `BPETokenizer.encode()` - edge cases, special characters
4. `splitOnPunctuation()` - boundary conditions, empty text
5. `postProcessPhonemes()` - language-specific transformations

### Integration Tests
1. Full synthesis pipeline with mock ONNX sessions
2. Voice loading with race condition scenarios (concurrent calls)
3. Multi-chunk synthesis with progress callbacks
4. Initialization failure and recovery

### Mocking Strategy
- Create mock ONNX Runtime for tests without loading real models
- Mock network requests for voice style loading tests
- Mock file system for asset loading tests

---

## Shared Utilities with Supertonic

Several utilities can be shared between Kokoro and Supertonic:

1. **ONNX Type Declarations** (`src/types/OnnxRuntime.ts`)
2. **Logger Utility** (`src/utils/logger.ts`)
3. **Text Chunker** (`src/utils/TextChunker.ts`)
4. **Audio Buffer Utilities** (volume adjustment, clipping prevention)

Consider creating a shared `src/engines/common/` directory for these.

---

## Known Limitations (Not Addressed)

### Phonemization Dependencies
- **Remote phonemizer dependency**: Requires external server for non-English languages
  - Root cause: espeak-ng not available on all platforms
  - Status: Architecture decision, not a bug
  - Mitigation: Document clearly, provide server setup guide

### Architecture Constraints
- **No resource pooling**: Multiple engines load duplicate models
  - Would require significant refactoring for shared model instances
  - Consider for future major version

---

## Asset Management Engineering

This section addresses the broader asset handling architecture that affects both Kokoro and Supertonic engines, as well as the native espeak-ng phonemizer.

### Current State Analysis

| Asset Type | iOS | Android | Consistency |
|------------|-----|---------|-------------|
| **espeak-ng-data** | Bundled via Podspec, direct access | Bundled in APK, extracted at runtime | Different access patterns |
| **ONNX models** | Manual bundle or download | Manual bundle or download | Same (but different paths) |
| **Voice files** | Lazy load from network | Lazy load from network | Consistent |
| **Tokenizer** | Local file or HuggingFace | Local file or HuggingFace | Consistent |

### Priority 1: Critical Asset Issues

#### A.1 Consolidate AssetLoader Implementations

**Problem**: Two separate AssetLoader implementations exist:
- `src/engines/kokoro/utils/AssetLoader.ts` - Uses RNFS, local files only
- `src/engines/supertonic/utils/AssetLoader.ts` - Uses fetch(), supports remote URLs

**Solution**: Create unified AssetLoader in shared location:

```typescript
// src/utils/AssetLoader.ts
import RNFS from '@dr.pogodin/react-native-fs';

export interface AssetLoaderOptions {
  /** Enable caching for remote assets */
  enableCache?: boolean;
  /** Cache directory path */
  cacheDir?: string;
  /** Timeout for network requests in ms */
  timeout?: number;
}

export class AssetLoader {
  private options: Required<AssetLoaderOptions>;
  private cache: Map<string, ArrayBuffer> = new Map();

  constructor(options: AssetLoaderOptions = {}) {
    this.options = {
      enableCache: options.enableCache ?? true,
      cacheDir: options.cacheDir ?? RNFS.CachesDirectoryPath,
      timeout: options.timeout ?? 30000,
    };
  }

  /**
   * Load asset as text from local file or remote URL
   */
  async loadText(path: string): Promise<string> {
    if (path.startsWith('file://')) {
      return this.loadLocalText(path);
    }
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return this.loadRemoteText(path);
    }
    throw new Error(`Unsupported path scheme: ${path}`);
  }

  /**
   * Load asset as ArrayBuffer from local file or remote URL
   */
  async loadArrayBuffer(path: string): Promise<ArrayBuffer> {
    if (path.startsWith('file://')) {
      return this.loadLocalArrayBuffer(path);
    }
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return this.loadRemoteArrayBuffer(path);
    }
    throw new Error(`Unsupported path scheme: ${path}`);
  }

  /**
   * Load and parse JSON from local file or remote URL
   */
  async loadJSON<T>(path: string): Promise<T> {
    const text = await this.loadText(path);
    return JSON.parse(text) as T;
  }

  // ... implementation details
}
```

**Effort**: Medium (~2 hours)

---

#### A.2 Standardize espeak-ng-data Source Management

**Problem**: Inconsistent source management between platforms:

| Aspect | iOS | Android |
|--------|-----|---------|
| **Data source** | `third-party/espeak-ng/espeak-ng-data` (submodule) | `android/src/main/assets/espeak-ng-data` |
| **Committed to git?** | NO (via submodule reference) | YES (~5MB of binary files) |
| **When prepared?** | Build time (Podspec bundles from submodule) | Pre-committed OR via `prepare-espeak-data.sh` |
| **Language subsetting** | Not supported | Manual script option |

**Current File Structure:**
```
third-party/
  espeak-ng/                    # Git submodule
    espeak-ng-data/             # Source of truth (NOT committed, fetched via submodule)
      phondata, phontab, ...    # Core files (~200KB)
      *_dict                    # Language dictionaries (~4.8MB total)

ios/
  espeak-ng -> ../third-party/espeak-ng  # Symlink to submodule
  espeak-ng-data/               # GITIGNORED - not used, Podspec references submodule directly

android/
  src/main/assets/
    espeak-ng-data/             # COMMITTED TO GIT (~5MB) - should be gitignored!
```

**Solution**: Remove committed Android data, generate at build time like iOS:

1. **Add to `.gitignore`:**
```gitignore
# espeak-ng-data should be generated from submodule, not committed
android/src/main/assets/espeak-ng-data/
```

2. **Remove committed data:**
```bash
git rm -r --cached android/src/main/assets/espeak-ng-data/
```

3. **Update Android build to auto-prepare:**

Option A: Gradle `preBuild` task (recommended):
```groovy
// android/build.gradle
task prepareEspeakData {
    def source = file("${rootProject.projectDir}/../third-party/espeak-ng/espeak-ng-data")
    def dest = file("${projectDir}/src/main/assets/espeak-ng-data")

    inputs.dir(source)
    outputs.dir(dest)

    doLast {
        if (!source.exists()) {
            throw new GradleException("espeak-ng submodule not initialized. Run: git submodule update --init")
        }
        copy {
            from source
            into dest
        }
    }
}

preBuild.dependsOn prepareEspeakData
```

Option B: npm `prepare` script (current approach, but requires manual run):
```json
{
  "scripts": {
    "prepare": "bob build && ./scripts/prepare-espeak-data.sh || true"
  }
}
```

**Recommendation**: Use Gradle task (Option A) for consistency with iOS, which auto-prepares during build.

**Effort**: Low (~1 hour)

---

#### A.3 Create Unified espeak Data TypeScript Wrapper

**Problem**:
- Different runtime access patterns (iOS: direct, Android: extraction)
- No TypeScript API to check data validity

**Solution**: Create unified espeak data management:

```typescript
// src/native/EspeakDataManager.ts
import { Platform } from 'react-native';

export interface EspeakDataConfig {
  /** Languages to include (empty = all) */
  languages?: string[];
  /** Path to custom espeak-ng-data (overrides bundled) */
  customDataPath?: string;
}

export class EspeakDataManager {
  /**
   * Get the path to espeak-ng-data for the current platform
   *
   * iOS: Returns bundle path (direct access)
   * Android: Returns extracted path (extracts on first call)
   */
  static async getDataPath(config?: EspeakDataConfig): Promise<string> {
    if (config?.customDataPath) {
      return config.customDataPath;
    }

    if (Platform.OS === 'ios') {
      return this.getIOSBundlePath();
    } else {
      return this.getAndroidExtractedPath();
    }
  }

  /**
   * Check if espeak-ng-data is available and valid
   */
  static async isDataValid(): Promise<boolean> {
    const path = await this.getDataPath();
    // Check for required files: phondata, phontab, phonindex
    // ...
  }

  /**
   * Get size of bundled espeak-ng-data
   */
  static async getDataSize(): Promise<number> {
    // Returns size in bytes for diagnostics
  }
}
```

**Native Side Changes**:

For iOS (`ios/EspeakWrapper.mm`):
```objective-c
// Already works - uses NSBundle directly
+ (NSString *)getDataPath {
  return [[NSBundle mainBundle] pathForResource:@"espeak-ng-data" ofType:nil];
}
```

For Android (`android/.../EspeakNative.kt`):
```kotlin
// Already works - extracts to filesDir
fun getDataPath(context: Context): String {
  return ensureDataPath(context)  // Extracts if needed
}
```

**Effort**: Low (~30 minutes) - mostly documentation and TypeScript wrapper

---

#### A.4 Add Language Subsetting for espeak-ng-data

**Problem**: Full espeak-ng-data is ~5MB, but most apps only need 1-2 languages.

**Solution**: Build-time configuration for language selection:

```javascript
// react-native-speech.config.js (new file in app root)
module.exports = {
  espeak: {
    // Only include these languages (reduces bundle size)
    languages: ['en'],  // ~500KB instead of ~5MB

    // Or include all (default)
    // languages: 'all',
  },
};
```

**Implementation**:

1. **iOS** - Modify Podspec to read config:
```ruby
# RNSpeech.podspec
config_file = File.join(__dir__, '..', 'react-native-speech.config.js')
if File.exist?(config_file)
  # Parse config and filter espeak-ng-data/lang/ accordingly
end
```

2. **Android** - Modify prepare script:
```bash
# scripts/prepare-espeak-data.sh
CONFIG_FILE="$PROJECT_ROOT/react-native-speech.config.js"
if [ -f "$CONFIG_FILE" ]; then
  LANGS=$(node -e "console.log(require('$CONFIG_FILE').espeak?.languages?.join(' ') || 'all')")
  if [ "$LANGS" != "all" ]; then
    # Remove non-specified language directories
    for lang_dir in "$ANDROID_ASSETS/espeak-ng-data/"*_dict; do
      lang=$(basename "$lang_dir" _dict)
      if [[ ! " $LANGS " =~ " $lang " ]]; then
        rm -rf "$lang_dir"
      fi
    done
  fi
fi
```

**Effort**: Medium (~3 hours)

---

### Priority 2: Model & Voice Asset Management

#### A.5 Add Disk Caching for Voice Files

**Problem**: Voice files are downloaded on-demand but only cached in memory. App restart requires re-download.

**Solution**: Implement persistent disk cache:

```typescript
// src/utils/VoiceCache.ts
import RNFS from '@dr.pogodin/react-native-fs';

export class VoiceCache {
  private cacheDir: string;
  private maxCacheSize: number;  // bytes

  constructor(options: { cacheDir?: string; maxCacheMB?: number } = {}) {
    this.cacheDir = options.cacheDir ?? `${RNFS.CachesDirectoryPath}/voice-cache`;
    this.maxCacheSize = (options.maxCacheMB ?? 100) * 1024 * 1024;
  }

  async get(voiceId: string): Promise<Float32Array | null> {
    const cachePath = `${this.cacheDir}/${voiceId}.bin`;

    if (await RNFS.exists(cachePath)) {
      const data = await RNFS.readFile(cachePath, 'base64');
      return new Float32Array(base64ToArrayBuffer(data));
    }

    return null;
  }

  async set(voiceId: string, data: Float32Array): Promise<void> {
    await RNFS.mkdir(this.cacheDir);

    // Evict old entries if cache is full
    await this.evictIfNeeded(data.byteLength);

    const cachePath = `${this.cacheDir}/${voiceId}.bin`;
    const base64 = arrayBufferToBase64(data.buffer);
    await RNFS.writeFile(cachePath, base64, 'base64');
  }

  async clear(): Promise<void> {
    if (await RNFS.exists(this.cacheDir)) {
      await RNFS.unlink(this.cacheDir);
    }
  }

  private async evictIfNeeded(newSize: number): Promise<void> {
    // LRU eviction based on file modification time
    // ...
  }
}
```

**Effort**: Medium (~2 hours)

---

#### A.6 Standardize Model Path Resolution

**Problem**: Apps must construct platform-specific paths for bundled models.

**Solution**: Provide helper for common patterns:

```typescript
// src/utils/ModelPaths.ts
import { Platform } from 'react-native';
import RNFS from '@dr.pogodin/react-native-fs';

export type ModelLocation = 'bundled' | 'downloaded' | 'custom';

export interface ModelPathConfig {
  location: ModelLocation;
  /** For 'bundled': filename in app bundle */
  /** For 'downloaded': subdirectory in documents */
  /** For 'custom': full file:// path */
  path: string;
}

export class ModelPaths {
  /**
   * Resolve model path for current platform
   */
  static resolve(config: ModelPathConfig): string {
    switch (config.location) {
      case 'bundled':
        return this.getBundledPath(config.path);
      case 'downloaded':
        return this.getDownloadedPath(config.path);
      case 'custom':
        return config.path;
    }
  }

  private static getBundledPath(filename: string): string {
    if (Platform.OS === 'ios') {
      return `file://${RNFS.MainBundlePath}/${filename}`;
    } else {
      // Android: extract from assets or use asset:// scheme
      return `file:///android_asset/${filename}`;
    }
  }

  private static getDownloadedPath(subpath: string): string {
    return `file://${RNFS.DocumentDirectoryPath}/${subpath}`;
  }

  /**
   * Check if a model exists at the given path
   */
  static async exists(path: string): Promise<boolean> {
    const filePath = path.replace('file://', '');
    return RNFS.exists(filePath);
  }

  /**
   * Get size of model file in bytes
   */
  static async getSize(path: string): Promise<number> {
    const filePath = path.replace('file://', '');
    const stat = await RNFS.stat(filePath);
    return stat.size;
  }
}
```

**Effort**: Low (~1 hour)

---

#### A.7 Add Model Download Manager

**Problem**: No built-in way to download models from HuggingFace with progress tracking.

**Solution**:

```typescript
// src/utils/ModelDownloader.ts
export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
}

export interface ModelDownloadConfig {
  /** HuggingFace model ID (e.g., 'onnx-community/Kokoro-82M-v1.0-ONNX') */
  modelId: string;
  /** Variant to download (e.g., 'onnx_q8') */
  variant?: string;
  /** Local directory to save files */
  destDir: string;
  /** Progress callback */
  onProgress?: (progress: DownloadProgress) => void;
}

export class ModelDownloader {
  private static HF_BASE = 'https://huggingface.co';

  /**
   * Download model files from HuggingFace
   */
  static async download(config: ModelDownloadConfig): Promise<string[]> {
    const { modelId, variant = 'onnx', destDir, onProgress } = config;

    // 1. Fetch file list from HF API
    const files = await this.getModelFiles(modelId, variant);

    // 2. Download each file with progress
    const downloadedPaths: string[] = [];
    let totalDownloaded = 0;
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    for (const file of files) {
      const destPath = `${destDir}/${file.name}`;

      await RNFS.downloadFile({
        fromUrl: file.url,
        toFile: destPath,
        progress: (res) => {
          onProgress?.({
            bytesDownloaded: totalDownloaded + res.bytesWritten,
            totalBytes: totalSize,
            percent: ((totalDownloaded + res.bytesWritten) / totalSize) * 100,
          });
        },
      }).promise;

      totalDownloaded += file.size;
      downloadedPaths.push(destPath);
    }

    return downloadedPaths;
  }

  /**
   * Get list of files for a HuggingFace model
   */
  private static async getModelFiles(
    modelId: string,
    variant: string
  ): Promise<Array<{ name: string; url: string; size: number }>> {
    // Query HF API for model files
    // ...
  }
}
```

**Effort**: Medium (~3 hours)

---

### Asset Management Summary

| Issue | Priority | Effort | Impact |
|-------|----------|--------|--------|
| A.1 Consolidate AssetLoader | High | 2h | Reduces code duplication, consistent behavior |
| A.2 Standardize espeak-ng-data source | **Critical** | 1h | Removes ~5MB from git, consistent with iOS |
| A.3 espeak TypeScript wrapper | Low | 0.5h | Better DX for data path access |
| A.4 Language subsetting | Medium | 3h | Reduces app size by ~4.5MB |
| A.5 Voice disk cache | High | 2h | Eliminates re-downloads on restart |
| A.6 Model path helper | Low | 1h | Simplifies app integration |
| A.7 Model downloader | Low | 3h | Better DX for model management |

**Total Asset Engineering Effort**: ~13.5 hours

---

## Conclusion

Since this is **pre-release code**, we have full freedom to make breaking changes and design the API correctly from the start. This refactoring plan takes advantage of that freedom to:

1. **Delete rather than deprecate** - Remove unused code, don't mark it deprecated
2. **Rename freely** - Fix naming inconsistencies without compatibility aliases
3. **Restructure modules** - Move code to proper locations without re-exports
4. **Clean comments** - Document current behavior, not historical changes

**Total estimated effort**: ~24-27 hours for all phases (including asset management)

**Breakdown**:
- Kokoro code quality fixes: ~12-15 hours
- Asset management engineering: ~12 hours

**Comparison with Supertonic**: Kokoro shares many of the same issues (type safety, validation, race conditions) but also has unique issues (RemotePhonemizer removal, excessive logging). The refactoring patterns established for Supertonic can be applied here, and several utilities can be shared between both engines.

**Shared Infrastructure** (create in `src/utils/`):
1. **ONNX Type Declarations** (`src/types/OnnxRuntime.ts`)
2. **Logger Utility** (`src/utils/logger.ts`)
3. **Text Chunker** (`src/utils/TextChunker.ts`)
4. **Asset Loader** (`src/utils/AssetLoader.ts`)
5. **Voice Cache** (`src/utils/VoiceCache.ts`)
6. **Model Paths** (`src/utils/ModelPaths.ts`)
