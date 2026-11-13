/**
 * Default ONNX execution providers when the caller doesn't specify any.
 *
 *   - iOS: bare CPU, for every engine. On an iPhone 13 Pro, CoreML (default
 *     flags) was never faster and used several times the memory: Supertonic
 *     v3 grew past the 3 GB limit and iOS killed the app (#115), Kokoro used
 *     ~3-4x the memory, and its fp16/q8f16 models failed in the first
 *     run (#150). xnnpack was no faster than the bare CPU.
 *   - Android: xnnpack + CPU. NNAPI was removed (deprecated in Android
 *     15) and there is no other public GPU/NPU EP exposed by
 *     `onnxruntime-react-native`.
 *   - Android on x86/x86_64 (emulators, Chromebooks): CPU only. ONNX
 *     Runtime segfaults creating an XNNPACK session there, and a native
 *     crash can't fall back to the next provider.
 */
import {Platform, TurboModuleRegistry} from 'react-native';
import type {Spec} from '../NativeSpeech';
import type {ExecutionProvider} from '../types/Kokoro';

/** Primary Android ABI (e.g. `arm64-v8a`), or undefined when unknown. */
function primaryAbi(): string | undefined {
  // `get`, not `getEnforcing`: engines also run without the native module
  // (unit tests), where the ABI is simply unknown.
  return TurboModuleRegistry.get<Spec>('RNSpeech')?.getConstants().primaryAbi;
}

export function getDefaultExecutionProviders(): ExecutionProvider[] {
  if (Platform.OS === 'ios' || primaryAbi()?.startsWith('x86')) {
    return ['cpu'];
  }
  return ['xnnpack', 'cpu'];
}
