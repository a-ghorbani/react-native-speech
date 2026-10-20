package com.pocketpalai.speech.phonon

/**
 * CPU feature and translation checks for the Phonon probe. Pure functions (no Android APIs),
 * so the HWCAP matrix is unit tested on the JVM. The required bits come from the shim's
 * generated phonon_required_hwcaps.h (scripts/phonon/gen-hwcaps-header.sh), i.e. from the
 * same ARM64_FEATURES libptts_ffi.so was compiled with.
 */
object PhononCpu {
  /** One required bit: [word] 1 = AT_HWCAP, 2 = AT_HWCAP2; [name] as /proc/cpuinfo prints it. */
  data class Requirement(val word: Int, val bit: Long, val name: String)

  /** Parses the shim's "<word>:<bit>:<name>" entries. Malformed entries are an error. */
  fun parseRequirements(entries: Array<String>?): List<Requirement> =
    (entries ?: emptyArray()).map { entry ->
      val parts = entry.split(":", limit = 3)
      require(parts.size == 3) { "bad hwcap entry '$entry'" }
      val word = parts[0].toInt()
      require(word == 1 || word == 2) { "bad hwcap word in '$entry'" }
      // Unsigned decimal: bit 63 does not fit a signed parse.
      Requirement(word, java.lang.Long.parseUnsignedLong(parts[1]), parts[2])
    }

  /** Names of the required features missing from (hwcap, hwcap2); empty = all present. */
  fun missing(hwcap: Long, hwcap2: Long, required: List<Requirement>): List<String> =
    required
      .filter { req ->
        val have = if (req.word == 1) hwcap else hwcap2
        req.bit == 0L || (have and req.bit) != req.bit
      }
      .map { it.name }

  /**
   * True when an arm64 shim runs under binary translation on an x86 host (ChromeOS
   * ndk_translation / houdini, Waydroid, WSA): HWCAP values there describe the translator,
   * not real silicon, and performance is unusable.
   */
  fun isTranslated(nativeAbi: String, supportedAbis: List<String>, nativeBridge: String?): Boolean {
    if (nativeAbi != "arm64-v8a") return false
    if (supportedAbis.firstOrNull()?.startsWith("x86") == true) return true
    val bridge = nativeBridge?.trim().orEmpty()
    return bridge.isNotEmpty() && bridge != "0"
  }
}
