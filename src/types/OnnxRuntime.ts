/**
 * Type declarations for ONNX Runtime React Native
 *
 * These types provide proper typing for the dynamically imported
 * onnxruntime-react-native module used by neural TTS engines.
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
  /** Execution providers in order of preference */
  executionProviders: Array<string | OnnxExecutionProviderConfig>;
}

/**
 * Execution provider configuration (e.g., CoreML options)
 */
export interface OnnxExecutionProviderConfig {
  name: string;
  [key: string]: unknown;
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
