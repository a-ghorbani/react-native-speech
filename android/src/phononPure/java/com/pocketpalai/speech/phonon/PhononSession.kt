package com.pocketpalai.speech.phonon

import java.util.concurrent.atomic.AtomicInteger

/**
 * PhononBridge's glue logic, separated from Android and JNI so it is unit tested: the
 * create sequence (stale load-failed reset, probe gate, thread policy once, lazy dlopen,
 * which failures are persisted), the module epoch that drops promises of an invalidated
 * module, and buffer playback/release. PhononBridge implements [Host] with the real
 * natives, the capability store and the "phonon-synth" executor.
 */
class PhononSession(private val host: Host) {
  /** A promise, minus React Native: [resolve] gets a field map (or null for void). */
  interface Settle {
    fun resolve(value: Map<String, Any>?)
    fun reject(code: String, message: String)
  }

  interface Host {
    /** The (cached) getSupport probe. */
    fun probe(): PhononProbe.Result
    /** Reason of the cached probe without probing; null if not probed yet. */
    fun cachedReason(): String?
    /** The persisted capability record, if any. */
    fun storedRecord(): PhononCapabilityStore.Record?
    fun resetSupport()
    /** Persists a negative outcome and makes the cached probe report it. */
    fun recordFailure(reason: String, detail: String, modelStamp: String)
    fun shimLoaded(): Boolean
    /** Runs [job] on the synth thread; throws if the thread is unavailable. */
    fun execute(job: Runnable)
    fun resolveThreads(requested: Int): Int
    fun setEnv(name: String, value: String)
    fun log(warn: Boolean, message: String)

    // Natives (only called once shimLoaded()).
    fun loadLibrary(): Array<String>?
    fun create(modelDir: String, language: String, computeUnit: String): Array<Any?>?
    /** Fills [out]; returns [code, message]. */
    fun synthesize(
      handleId: Long,
      requestId: Long,
      text: String,
      voice: String,
      language: String,
      enqueuedAtMs: Double,
      out: DoubleArray
    ): Array<String>?
    fun destroy(handleId: Long): String
    fun takePcm16(bufferId: Long, gain: Float): ByteArray?
    fun releaseBuffer(bufferId: Long): Boolean
    fun cancelAll()
    fun releaseOrphans()
  }

  class CreateParams(
    val modelDir: String,
    /** PhononCapabilityStore.modelStamp of [modelDir]. */
    val modelStamp: String,
    val language: String,
    val computeUnit: String,
    val numThreads: Int,
    val spinBudget: Int
  )

  // Bumped by onModuleInvalidated: work submitted by an invalidated module never settles
  // its promise into the dead JS runtime.
  private val moduleEpoch = AtomicInteger(0)

  // Synth-thread state. RAYON_NUM_THREADS / XN_SPIN_BUDGET are read once per process by
  // rayon and xn, so the first create fixes them.
  @Volatile var effectiveThreads = 0
    private set
  private var effectiveSpinBudget = 0

  fun create(p: CreateParams, settle: Settle) {
    // A load-failed record is about one model: pointing at another one re-enables the probe.
    if (host.cachedReason() == PhononCapabilityStore.REASON_LOAD_FAILED) {
      val record = host.storedRecord()
      if (record != null && record.isStaleFor(p.modelStamp)) host.resetSupport()
    }
    val support = host.probe()
    if (!support.supported) {
      settle.reject(UNSUPPORTED, "Phonon unsupported: ${support.reason} (${support.detail})")
      return
    }
    submit(settle) { reply ->
      applyThreadPolicy(p.numThreads, p.spinBudget)
      val load = host.loadLibrary()
      val loadReason = load?.getOrNull(0) ?: PhononCapabilityStore.REASON_LOAD_FAILED
      if (loadReason != "ok") {
        val detail = load?.getOrNull(1).orEmpty()
        host.recordFailure(loadReason, detail, "")
        reply.reject(UNSUPPORTED, "Phonon unsupported: $loadReason ($detail)")
        return@submit
      }
      val outcome = PhononResults.load(host.create(p.modelDir, p.language, p.computeUnit), effectiveThreads)
      if (outcome.code.isNotEmpty()) {
        if (outcome.code == LOAD_FAILED && PhononCapabilityStore.isPersistentLoadFailure(outcome.message)) {
          host.recordFailure(PhononCapabilityStore.REASON_LOAD_FAILED, outcome.message, p.modelStamp)
        }
        reply.reject(outcome.code, outcome.message)
        return@submit
      }
      reply.resolve(outcome.fields)
    }
  }

