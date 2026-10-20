package com.pocketpalai.speech.phonon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The getSupport sequence: every reason, and which native steps each one touches. */
class PhononProbeTest {
  private val calls = mutableListOf<String>()

  private fun inputs(
    forceReason: String = "",
    capability: PhononCapabilityStore.Record? = null,
    totalMem: Long = 8L shl 30,
    is64Bit: Boolean = true,
    supportedAbis: List<String> = listOf("arm64-v8a"),
    packagedAbis: List<String> = listOf("arm64-v8a"),
    shimError: Throwable? = null,
    nativeAbi: String = "arm64-v8a",
    nativeBridge: String? = "",
    features: String = PhononCpuTest.PIXEL9,
    required: Array<String> = PhononCpuTest.DOTPROD_FP16
  ) = PhononProbe.Inputs(
    forceReason = forceReason,
    capability = capability,
    totalMemBytes = totalMem,
    is64Bit = is64Bit,
    supportedAbis = supportedAbis,
    packagedAbis = packagedAbis,
    loadShim = { calls += "loadShim"; shimError },
    nativeAbi = { calls += "nativeAbi"; nativeAbi },
    nativeBridge = { calls += "nativeBridge"; nativeBridge },
    hwcaps = { calls += "hwcaps"; longArrayOf(PhononCpuTest.hwcapOf(features), 0L) },
    requirements = { PhononCpu.parseRequirements(required) }
  )

  private fun eval(i: PhononProbe.Inputs) = PhononProbe.evaluate(i)

  @Test
  fun supportedDevice() {
    val r = eval(inputs())
    assertTrue(r.supported)
    assertEquals("ok", r.reason)
    assertEquals("arm64-v8a", r.abi)
    assertEquals(listOf("loadShim", "nativeAbi", "nativeBridge", "hwcaps"), calls)
  }

  @Test
  fun forcedReasonWinsAndTouchesNothing() {
    for (reason in listOf("low-memory", "library-missing", "symbols-missing", "load-failed")) {
      calls.clear()
      val r = eval(inputs(forceReason = reason))
      assertFalse(r.supported)
      assertEquals(reason, r.reason)
      assertEquals("forced", r.detail)
      assertEquals(emptyList<String>(), calls)
    }
  }

  @Test
  fun persistedRecordSkipsNativeWork() {
    val rec = PhononCapabilityStore.Record("fp", "0.4.0-r1", "", "symbols-missing", "missing symbols: ptts_free", 1)
    val r = eval(inputs(capability = rec))
    assertEquals(PhononProbe.Result(false, "symbols-missing", "missing symbols: ptts_free", "arm64-v8a"), r)
    assertEquals(emptyList<String>(), calls)
  }

  @Test
  fun lowMemoryBeforeAnyNativeLoad() {
    val r = eval(inputs(totalMem = (3L shl 30) - 1))
    assertEquals("low-memory", r.reason)
    assertEquals(emptyList<String>(), calls)
    // Exactly 3 GiB passes; unknown (0) skips the check.
    assertTrue(eval(inputs(totalMem = 3L shl 30)).supported)
    assertTrue(eval(inputs(totalMem = 0)).supported)
  }

  @Test
  fun shimMissingOn32BitIsUnsupportedAbi() {
    val r = eval(inputs(is64Bit = false, supportedAbis = listOf("armeabi-v7a"), shimError = UnsatisfiedLinkError("nope")))
    assertEquals("unsupported-abi", r.reason)
    assertEquals("armeabi-v7a", r.abi)
    assertEquals(listOf("loadShim"), calls)
  }

  @Test
  fun shimMissingOn64BitIsLibraryMissing() {
    val r = eval(inputs(shimError = UnsatisfiedLinkError("dlopen failed: library \"librnspeech_phonon.so\" not found")))
    assertEquals("library-missing", r.reason)
    assertTrue(r.detail.contains("librnspeech_phonon.so"))
    assertEquals(listOf("loadShim"), calls)
  }

  @Test
  fun abiWithoutPackagedBinary() {
    // x86_64 emulator, app built with the default RNSpeech_phononAbis=arm64-v8a.
    val r = eval(inputs(supportedAbis = listOf("x86_64", "arm64-v8a"), nativeAbi = "x86_64"))
    assertEquals("unsupported-abi", r.reason)
    assertEquals("x86_64", r.abi)
    // ... and supported when x86_64 is packaged (no HWCAP requirements off aarch64).
    calls.clear()
    val ok = eval(inputs(supportedAbis = listOf("x86_64"), packagedAbis = listOf("arm64-v8a", "x86_64"),
      nativeAbi = "x86_64", features = "", required = emptyArray()))
    assertTrue(ok.supported)
  }

  @Test
  fun translatedArmIsHiddenBeforeHwcap() {
    val r = eval(inputs(supportedAbis = listOf("x86_64", "arm64-v8a"), nativeBridge = "libndk_translation.so"))
    assertEquals("translated-abi", r.reason)
    assertFalse(calls.contains("hwcaps"))
  }

  @Test
  fun missingCpuFeaturesListsNames() {
    val r = eval(inputs(features = PhononCpuTest.SD845))
    assertEquals("missing-cpu-features", r.reason)
    assertEquals("missing asimddp", r.detail)
    assertEquals("arm64-v8a", r.abi)
  }
}
