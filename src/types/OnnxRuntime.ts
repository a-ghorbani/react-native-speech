/**
 * Type declarations for ONNX Runtime React Native.
 *
 * These types mirror the public surface of `onnxruntime-common`
 * (re-exported by `onnxruntime-react-native`). They are defined
 * locally because `onnxruntime-react-native` is an optional peer
 * dependency and may not be installed at type-check time.
 *
 * Keep these in sync with:
 *   node_modules/onnxruntime-common/dist/cjs/inference-session.d.ts
 */

/**
 * ONNX tensor data types
 */
export type OnnxDataType =
  | 'float32'
  | 'float64'
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'bool'
  | 'string';

/**
 * ONNX Tensor interface
 * Note: data type varies based on tensor type (float32 -> Float32Array, int64 -> BigInt64Array, etc.)
 */
export interface OnnxTensor {
  /** Tensor data as typed array */
  readonly data: Float32Array | BigInt64Array | Int32Array | Uint8Array;
  /** Tensor dimensions */
  readonly dims: readonly number[];
  /** Data type */
  readonly type: OnnxDataType;
}

/**
 * ONNX Tensor constructor type
 */
export interface OnnxTensorConstructor {
  new (
    type: OnnxDataType,
    data: ArrayLike<number> | ArrayLike<bigint>,
    dims: readonly number[],
  ): OnnxTensor;
}

/**
 * ONNX inference session options
 */
export interface OnnxSessionOptions {
  /**
   * Execution providers in order of preference.
   * Each entry is either a provider name (e.g. 'cpu', 'nnapi') or a
   * provider-specific options object. Declared loosely so engine-specific
   * option interfaces (e.g. `CoreMLExecutionProviderOption`) remain
   * assignable without requiring an index signature.
   */
  executionProviders: ReadonlyArray<string | {readonly name: string}>;
}

/**
 * Execution provider configuration (e.g., CoreML options)
 */
export interface OnnxExecutionProviderConfig {
  name: string;
  // Provider-specific options (e.g. CoreML: `useCPUOnly`, `useCPUAndGPU`).
  // Typed as `unknown` to allow extension; concrete provider option types
  // live in `./Kokoro.ts`.
  [key: string]: unknown;
}

/**
 * Metadata for a single input/output of an InferenceSession.
 *
 * Shape dims are `number` for fixed dimensions and `string` for
 * symbolic/dynamic dimensions (e.g. "batch_size", "seq_len").
 *
 * Mirrors `InferenceSession.ValueMetadata` from `onnxruntime-common`.
 */
export interface OnnxValueMetadata {
  /** Name of the input/output */
  readonly name: string;
  /** True if this value is a tensor */
  readonly isTensor: boolean;
  /** Tensor element type (only valid if isTensor) */
  readonly type: OnnxDataType;
  /** Tensor shape (numbers = fixed dims, strings = symbolic/dynamic dims) */
  readonly shape: ReadonlyArray<number | string>;
}

/**
 * ONNX inference session interface
 */
export interface OnnxInferenceSession {
  /**
   * Run inference with the given input tensors
   * @param feeds - Map of input names to tensors
   * @returns Map of output names to tensors
   */
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;

  /** Names of the model inputs */
  readonly inputNames: readonly string[];

  /** Names of the model outputs */
  readonly outputNames: readonly string[];

  /**
   * Metadata for the model inputs (shape, dtype, tensor vs sequence).
   * Use to discover symbolic/dynamic input shapes at runtime.
   */
  readonly inputMetadata: readonly OnnxValueMetadata[];

  /** Metadata for the model outputs */
  readonly outputMetadata: readonly OnnxValueMetadata[];

  /**
   * Release native session resources. After calling this the session
   * must not be used.
   */
  release(): Promise<void>;
}

/**
 * ONNX inference session constructor type
 */
export interface OnnxInferenceSessionConstructor {
  /**
   * Create a new inference session from a model file
   * @param modelPath - Path to the ONNX model file
   * @param options - Session options including execution providers
   */
  create(
    modelPath: string,
    options?: OnnxSessionOptions,
  ): Promise<OnnxInferenceSession>;
}

/**
 * ONNX Runtime module interface
 */
export interface OnnxRuntimeModule {
  InferenceSession: OnnxInferenceSessionConstructor;
  Tensor: OnnxTensorConstructor;
}
