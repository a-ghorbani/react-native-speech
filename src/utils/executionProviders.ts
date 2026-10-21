/**
 * Default ONNX execution providers when the caller doesn't specify any.
 *
 *   - iOS: CoreML (Metal/ANE) with sensible flags, xnnpack second, bare
 *     CPU last.
 *   - Android: xnnpack + CPU. NNAPI was removed (deprecated in Android
 *     15) and there is no other public GPU/NPU EP exposed by
 *     `onnxruntime-react-native`.
 *   - Android on x86/x86_64 (emulators, Chromebooks): CPU only. ONNX
 *     Runtime segfaults creating an XNNPACK session there, and a native
 *     crash can't fall back to the next provider.
 */
import {Platform, TurboModuleRegistry} from 'react-native';
import type {Spec} from '../NativeSpeech';
import {DEFAULT_COREML_FLAGS, type ExecutionProvider} from '../types/Kokoro';

/** Primary Android ABI (e.g. `arm64-v8a`), or undefined when unknown. */
function primaryAbi(): string | undefined {
  // `get`, not `getEnforcing`: engines also run without the native module
  // (unit tests), where the ABI is simply unknown.
  return TurboModuleRegistry.get<Spec>('RNSpeech')?.getConstants().primaryAbi;
}

export function getDefaultExecutionProviders(): ExecutionProvider[] {
  if (Platform.OS === 'ios') {
    return [
      {name: 'coreml', coreMlFlags: DEFAULT_COREML_FLAGS},
      'xnnpack',
      'cpu',
    ];
  }
  if (primaryAbi()?.startsWith('x86')) {
    return ['cpu'];
  }
  return ['xnnpack', 'cpu'];
}
