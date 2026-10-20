package com.pocketpalai.speech.phonon

import org.junit.Assert.assertEquals
import org.junit.Test

/** Field contract of the maps the TurboModule resolves (src/NativeSpeech.ts). */
class PhononResultsTest {
  @Test
  fun loadResultFields() {
    val raw = arrayOf<Any?>(
      "", "", "default",
      arrayOf("default", "alba"), arrayOf("en"),
      doubleArrayOf(3.0, 24000.0, 412.5),
      "cpu"
    )
    val out = PhononResults.load(raw, 4)
    assertEquals("", out.code)
    assertEquals(
      mapOf(
        "handleId" to 3.0,
        "voices" to listOf("default", "alba"),
        "languages" to listOf("en"),
        "defaultVoice" to "default",
        "sampleRate" to 24000.0,
        "loadMs" to 412.5,
        "compiled" to false,
        "numThreads" to 4.0,
        "computeUnit" to "cpu"
      ),
      out.fields
    )
  }

  @Test
  fun computeUnitIsWhatNativeReportsAndDefaultsToCpu() {
    // The shim maps every request to PTTS_UNIT_CPU (map_compute_unit, host-tested in
    // test/phonon-core) and reports "cpu"; a missing value still reads as cpu.
    val raw = arrayOf<Any?>("", "", "", arrayOf<String>(), arrayOf<String>(), doubleArrayOf(1.0, 24000.0, 1.0), null)
    assertEquals("cpu", PhononResults.load(raw, 2).fields["computeUnit"])
  }

  @Test
  fun loadErrorsCarryCodeAndMessage() {
    val raw = arrayOf<Any?>("PHONON_LOAD_FAILED", "no weights in /x", "", null, null, null, "cpu")
    val out = PhononResults.load(raw, 4)
    assertEquals("PHONON_LOAD_FAILED", out.code)
    assertEquals("no weights in /x", out.message)
    assertEquals(emptyMap<String, Any>(), out.fields)
    assertEquals("PHONON_INTERNAL", PhononResults.load(null, 4).code)
    assertEquals("PHONON_INTERNAL", PhononResults.load(arrayOf("", ""), 4).code)
  }

  @Test
  fun emptyVoiceListIsAllowed() {
    val raw = arrayOf<Any?>("", "", "", arrayOf<String>(), arrayOf("en"), doubleArrayOf(1.0, 24000.0, 1.0), "cpu")
    assertEquals(emptyList<String>(), PhononResults.load(raw, 2).fields["voices"])
    assertEquals("", PhononResults.load(raw, 2).fields["defaultVoice"])
  }

  @Test
  fun synthResultFields() {
    val nums = doubleArrayOf(7.0, 2.0, 48000.0, 24000.0, 120.0, 900.0, 3.5, 1.0, 0.0, 1000.0, 1900.0)
    assertEquals(PhononResults.SYNTH_FIELDS, nums.size)
    assertEquals(
      mapOf(
        "requestId" to 7.0,
        "bufferId" to 2.0,
        "samples" to 48000.0,
        "sampleRate" to 24000.0,
        "ttfaMs" to 120.0,
        "totalMs" to 900.0,
        "queuedMs" to 3.5,
        "voiceChanged" to true,
        "cancelled" to false,
        "startedAtMs" to 1000.0,
        "finishedAtMs" to 1900.0
      ),
      PhononResults.synth(nums)
    )
    assertEquals(2L, PhononResults.bufferId(nums))
    val cancelled = PhononResults.synth(doubleArrayOf(8.0, 0.0, 0.0, 24000.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 2.0))
    assertEquals(true, cancelled["cancelled"])
    assertEquals(0.0, cancelled["bufferId"])
  }

  @Test
  fun procStatus() {
    val text = """
      Name:	speech.example
      VmPeak:	 9000000 kB
      VmHWM:	  412345 kB
      VmRSS:	  398000 kB
      Threads:	57
    """.trimIndent()
    assertEquals(PhononResults.ProcStatus(398000, 412345, 57), PhononResults.parseProcStatus(text))
    assertEquals(PhononResults.ProcStatus(0, 0, 0), PhononResults.parseProcStatus(null))
    assertEquals(PhononResults.ProcStatus(0, 0, 0), PhononResults.parseProcStatus("garbage\nVmRSS: x kB"))
  }

  @Test
  fun diagnosticsFields() {
    val d = PhononResults.diagnostics(longArrayOf(1, 1, 2, 1, 40, 38), "speaking", PhononResults.ProcStatus(10, 20, 30))
    assertEquals(
      mapOf(
        "memKb" to 10.0,
        "peakMemKb" to 20.0,
        "threads" to 30.0,
        "libraryLoaded" to true,
        "handleOpen" to true,
        "liveBuffers" to 2.0,
        "orphanBuffers" to 1.0,
        "busy" to "speaking",
        "lastIssuedId" to 40.0,
        "cancelWatermark" to 38.0
      ),
      d
    )
    // Shim not loaded: nothing loaded, all zero.
    val none = PhononResults.diagnostics(null, "idle", PhononResults.ProcStatus(1, 2, 3))
    assertEquals(false, none["libraryLoaded"])
    assertEquals(0.0, none["liveBuffers"])
  }
}