  private fun applyThreadPolicy(requested: Int, spinBudget: Int) {
    if (effectiveThreads == 0) {
      val threads = host.resolveThreads(requested)
      try {
        host.setEnv("RAYON_NUM_THREADS", threads.toString())
        if (spinBudget > 0) {
          host.setEnv("XN_SPIN_BUDGET", spinBudget.toString())
          effectiveSpinBudget = spinBudget
        }
      } catch (e: Exception) {
        host.log(true, "could not set the worker thread environment: ${e.message}")
      }
      effectiveThreads = threads
      host.log(false, "threads=$threads spinBudget=${if (effectiveSpinBudget > 0) effectiveSpinBudget else "default"}")
      return
    }
    if (requested > 0 && requested != effectiveThreads) {
      host.log(true, "numThreads=$requested ignored: worker pools are fixed at $effectiveThreads for this process")
    }
    if (spinBudget > 0 && spinBudget != effectiveSpinBudget) {
      host.log(true, "spinBudget=$spinBudget ignored: fixed for this process")
    }
  }

  fun synthesize(
    handleId: Long,
    requestId: Long,
    text: String,
    voice: String,
    language: String,
    enqueuedAtMs: Double,
    settle: Settle
  ) {
    if (!host.shimLoaded()) {
      settle.reject(UNSUPPORTED, "Phonon is not loaded")
      return
    }
    submit(settle) { reply ->
      val out = DoubleArray(PhononResults.SYNTH_FIELDS)
      val res = host.synthesize(handleId, requestId, text, voice, language, enqueuedAtMs, out)
      val code = res?.getOrNull(0) ?: INTERNAL
      if (code.isNotEmpty()) {
        reply.reject(code, res?.getOrNull(1).orEmpty())
        return@submit
      }
      if (!reply.resolve(PhononResults.synth(out))) {
        // Dropped (module invalidated): nobody will ever play or release it.
        val bufferId = PhononResults.bufferId(out)
        if (bufferId > 0) host.releaseBuffer(bufferId)
      }
    }
  }

  /** Enqueued behind any in-flight work; never blocks the caller. */
  fun destroy(handleId: Long, settle: Settle) {
    if (!host.shimLoaded()) {
      settle.resolve(null)
      return
    }
    submit(settle) { reply ->
      val code = host.destroy(handleId)
      if (code.isEmpty()) reply.resolve(null) else reply.reject(code, "Phonon handle $handleId is not open")
    }
  }

  /**
   * Takes (consumes) the buffer as PCM16 scaled by [gain] and hands it to [play]
   * (pcm, sampleRate, ducking), which owns [settle] from then on. The caller reads its config
   * first, so nothing can throw between the take and [play]. An empty buffer resolves at once:
   * a static AudioTrack with a 0 marker may never report completion.
   */
  fun playBuffer(
    bufferId: Long,
    gain: Float,
    sampleRate: Int,
    ducking: Boolean,
    settle: Settle,
    play: (ByteArray, Int, Boolean) -> Unit
  ) {
    val pcm = if (host.shimLoaded()) host.takePcm16(bufferId, gain) else null
    if (pcm == null) {
      settle.reject(INVALID_BUFFER, "Unknown Phonon buffer $bufferId")
      return
    }
    if (pcm.isEmpty()) {
      settle.resolve(null)
      return
    }
    play(pcm, sampleRate, ducking)
  }

  /**
   * The module's real teardown (RNSpeechModule.invalidate, e.g. an RN reload): cancel
   * everything issued so far, drop the old module's pending promises and free unplayed
   * buffers. Returns immediately: never destroys the handle and never waits for the synth
   * thread. Not for setEngine, which re-initializes OS TTS on a live module.
   */
  fun onModuleInvalidated() {
    moduleEpoch.incrementAndGet()
    if (!host.shimLoaded()) return
    try {
      host.cancelAll()
      // Every buffer now belongs to a cancelled id, i.e. is an orphan.
      host.releaseOrphans()
    } catch (t: Throwable) {
      host.log(true, "invalidate cleanup failed: ${t.message}")
    }
  }

  /** Resolves/rejects only while the submitting module is alive. */
  private inner class Reply(private val settle: Settle, private val epoch: Int) {
    private val alive: Boolean get() = moduleEpoch.get() == epoch

    fun resolve(value: Map<String, Any>?): Boolean {
      if (!alive) return false
      settle.resolve(value)
      return true
    }

    fun reject(code: String, message: String) {
      if (alive) settle.reject(code, message)
    }
  }

  private fun submit(settle: Settle, job: (Reply) -> Unit) {
    val reply = Reply(settle, moduleEpoch.get())
    try {
      host.execute {
        try {
          job(reply)
        } catch (t: Throwable) {
          host.log(true, "synth thread job failed: $t")
          reply.reject(INTERNAL, t.message ?: t.javaClass.simpleName)
        }
      }
    } catch (t: Throwable) {
      settle.reject(INTERNAL, "Phonon synth thread unavailable: ${t.message}")
    }
  }

  companion object {
    const val UNSUPPORTED = "PHONON_UNSUPPORTED"
    const val INVALID_BUFFER = "PHONON_INVALID_BUFFER"
    const val INTERNAL = "PHONON_INTERNAL"
    const val LOAD_FAILED = "PHONON_LOAD_FAILED"
  }
}
