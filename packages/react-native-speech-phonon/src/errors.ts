/**
 * Phonon error mapping.
 *
 * Native rejections carry `PHONON_<ERR>` codes; the engine surfaces them
 * as `PhononError`s with stable `ERR_PHONON_*` codes. Cancellation is
 * never an error (native resolves `cancelled: true`).
 */

export type PhononErrorCode =
  | 'ERR_PHONON_UNSUPPORTED'
  | 'ERR_PHONON_LOAD'
  | 'ERR_PHONON_NOT_INITIALIZED'
  | 'ERR_PHONON_INTERNAL'
  | 'ERR_PHONON_BUFFER_LIMIT'
  | 'ERR_PHONON_VOICE'
  | 'ERR_PHONON_LANGUAGE'
  | 'ERR_PHONON_SYNTH'
  | 'ERR_PHONON_TIMEOUT';

/** Native rejection code -> JS error code. */
const NATIVE_CODES: Readonly<Record<string, PhononErrorCode>> = {
  PHONON_NOT_COMPILED: 'ERR_PHONON_UNSUPPORTED',
  PHONON_UNSUPPORTED: 'ERR_PHONON_UNSUPPORTED',
  PHONON_LOAD_FAILED: 'ERR_PHONON_LOAD',
  PHONON_INVALID_HANDLE: 'ERR_PHONON_NOT_INITIALIZED',
  PHONON_INVALID_BUFFER: 'ERR_PHONON_INTERNAL',
  PHONON_BUFFER_LIMIT: 'ERR_PHONON_BUFFER_LIMIT',
  PHONON_VOICE_NOT_FOUND: 'ERR_PHONON_VOICE',
  PHONON_LANGUAGE_UNSUPPORTED: 'ERR_PHONON_LANGUAGE',
  PHONON_SPEAK_FAILED: 'ERR_PHONON_SYNTH',
  PHONON_CALLBACK_FAILED: 'ERR_PHONON_SYNTH',
  PHONON_INTERNAL: 'ERR_PHONON_INTERNAL',
};

export class PhononError extends Error {
  readonly code: PhononErrorCode;
  /** The native `PHONON_*` code this error was mapped from, if any. */
  readonly nativeCode?: string;
  readonly cause?: unknown;

  constructor(
    code: PhononErrorCode,
    message: string,
    options?: {nativeCode?: string; cause?: unknown},
  ) {
    super(message);
    // Keep `instanceof` working whatever the class transform does.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'PhononError';
    this.code = code;
    this.nativeCode = options?.nativeCode;
    this.cause = options?.cause;
  }
}

/**
 * Phonon cannot run on this build or device. `reason` is the
 * `PhononSupportInfo.reason` (e.g. `not-compiled`, `missing-cpu-features`).
 */
export class PhononUnsupportedError extends PhononError {
  readonly reason: string;
  readonly detail: string;

  constructor(reason: string, detail = '') {
    super(
      'ERR_PHONON_UNSUPPORTED',
      `Phonon is not supported here: ${reason}${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'PhononUnsupportedError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** Native code of a rejection, if it carries one. */
export function nativeCodeOf(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as {code: unknown}).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Map any rejection to a `PhononError`. `PhononError`s pass through;
 * unknown codes and plain errors become `ERR_PHONON_INTERNAL`.
 */
export function toPhononError(e: unknown): PhononError {
  if (e instanceof PhononError) {
    return e;
  }
  const nativeCode = nativeCodeOf(e);
  const message =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : 'Unknown Phonon error';
  const code: PhononErrorCode =
    (nativeCode && NATIVE_CODES[nativeCode]) || 'ERR_PHONON_INTERNAL';
  return new PhononError(code, message, {nativeCode, cause: e});
}
