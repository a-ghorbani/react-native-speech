package com.pocketpalai.speech.phonon

/**
 * The getSupport decision sequence (DESIGN.md §2.1). Each native step is a lambda invoked only
 * when every earlier check passed, so e.g. a low-memory device never loads the shim. Nothing
 * here dlopens libptts_ffi.so.
 */
object PhononProbe {
  const val MIN_TOTAL_MEM_BYTES = 3L shl 30

  const val SKIPPED_HWCAP_GATE = "hwcap gate skipped (debug negative control)"

  data class Result(
    val supported: Boolean,
    val reason: String,
    val detail: String,
    /** The shim's compile-time ABI once loaded, else the running process's ABI. */
    val abi: String
  )

  class Inputs(
    /** Always "" in release builds. */
    val forceReason: String,
    /** A persisted negative record already matched to this device and library. */
    val capability: PhononCapabilityStore.Record?,
    /** 0 = unknown (check skipped). */
    val totalMemBytes: Long,
    val is64Bit: Boolean,
    val supportedAbis: List<String>,
    /** Build.SUPPORTED_32_BIT_ABIS: a 32-bit process runs the first of these, not SUPPORTED_ABIS[0]. */
    val supported32BitAbis: List<String> = emptyList(),
    /** ABIs whose libptts_ffi.so is packaged. */
    val packagedAbis: List<String>,
    /** Returns the failure, null on success. */
    val loadShim: () -> Throwable?,
    val nativeAbi: () -> String,
    /** ro.dalvik.vm.native.bridge. */
    val nativeBridge: () -> String?,
    /** [AT_HWCAP, AT_HWCAP2]. */
    val hwcaps: () -> LongArray,
    val requirements: () -> List<PhononCpu.Requirement>,
    /** The shim's ARM64_FEATURES (e.g. "+dotprod,+fp16"); "" if unknown. */
    val arm64Features: () -> String = { "" },
    /**
     * Debug negative control (always false in release): reports `ok` without the HWCAP check,
     * to prove the gate is what prevents SIGILL. Every other check still runs.
     */
    val skipHwcapGate: Boolean = false
  )

  fun evaluate(i: Inputs): Result {
    // A 32-bit process on an arm64 device runs armeabi-v7a although SUPPORTED_ABIS[0] is arm64-v8a.
    val deviceAbi = (if (i.is64Bit) null else i.supported32BitAbis.firstOrNull())
      ?: i.supportedAbis.firstOrNull().orEmpty()
    fun no(reason: String, detail: String, abi: String = deviceAbi) =
      Result(false, reason, detail, abi)

    if (i.forceReason.isNotEmpty()) return no(i.forceReason, "forced")
    i.capability?.let { return no(it.reason, it.detail) }
    if (i.totalMemBytes in 1 until MIN_TOTAL_MEM_BYTES) {
      return no("low-memory", "totalMem ${i.totalMemBytes shr 20} MB < ${MIN_TOTAL_MEM_BYTES shr 20} MB")
    }

    val loadError = i.loadShim()
    if (loadError != null) {
      // The shim is 64-bit only; in a 64-bit process it was not packaged (or AGP < 8.5.1 on a
      // 16 KB-page kernel).
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
    if (i.skipHwcapGate) {
      return Result(true, "ok", SKIPPED_HWCAP_GATE, abi)
    }
    val caps = i.hwcaps()
    val required = try {
      i.requirements()
    } catch (e: Exception) {
      return no("error", "HWCAP gate unavailable: ${e.message ?: e.javaClass.simpleName}", abi)
    }
    // Fail closed: arm64 features with no requirements means the gate itself is broken.
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
