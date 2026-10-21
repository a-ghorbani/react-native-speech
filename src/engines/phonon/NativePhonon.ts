/**
 * NativePhonon - the only module that touches `TurboSpeech.phonon*`.
 *
 * A thin, guarded pass-through to the TurboModule. Every method checks
 * that its native counterpart exists, so new JS on an older native build
 * (e.g. an OTA update) degrades to `not-compiled` instead of throwing a
 * TypeError. Tests mock this module rather than the TurboModule.
 *
 * Native ids (request, handle, buffer) are plain JS numbers; they are
 * issued natively and stay well below 2^53.
 */

import TurboSpeech from '../../NativeSpeech';
import type {
  PhononDiagnostics,
  PhononLoadOptions,
  PhononLoadResult,
  PhononPlayConfig,
  PhononSupportInfo,
  PhononSynthResult,
} from '../../NativeSpeech';

/** Rejection code when Phonon is not in this native build. */
export const PHONON_NOT_COMPILED = 'PHONON_NOT_COMPILED';

/** Support info reported when the native methods are missing. */
export const NOT_COMPILED_SUPPORT: Readonly<PhononSupportInfo> = Object.freeze({
  supported: false,
  reason: 'not-compiled',
  detail: 'Phonon native methods are not present in this build',
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
  | 'phononGetSupport'
  | 'phononNeedsCompile'
  | 'phononCreate'
  | 'phononAllocRequestId'
  | 'phononSynthesize'
  | 'phononCancel'
  | 'phononCancelAll'
  | 'phononPlayBuffer'
  | 'phononCopyBuffer'
  | 'phononReleaseBuffer'
  | 'phononDestroy'
  | 'phononGetDiagnostics'
  | 'phononResetSupport';

function has(method: PhononMethod): boolean {
  return (
    TurboSpeech != null &&
    typeof (TurboSpeech as unknown as Record<string, unknown>)[method] ===
      'function'
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
  return has('phononGetSupport');
}

/**
 * Cheap capability probe. Resolves `not-compiled` when the native method
 * is missing; native rejections propagate to the caller.
 */
export function getSupport(): Promise<PhononSupportInfo> {
  if (!has('phononGetSupport')) {
    return Promise.resolve({...NOT_COMPILED_SUPPORT});
  }
  return TurboSpeech.phononGetSupport();
}

export function needsCompile(modelDir: string): Promise<boolean> {
  if (!has('phononNeedsCompile')) {
    return Promise.reject(notCompiled('phononNeedsCompile'));
  }
  return TurboSpeech.phononNeedsCompile(modelDir);
}

export function create(
  modelDir: string,
  options: PhononLoadOptions,
): Promise<PhononLoadResult> {
  if (!has('phononCreate')) {
    return Promise.reject(notCompiled('phononCreate'));
  }
  return TurboSpeech.phononCreate(modelDir, options);
}

/**
 * Synchronous. Returns a process-wide, monotonic request id (>= 1), or 0
 * when Phonon is not compiled in.
 */
export function allocRequestId(): number {
  if (!has('phononAllocRequestId')) {
    return 0;
  }
  return TurboSpeech.phononAllocRequestId();
}

export function synthesize(
  handleId: number,
  requestId: number,
  text: string,
  voice: string,
  language: string,
): Promise<PhononSynthResult> {
  if (!has('phononSynthesize')) {
    return Promise.reject(notCompiled('phononSynthesize'));
  }
  return TurboSpeech.phononSynthesize(
    handleId,
    requestId,
    text,
    voice,
    language,
  );
}

/** Synchronous. Cancels every request id <= upToRequestId. */
export function cancelUpTo(upToRequestId: number): boolean {
  if (!has('phononCancel')) {
    return false;
  }
  return TurboSpeech.phononCancel(upToRequestId);
}

/** Synchronous. Cancels every id issued so far. */
export function cancelAll(): boolean {
  if (!has('phononCancelAll')) {
    return false;
  }
  return TurboSpeech.phononCancelAll();
}

/** Plays and consumes the buffer. */
export function playBuffer(
  bufferId: number,
  config: PhononPlayConfig,
): Promise<void> {
  if (!has('phononPlayBuffer')) {
    return Promise.reject(notCompiled('phononPlayBuffer'));
  }
  return TurboSpeech.phononPlayBuffer(bufferId, config);
}

/** Base64 little-endian float32 copy; the buffer stays in the store. */
export function copyBuffer(bufferId: number): Promise<string> {
  if (!has('phononCopyBuffer')) {
    return Promise.reject(notCompiled('phononCopyBuffer'));
  }
  return TurboSpeech.phononCopyBuffer(bufferId);
}

/** Synchronous and idempotent. */
export function releaseBuffer(bufferId: number): boolean {
  if (!has('phononReleaseBuffer')) {
    return false;
  }
  return TurboSpeech.phononReleaseBuffer(bufferId);
}

export function destroy(handleId: number): Promise<void> {
  if (!has('phononDestroy')) {
    return Promise.resolve();
  }
  return TurboSpeech.phononDestroy(handleId);
}

/** Resolves all-zero diagnostics (`libraryLoaded:false`) when not compiled. */
export function getDiagnostics(): Promise<PhononDiagnostics> {
  if (!has('phononGetDiagnostics')) {
    return Promise.resolve({...NOT_COMPILED_DIAGNOSTICS});
  }
  return TurboSpeech.phononGetDiagnostics();
}

/**
 * Clears the persisted capability record and the native cached probe.
 * Resolves false when the native method is missing (nothing to clear).
 */
export function resetSupport(): Promise<boolean> {
  if (!has('phononResetSupport')) {
    return Promise.resolve(false);
  }
  return TurboSpeech.phononResetSupport();
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
