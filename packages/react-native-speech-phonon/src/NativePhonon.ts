/**
 * NativePhonon - the only module that touches the `RNSpeechPhonon` TurboModule.
 *
 * Every method checks that its native counterpart exists, so JS without
 * the linked native module (or new JS on an older native build, e.g. an
 * OTA update) degrades to `not-compiled` instead of throwing a TypeError.
 * Tests mock this module rather than the TurboModule.
 *
 * Native ids (request, handle, buffer) are plain JS numbers; they are
 * issued natively and stay well below 2^53.
 */

import NativeSpeechPhonon, {type Spec} from './NativeSpeechPhonon';
import type {
  PhononDiagnostics,
  PhononLoadOptions,
  PhononLoadResult,
  PhononPlayConfig,
  PhononSupportInfo,
  PhononSynthResult,
} from './NativeSpeechPhonon';

// Non-null: every call below is guarded by has().
const native = NativeSpeechPhonon as Spec;

/** Rejection code when Phonon is not in this native build. */
export const PHONON_NOT_COMPILED = 'PHONON_NOT_COMPILED';

/** Support info reported when the native methods are missing. */
export const NOT_COMPILED_SUPPORT: Readonly<PhononSupportInfo> = Object.freeze({
  supported: false,
  reason: 'not-compiled',
  detail: 'The RNSpeechPhonon native module is not linked into this build',
  abi: '',
  osVersion: '',
  libraryVersion: '',
  isSimulator: false,
  pageSize: 0,
});

/** Diagnostics reported when the native methods are missing. */
export const NOT_COMPILED_DIAGNOSTICS: Readonly<PhononDiagnostics> =
  Object.freeze({
    memKb: 0,
    peakMemKb: 0,
    threads: 0,
    libraryLoaded: false,
    handleOpen: false,
    liveBuffers: 0,
    orphanBuffers: 0,
    busy: 'idle',
    lastIssuedId: 0,
    cancelWatermark: 0,
  });

type PhononMethod =
  | 'getSupport'
  | 'needsCompile'
  | 'create'
  | 'allocRequestId'
  | 'synthesize'
  | 'cancel'
  | 'cancelAll'
  | 'playBuffer'
  | 'copyBuffer'
  | 'releaseBuffer'
  | 'destroy'
  | 'getDiagnostics'
  | 'resetSupport';

function has(method: PhononMethod): boolean {
  return (
    NativeSpeechPhonon != null &&
    typeof (NativeSpeechPhonon as unknown as Record<string, unknown>)[
      method
    ] === 'function'
  );
}

function notCompiled(method: PhononMethod): Error & {code: string} {
  const error = new Error(
    `Phonon is not compiled into this build (${method} missing)`,
  ) as Error & {code: string};
  error.code = PHONON_NOT_COMPILED;
  return error;
}

/** True if this native build exposes the Phonon methods at all. */
export function isPresent(): boolean {
  return has('getSupport');
}

/**
 * Cheap capability probe. Resolves `not-compiled` when the native method
 * is missing; native rejections propagate to the caller.
 */
export function getSupport(): Promise<PhononSupportInfo> {
  if (!has('getSupport')) {
    return Promise.resolve({...NOT_COMPILED_SUPPORT});
  }
  return native.getSupport();
}

export function needsCompile(modelDir: string): Promise<boolean> {
  if (!has('needsCompile')) {
    return Promise.reject(notCompiled('needsCompile'));
  }
  return native.needsCompile(modelDir);
}

export function create(
  modelDir: string,
  options: PhononLoadOptions,
): Promise<PhononLoadResult> {
  if (!has('create')) {
    return Promise.reject(notCompiled('create'));
  }
  return native.create(modelDir, options);
}

/**
 * Synchronous. Returns a process-wide, monotonic request id (>= 1), or 0
 * when Phonon is not compiled in.
 */
export function allocRequestId(): number {
  if (!has('allocRequestId')) {
    return 0;
  }
  return native.allocRequestId();
}

export function synthesize(
  handleId: number,
  requestId: number,
  text: string,
  voice: string,
  language: string,
): Promise<PhononSynthResult> {
  if (!has('synthesize')) {
    return Promise.reject(notCompiled('synthesize'));
  }
  return native.synthesize(handleId, requestId, text, voice, language);
}

/** Synchronous. Cancels every request id <= upToRequestId. */
export function cancelUpTo(upToRequestId: number): boolean {
  if (!has('cancel')) {
    return false;
  }
  return native.cancel(upToRequestId);
}

/** Synchronous. Cancels every id issued so far. */
export function cancelAll(): boolean {
  if (!has('cancelAll')) {
    return false;
  }
  return native.cancelAll();
}

/** Plays and consumes the buffer. */
export function playBuffer(
  bufferId: number,
  config: PhononPlayConfig,
): Promise<void> {
  if (!has('playBuffer')) {
    return Promise.reject(notCompiled('playBuffer'));
  }
  return native.playBuffer(bufferId, config);
}

/** Base64 little-endian float32 copy; the buffer stays in the store. */
export function copyBuffer(bufferId: number): Promise<string> {
  if (!has('copyBuffer')) {
    return Promise.reject(notCompiled('copyBuffer'));
  }
  return native.copyBuffer(bufferId);
}

/** Synchronous and idempotent. */
export function releaseBuffer(bufferId: number): boolean {
  if (!has('releaseBuffer')) {
    return false;
  }
  return native.releaseBuffer(bufferId);
}

export function destroy(handleId: number): Promise<void> {
  if (!has('destroy')) {
    return Promise.resolve();
  }
  return native.destroy(handleId);
}

/** Resolves all-zero diagnostics (`libraryLoaded:false`) when not compiled. */
export function getDiagnostics(): Promise<PhononDiagnostics> {
  if (!has('getDiagnostics')) {
    return Promise.resolve({...NOT_COMPILED_DIAGNOSTICS});
  }
  return native.getDiagnostics();
}

/**
 * Clears the persisted capability record and the native cached probe.
 * Resolves false when the native method is missing (nothing to clear).
 */
export function resetSupport(): Promise<boolean> {
  if (!has('resetSupport')) {
    return Promise.resolve(false);
  }
  return native.resetSupport();
}

const NativePhonon = {
  isPresent,
  getSupport,
  needsCompile,
  create,
  allocRequestId,
  synthesize,
  cancelUpTo,
  cancelAll,
  playBuffer,
  copyBuffer,
  releaseBuffer,
  destroy,
  getDiagnostics,
  resetSupport,
};

export default NativePhonon;
