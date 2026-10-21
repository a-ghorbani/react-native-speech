package com.pocketpalai.speech.phonon

/**
 * The getSupport decision sequence (DESIGN.md §2.1), separated from the Android calls that
 * feed it so the order and every outcome are unit tested. Each native step is a lambda and is
 * only invoked when every earlier check passed: in particular the shim is never loaded on a
 * low-memory device or when a record / forced reason already decided, and nothing here ever
 * dlopens libptts_ffi.so (that happens in phononCreate, after this gate).
 */
object PhononProbe {
  /** ActivityManager.MemoryInfo.totalMem floor. */
  const val MIN_TOTAL_MEM_BYTES = 3L shl 30

  data class Result(
    val supported: Boolean,
    val reason: String,
    val detail: String,
    /** The shim's compile-time ABI once loaded, else the device's primary ABI. */
    val abi: String
  )

  class Inputs(
    /** BuildConfig.RN_SPEECH_PHONON_FORCE_REASON (always "" in release builds). */
    val forceReason: String,
    /** A persisted negative record already matched to this device and library. */
    val capability: PhononCapabilityStore.Record?,
    /** 0 = unknown (check skipped). */
    val totalMemBytes: Long,
    val is64Bit: Boolean,
    /** Build.SUPPORTED_ABIS. */
    val supportedAbis: List<String>,
    /** BuildConfig.RN_SPEECH_PHONON_ABIS: ABIs whose libptts_ffi.so is packaged. */
    val packagedAbis: List<String>,
    /** System.loadLibrary("rnspeech_phonon"); returns the failure, null on success. */
    val loadShim: () -> Throwable?,
    val nativeAbi: () -> String,
    /** ro.dalvik.vm.native.bridge. */
    val nativeBridge: () -> String?,
    /** [AT_HWCAP, AT_HWCAP2]. */
    val hwcaps: () -> LongArray,
    val requirements: () -> List<PhononCpu.Requirement>,
    /** The shim's ARM64_FEATURES (e.g. "+dotprod,+fp16"); "" if unknown. */
    val arm64Features: () -> String = { "" }
  )

  fun evaluate(i: Inputs): Result {
    val deviceAbi = i.supportedAbis.firstOrNull().orEmpty()
    fun no(reason: String, detail: String, abi: String = deviceAbi) =
      Result(false, reason, detail, abi)

    if (i.forceReason.isNotEmpty()) return no(i.forceReason, "forced")
    i.capability?.let { return no(it.reason, it.detail) }
    if (i.totalMemBytes in 1 until MIN_TOTAL_MEM_BYTES) {
      return no("low-memory", "totalMem ${i.totalMemBytes shr 20} MB < ${MIN_TOTAL_MEM_BYTES shr 20} MB")
    }

    val loadError = i.loadShim()
    if (loadError != null) {
      // The shim is only built for 64-bit ABIs; a 64-bit process without it means the app
      // was packaged without it (or AGP < 8.5.1 on a 16 KB-page kernel).
      return if (!i.is64Bit) {
        no("unsupported-abi", "32-bit process ($deviceAbi)")
      } else {
        no("library-missing", loadError.message ?: loadError.javaClass.simpleName)
      }
    }

    val abi = i.nativeAbi()
    if (abi !in i.packagedAbis) {
      return no("unsupported-abi", "no Phonon binary for $abi (packaged: ${i.packagedAbis.joinToString(",")})", abi)
    }
    if (PhononCpu.isTranslated(abi, i.supportedAbis, i.nativeBridge())) {
      return no("translated-abi", "arm64 under translation (abis ${i.supportedAbis.joinToString(",")})", abi)
    }
    val caps = i.hwcaps()
    val required = try {
      i.requirements()
    } catch (e: Exception) {
      return no("error", "HWCAP gate unavailable: ${e.message ?: e.javaClass.simpleName}", abi)
    }
    // Fail closed: an arm64 build compiled with extra features always has requirements, so an
    // empty list means the gate itself is broken, not that nothing is needed.
    if (abi == "arm64-v8a" && required.isEmpty() && i.arm64Features().isNotBlank()) {
      return no("error", "no HWCAP requirements for arm64 features ${i.arm64Features()}", abi)
    }
    val missing = PhononCpu.missing(caps.getOrElse(0) { 0L }, caps.getOrElse(1) { 0L }, required)
    if (missing.isNotEmpty()) {
      return no("missing-cpu-features", "missing ${missing.joinToString(",")}", abi)
    }
    return Result(true, "ok", "", abi)
  }
}
