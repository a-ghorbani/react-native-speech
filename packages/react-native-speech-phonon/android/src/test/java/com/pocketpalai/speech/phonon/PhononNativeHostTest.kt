package com.pocketpalai.speech.phonon

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters
import java.io.File

/**
 * The real JNI shim (phonon_jni.cpp), built for the host by scripts/test-jni-host.sh,
 * driven through PhononNative exactly as PhononBridge drives it. Skipped unless that script
 * passes the shim (and, for the speak tests, a host libptts_ffi.so and a checkpoint folder).
 *
 * The native Core is a process singleton, so the tests run in name order and build on each
 * other: library failures first, then load, create, speak, cancel, destroy.
 */
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class PhononNativeHostTest {
  companion object {
    private val shim = System.getProperty("rnspeech.phononHostShim").orEmpty()
    private val lib = System.getProperty("rnspeech.phononHostLib").orEmpty()
    private val model = System.getProperty("rnspeech.phononModelDir").orEmpty()
    private var handle = 0L
    private var voices = emptyList<String>()

    @BeforeClass
    @JvmStatic
    fun loadShim() {
      assumeTrue("set by scripts/test-jni-host.sh", shim.isNotEmpty())
      System.load(shim)
    }

    private fun requireModel() = assumeTrue("PHONON_HOST_LIB / PHONON_MODEL_DIR", lib.isNotEmpty() && model.isNotEmpty())

    private class Synth(val code: String, val message: String, val fields: Map<String, Any>, val nums: DoubleArray)

    private fun synth(text: String, voice: String = "", lang: String = "", id: Long = PhononNative.nativeAllocRequestId()): Synth {
      val out = DoubleArray(PhononResults.SYNTH_FIELDS)
      val res = PhononNative.nativeSynthesize(handle, id, text, voice, lang, PhononNative.nativeMonotonicMs(), out)!!
      return Synth(res[0], res[1], PhononResults.synth(out), out)
    }
  }

  @Test
  fun a_probesAndGate() {
    val abi = PhononNative.nativeAbi()
    assertTrue(abi, abi == "arm64-v8a" || abi == "x86_64")
    assertEquals("+dotprod,+fp16", PhononNative.nativeArm64Features())
    val req = PhononCpu.parseRequirements(PhononNative.nativeRequiredHwcaps())
    if (abi == "arm64-v8a") {
      // The header generated from the lock's features, through the JNI encoding.
      assertEquals(PhononCpu.parseRequirements(PhononCpuTest.DOTPROD_FP16).toSet(), req.toSet())
    } else {
      assertEquals(emptyList<PhononCpu.Requirement>(), req)
    }
    assertEquals("", PhononNative.nativeSystemProperty("ro.dalvik.vm.native.bridge"))
    val r = PhononProbe.evaluate(
      PhononProbe.Inputs(
        forceReason = "",
        capability = null,
        totalMemBytes = 0,
        is64Bit = true,
        supportedAbis = listOf(abi),
        packagedAbis = listOf(abi),
        loadShim = { null },
        nativeAbi = { PhononNative.nativeAbi() },
        nativeBridge = { PhononNative.nativeSystemProperty("ro.dalvik.vm.native.bridge") },
        hwcaps = { longArrayOf(PhononNative.nativeHwcap(), PhononNative.nativeHwcap2()) },
        requirements = { req }
      )
    )
    // Hosts that run this (aarch64 with dotprod+fp16, or x86_64) pass the gate.
    assertEquals(PhononProbe.Result(true, "ok", "", abi), r)
    assertTrue(PhononNative.nativeMonotonicMs() > 0)
  }

  @Test
  fun b_idsAndCancelNeedNoLibrary() {
    val a = PhononNative.nativeAllocRequestId()
    val b = PhononNative.nativeAllocRequestId()
    assertEquals(a + 1, b)
    PhononNative.nativeCancelAll()
    // cancelAll does not poison later ids.
    val c = PhononNative.nativeAllocRequestId()
    val diag = PhononNative.nativeDiagnostics()!!
    assertEquals(c, diag[4])
    assertEquals(b, diag[5])
    assertFalse(PhononNative.nativeReleaseBuffer(12345))
    assertNull(PhononNative.nativeTakePcm16(12345, 1f))
    assertNull(PhononNative.nativeCopyFloat32(12345))
  }

  @Test
  fun c_libraryFailuresDoNotLoad() {
    val missing = PhononNative.nativeLoadLibrary("/nonexistent/libptts_ffi.so")!!
    assertEquals("library-missing", missing[0])
    assertTrue(missing[1], missing[1].isNotEmpty())
    // A library without the ptts_* symbols: the shim itself.
    val noSyms = PhononNative.nativeLoadLibrary(shim)!!
    assertEquals("symbols-missing", noSyms[0])
    assertTrue(noSyms[1], noSyms[1].contains("ptts_new"))
    assertFalse(PhononNative.nativeLibraryLoaded())
    assertEquals(0L, PhononNative.nativeDiagnostics()!![0])
    // create without a library is unsupported, not a crash.
    val out = PhononResults.load(PhononNative.nativeCreate("/nowhere", "en", "cpu"), 2)
    assertEquals("PHONON_UNSUPPORTED", out.code)
  }

  @Test
  fun d_loadRealLibrary() {
    requireModel()
    assertArrayEquals(arrayOf("ok", ""), PhononNative.nativeLoadLibrary(lib))
    assertTrue(PhononNative.nativeLibraryLoaded())
    // Idempotent.
    assertEquals("ok", PhononNative.nativeLoadLibrary("/nonexistent/again.so")!![0])
  }

  @Test
  fun e_badModelFolderIsAConfigError() {
    requireModel()
    val dir = File(System.getProperty("java.io.tmpdir"), "phonon-empty-ünï-${System.nanoTime()}").apply { mkdirs() }
    val out = PhononResults.load(PhononNative.nativeCreate(dir.path, "en", "cpu"), 2)
    assertEquals("PHONON_LOAD_FAILED", out.code)
    // Upstream's message survives the UTF-8 → UTF-16 trip, and the capability store must
    // not persist it (a fixed folder can load).
    assertTrue(out.message, out.message.contains("config.json"))
    assertFalse(out.message, PhononCapabilityStore.isPersistentLoadFailure(out.message))
    dir.delete()
  }

  @Test
  fun f_createIsAlwaysCpu() {
    requireModel()
    // JS may pass the iOS default; Android maps every unit to PTTS_UNIT_CPU.
    val out = PhononResults.load(PhononNative.nativeCreate(model, "en", "neuralEngine"), 4)
    assertEquals(out.message, "", out.code)
    assertEquals("cpu", out.fields["computeUnit"])
    assertEquals(24000.0, out.fields["sampleRate"])
    assertEquals(4.0, out.fields["numThreads"])
    handle = (out.fields["handleId"] as Double).toLong()
    assertTrue(handle > 0)
    @Suppress("UNCHECKED_CAST")
    voices = out.fields["voices"] as List<String>
    @Suppress("UNCHECKED_CAST")
    assertTrue((out.fields["languages"] as List<String>).contains("en"))
    assertEquals(1L, PhononNative.nativeDiagnostics()!![1])
  }

  @Test
  fun g_speakTakeAndCopy() {
    requireModel()
    val s = synth("Hello from Phonon.")
    assertEquals(s.message, "", s.code)
    assertEquals(false, s.fields["cancelled"])
    val samples = (s.fields["samples"] as Double).toInt()
    assertTrue("samples=$samples", samples > 12000)
    val bufferId = PhononResults.bufferId(s.nums)
    assertTrue(bufferId > 0)
    assertTrue((s.fields["finishedAtMs"] as Double) >= (s.fields["startedAtMs"] as Double))
    assertEquals(samples * 4, PhononNative.nativeCopyFloat32(bufferId)!!.size)
    // Copy is non-consuming; take consumes.
    val pcm = PhononNative.nativeTakePcm16(bufferId, 0.5f)!!
    assertEquals(samples * 2, pcm.size)
    assertTrue("non-silent", pcm.any { it != 0.toByte() })
    assertNull(PhononNative.nativeTakePcm16(bufferId, 1f))
    assertFalse(PhononNative.nativeReleaseBuffer(bufferId))
  }

  @Test
  fun h_nonAsciiTextAndRelease() {
    requireModel()
    // Supplementary-plane characters must reach Rust as valid UTF-8.
    val s = synth("Café crème, naïve 👋 déjà vu.")
    assertEquals(s.message, "", s.code)
    val bufferId = PhononResults.bufferId(s.nums)
    assertTrue(bufferId > 0)
    assertTrue(PhononNative.nativeReleaseBuffer(bufferId))
    assertFalse(PhononNative.nativeReleaseBuffer(bufferId)) // idempotent
  }

  @Test
  fun i_cancelBeforeSpeakSkipsWork() {
    requireModel()
    val id = PhononNative.nativeAllocRequestId()
    PhononNative.nativeCancelUpTo(id)
    val s = synth("This is never spoken.", id = id)
    assertEquals("", s.code)
    assertEquals(true, s.fields["cancelled"])
    assertEquals(0.0, s.fields["bufferId"])
    // Cancel-all does not poison the next request.
    PhononNative.nativeCancelAll()
    val next = synth("Still works.")
    assertEquals(false, next.fields["cancelled"])
    assertTrue(PhononNative.nativeReleaseBuffer(PhononResults.bufferId(next.nums)))
  }

  @Test
  fun j_voices() {
    requireModel()
    val unknown = synth("Hi.", voice = "no-such-voice")
    assertEquals("PHONON_VOICE_NOT_FOUND", unknown.code)
    assertTrue(unknown.message.isNotEmpty())
    if (voices.isNotEmpty()) {
      val s = synth("Hi.", voice = voices.last())
      assertEquals(s.message, "", s.code)
      PhononNative.nativeReleaseBuffer(PhononResults.bufferId(s.nums))
    }
  }

  @Test
  fun k_orphansAndDiagnostics() {
    requireModel()
    val s = synth("Orphan me.")
    val bufferId = PhononResults.bufferId(s.nums)
    assertTrue(bufferId > 0)
    // Invalidate path: cancelAll orphans every buffer, releaseOrphans frees them.
    PhononNative.nativeCancelAll()
    assertEquals(1, PhononNative.nativeReleaseOrphans())
    val d = PhononNative.nativeDiagnostics()!!
    assertEquals(0L, d[2])
    assertEquals(0L, d[3])
    assertEquals("idle", PhononNative.nativeBusy())
  }

  @Test
  fun l_destroy() {
    requireModel()
    assertEquals("", PhononNative.nativeDestroy(handle))
    assertEquals("PHONON_INVALID_HANDLE", PhononNative.nativeDestroy(handle))
    val stale = synth("Gone.")
    assertEquals("PHONON_INVALID_HANDLE", stale.code)
    assertNotNull(PhononNative.nativeDiagnostics())
    assertEquals(0L, PhononNative.nativeDiagnostics()!![1])
  }
}
