package com.pocketpalai.speech.phonon

/**
 * JNI surface of librnspeech_phonon.so (android/src/main/cpp/phonon/phonon_jni.cpp). Only
 * PhononBridge calls these, and only after it loaded the shim. The probes are cheap and safe
 * on any CPU; [nativeLoadLibrary] dlopens libptts_ffi.so and must only run after the HWCAP
 * gate. Kept by proguard-rules.pro (native method names must survive R8).
 */
object PhononNative {
  const val SHIM = "rnspeech_phonon"
  const val LIBRARY = "libptts_ffi.so"

  // ---- probes ----
  @JvmStatic external fun nativeAbi(): String
  @JvmStatic external fun nativeHwcap(): Long
  @JvmStatic external fun nativeHwcap2(): Long
  @JvmStatic external fun nativeRequiredHwcaps(): Array<String>?
  @JvmStatic external fun nativeArm64Features(): String
  @JvmStatic external fun nativeSystemProperty(name: String): String?
  @JvmStatic external fun nativeMonotonicMs(): Double

  // ---- library + synth thread ----
  /** [reason, detail]; reason "ok" | "library-missing" | "symbols-missing". */
  @JvmStatic external fun nativeLoadLibrary(soname: String): Array<String>?
  @JvmStatic external fun nativeLibraryLoaded(): Boolean
  /** See PhononResults.load for the layout. */
  @JvmStatic external fun nativeCreate(dir: String, language: String, computeUnit: String): Array<Any?>?
  /** Fills [out] (PhononResults.SYNTH_FIELDS doubles); returns [code, message]. */
  @JvmStatic external fun nativeSynthesize(
    handleId: Long,
    requestId: Long,
    text: String,
    voice: String,
    language: String,
    enqueuedAtMs: Double,
    out: DoubleArray
  ): Array<String>?
  /** Error code, "" on success. */
  @JvmStatic external fun nativeDestroy(handleId: Long): String

  // ---- ids / cancel (lock-free) ----
  @JvmStatic external fun nativeAllocRequestId(): Long
  @JvmStatic external fun nativeCancelUpTo(id: Long)
  @JvmStatic external fun nativeCancelAll()

  // ---- buffers ----
  @JvmStatic external fun nativeTakePcm16(bufferId: Long, gain: Float): ByteArray?
  @JvmStatic external fun nativeCopyFloat32(bufferId: Long): ByteArray?
  @JvmStatic external fun nativeReleaseBuffer(bufferId: Long): Boolean
  @JvmStatic external fun nativeReleaseOrphans(): Int
  @JvmStatic external fun nativeDiagnostics(): LongArray?
  @JvmStatic external fun nativeBusy(): String
}
