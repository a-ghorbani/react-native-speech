package com.pocketpalai.speech.phonon

/**
 * Turns the shim's flat JNI results into the field maps the TurboModule resolves
 * (src/NativeSpeech.ts PhononLoadResult / PhononSynthResult / PhononDiagnostics). Pure, so
 * the field contract is unit tested; PhononBridge only wraps the maps in WritableMaps.
 */
object PhononResults {
  /** Number of doubles nativeSynthesize writes. */
  const val SYNTH_FIELDS = 11

  data class Outcome(val code: String, val message: String, val fields: Map<String, Any>)

  /**
   * nativeCreate's [code, message, defaultVoice, voices[], languages[],
   * double[handleId, sampleRate, loadMs], effectiveUnit]. code "" = ok.
   */
  fun load(raw: Array<Any?>?, numThreads: Int): Outcome {
    if (raw == null || raw.size < 7) return Outcome("PHONON_INTERNAL", "malformed create result", emptyMap())
    val code = raw[0] as? String ?: "PHONON_INTERNAL"
    val message = raw[1] as? String ?: ""
    if (code.isNotEmpty()) return Outcome(code, message, emptyMap())
    @Suppress("UNCHECKED_CAST")
    val voices = (raw[3] as? Array<String>)?.toList() ?: emptyList()
    @Suppress("UNCHECKED_CAST")
    val languages = (raw[4] as? Array<String>)?.toList() ?: emptyList()
    val nums = raw[5] as? DoubleArray ?: DoubleArray(3)
    return Outcome(
      "",
      "",
      mapOf(
        "handleId" to nums.getOrElse(0) { 0.0 },
        "voices" to voices,
        "languages" to languages,
        "defaultVoice" to (raw[2] as? String ?: ""),
        "sampleRate" to nums.getOrElse(1) { 24000.0 },
        "loadMs" to nums.getOrElse(2) { 0.0 },
        "compiled" to false,
        "numThreads" to numThreads.toDouble(),
        "computeUnit" to (raw[6] as? String ?: "cpu")
      )
    )
  }

  fun synth(nums: DoubleArray): Map<String, Any> {
    fun at(i: Int) = nums.getOrElse(i) { 0.0 }
    return mapOf(
      "requestId" to at(0),
      "bufferId" to at(1),
      "samples" to at(2),
      "sampleRate" to at(3),
      "ttfaMs" to at(4),
      "totalMs" to at(5),
      "queuedMs" to at(6),
      "voiceChanged" to (at(7) != 0.0),
      "cancelled" to (at(8) != 0.0),
      "startedAtMs" to at(9),
      "finishedAtMs" to at(10)
    )
  }

  /** Buffer id of a synth result (0 = none). */
  fun bufferId(nums: DoubleArray): Long = nums.getOrElse(1) { 0.0 }.toLong()

  data class ProcStatus(val rssKb: Long, val hwmKb: Long, val threads: Long)

  /** VmRSS / VmHWM / Threads from /proc/self/status text; missing fields are 0. */
  fun parseProcStatus(text: String?): ProcStatus {
    var rss = 0L
    var hwm = 0L
    var threads = 0L
    text?.lineSequence()?.forEach { line ->
      val key = line.substringBefore(':', "")
      val value = line.substringAfter(':', "").trim().split(Regex("\\s+")).firstOrNull()?.toLongOrNull() ?: 0L
      when (key) {
        "VmRSS" -> rss = value
        "VmHWM" -> hwm = value
        "Threads" -> threads = value
      }
    }
    return ProcStatus(rss, hwm, threads)
  }

  /**
   * @param core nativeDiagnostics' [libraryLoaded, handleOpen, live, orphan, lastIssued,
   *   watermark], or null when the shim is not loaded.
   */
  fun diagnostics(core: LongArray?, busy: String, proc: ProcStatus): Map<String, Any> {
    fun at(i: Int) = core?.getOrElse(i) { 0L } ?: 0L
    return mapOf(
      "memKb" to proc.rssKb.toDouble(),
      "peakMemKb" to proc.hwmKb.toDouble(),
      "threads" to proc.threads.toDouble(),
      "libraryLoaded" to (at(0) != 0L),
      "handleOpen" to (at(1) != 0L),
      "liveBuffers" to at(2).toDouble(),
      "orphanBuffers" to at(3).toDouble(),
      "busy" to busy,
      "lastIssuedId" to at(4).toDouble(),
      "cancelWatermark" to at(5).toDouble()
    )
  }
}
