package com.pocketpalai.speech.phonon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhononCpuTest {
  companion object {
    // arch/arm64/include/uapi/asm/hwcap.h bit numbers of the AT_HWCAP word.
    private val HWCAP_BITS = listOf(
      "fp", "asimd", "evtstrm", "aes", "pmull", "sha1", "sha2", "crc32", "atomics", "fphp",
      "asimdhp", "cpuid", "asimdrdm", "jscvt", "fcma", "lrcpc", "dcpop", "sha3", "sm3", "sm4",
      "asimddp", "sha512", "sve", "asimdfhm", "dit", "uscat", "ilrcpc", "flagm", "ssbs", "sb",
      "paca", "pacg"
    ).withIndex().associate { (i, name) -> name to (1L shl i) }

    /** AT_HWCAP as the kernel would report a /proc/cpuinfo "Features" line. */
    fun hwcapOf(features: String): Long =
      features.split(" ").filter { it.isNotBlank() }.fold(0L) { acc, f -> acc or (HWCAP_BITS[f] ?: 0L) }

    /**
     * What phonon_jni.cpp's nativeRequiredHwcaps returns for the header
     * gen-hwcaps-header.sh writes from ARM64_FEATURES="+dotprod,+fp16" (the lock's list):
     * X(1, HWCAP_ASIMDDP, "asimddp") X(1, HWCAP_FPHP, "fphp") X(1, HWCAP_ASIMDHP, "asimdhp").
     */
    val DOTPROD_FP16 = arrayOf(
      "1:${1L shl 20}:asimddp",
      "1:${1L shl 9}:fphp",
      "1:${1L shl 10}:asimdhp"
    )

    // /proc/cpuinfo Features of the device matrix (DESIGN.md §8.2).
    const val PIXEL9 = "fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid " +
      "asimdrdm jscvt fcma lrcpc dcpop sha3 sm3 sm4 asimddp sha512 asimdfhm dit uscat ilrcpc " +
      "flagm ssbs sb paca pacg"
    const val S23 = "fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid " +
      "asimdrdm jscvt fcma lrcpc dcpop sha3 sm3 sm4 asimddp sha512 asimdfhm dit uscat ilrcpc " +
      "flagm ssbs sb paca pacg"
    const val SD845 = "fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid " +
      "asimdrdm lrcpc dcpop"
    const val A53 = "fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid"
  }

  private val required = PhononCpu.parseRequirements(DOTPROD_FP16)

  @Test
  fun parsesGeneratedRequirements() {
    assertEquals(
      listOf(
        PhononCpu.Requirement(1, 1L shl 20, "asimddp"),
        PhononCpu.Requirement(1, 1L shl 9, "fphp"),
        PhononCpu.Requirement(1, 1L shl 10, "asimdhp")
      ),
      required
    )
    // Off aarch64 the header has no requirements.
    assertEquals(emptyList<PhononCpu.Requirement>(), PhononCpu.parseRequirements(emptyArray()))
    // Bit 63 is an unsigned value.
    assertEquals(Long.MIN_VALUE, PhononCpu.parseRequirements(arrayOf("2:9223372036854775808:x"))[0].bit)
  }

  @Test(expected = IllegalStateException::class)
  fun nullListIsAnErrorNotNoRequirements() {
    // The shim returns null when it failed to build the list: fail closed.
    PhononCpu.parseRequirements(null)
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsMalformedEntry() {
    PhononCpu.parseRequirements(arrayOf("1:abc"))
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsUnknownWord() {
    PhononCpu.parseRequirements(arrayOf("3:1:x"))
  }

  @Test
  fun hwcapMatrix() {
    assertEquals(emptyList<String>(), PhononCpu.missing(hwcapOf(PIXEL9), 0, required))
    assertEquals(emptyList<String>(), PhononCpu.missing(hwcapOf(S23), 0, required))
    // OnePlus 6 (SD845): fp16 but no dot product.
    assertEquals(listOf("asimddp"), PhononCpu.missing(hwcapOf(SD845), 0, required))
    // Cortex-A53 class: neither.
    assertEquals(listOf("asimddp", "fphp", "asimdhp"), PhononCpu.missing(hwcapOf(A53), 0, required))
    // x86_64: the header requires nothing.
    assertEquals(emptyList<String>(), PhononCpu.missing(0, 0, emptyList()))
  }

  @Test
  fun hwcap2WordIsChecked() {
    val req = listOf(PhononCpu.Requirement(2, 1L shl 4, "i8mm"))
    assertEquals(listOf("i8mm"), PhononCpu.missing(-1L, 0L, req))
    assertEquals(emptyList<String>(), PhononCpu.missing(0L, 1L shl 4, req))
  }

  @Test
  fun zeroBitRequirementFailsClosed() {
    assertEquals(listOf("bogus"), PhononCpu.missing(-1L, -1L, listOf(PhononCpu.Requirement(1, 0L, "bogus"))))
  }

  @Test
  fun translationDetection() {
    // Real arm64 phone.
    assertFalse(PhononCpu.isTranslated("arm64-v8a", listOf("arm64-v8a"), ""))
    assertFalse(PhononCpu.isTranslated("arm64-v8a", listOf("arm64-v8a", "armeabi-v7a"), "0"))
    assertFalse(PhononCpu.isTranslated("arm64-v8a", listOf("arm64-v8a"), null))
    // ChromeOS / WSA / Waydroid: x86 primary ABI with an ARM bridge.
    assertTrue(PhononCpu.isTranslated("arm64-v8a", listOf("x86_64", "x86", "arm64-v8a"), "libndk_translation.so"))
    assertTrue(PhononCpu.isTranslated("arm64-v8a", listOf("x86_64", "arm64-v8a"), ""))
    // Bridge property set even though the primary ABI is reported as arm64.
    assertTrue(PhononCpu.isTranslated("arm64-v8a", listOf("arm64-v8a"), "libhoudini.so"))
    // A native x86_64 shim is never "translated".
    assertFalse(PhononCpu.isTranslated("x86_64", listOf("x86_64", "arm64-v8a"), "libndk_translation.so"))
  }
}
