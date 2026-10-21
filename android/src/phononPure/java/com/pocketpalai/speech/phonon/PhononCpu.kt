package com.pocketpalai.speech.phonon

/**
 * CPU feature and translation checks for the probe. Required bits come from the generated
 * phonon_required_hwcaps.h, i.e. the ARM64_FEATURES libptts_ffi.so was compiled with.
 */
object PhononCpu {
  /** One required bit: [word] 1 = AT_HWCAP, 2 = AT_HWCAP2; [name] as /proc/cpuinfo prints it. */
  data class Requirement(val word: Int, val bit: Long, val name: String)

  /** Parses "<word>:<bit>:<name>" entries; null or malformed throws, so the gate fails closed. */
  fun parseRequirements(entries: Array<String>?): List<Requirement> =
    checkNotNull(entries) { "hwcap requirements unavailable from the shim" }.map { entry ->
      val parts = entry.split(":", limit = 3)
      require(parts.size == 3) { "bad hwcap entry '$entry'" }
      val word = parts[0].toInt()
      require(word == 1 || word == 2) { "bad hwcap word in '$entry'" }
      // Unsigned decimal: bit 63 does not fit a signed parse.
      Requirement(word, java.lang.Long.parseUnsignedLong(parts[1]), parts[2])
    }

  fun missing(hwcap: Long, hwcap2: Long, required: List<Requirement>): List<String> =
    required
      .filter { req ->
        val have = if (req.word == 1) hwcap else hwcap2
        req.bit == 0L || (have and req.bit) != req.bit
      }
      .map { it.name }

  /**
   * arm64 under binary translation (ChromeOS, Waydroid, WSA): HWCAP describes the translator,
   * not the silicon, and performance is unusable.
   */
  fun isTranslated(nativeAbi: String, supportedAbis: List<String>, nativeBridge: String?): Boolean {
    if (nativeAbi != "arm64-v8a") return false
    if (supportedAbis.firstOrNull()?.startsWith("x86") == true) return true
    val bridge = nativeBridge?.trim().orEmpty()
    return bridge.isNotEmpty() && bridge != "0"
  }
}
