package com.pocketpalai.speech.phonon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean

/** PhononBridge's glue (create sequence, capability records, module tokens, buffers) on a fake host. */
class PhononSessionTest {
  private class FakeSettle : PhononSession.Settle {
    var resolved: Map<String, Any>? = null
    var resolveCount = 0
    var code: String? = null
    var message: String? = null

    val settled get() = resolveCount > 0 || code != null

    override fun resolve(value: Map<String, Any>?) {
      resolved = value
      resolveCount++
    }

    override fun reject(code: String, message: String) {
      this.code = code
      this.message = message
    }
  }

  private class FakeHost : PhononSession.Host {
    val calls = mutableListOf<String>()
    val env = mutableMapOf<String, String>()
    val released = mutableListOf<Long>()
    val failures = mutableListOf<Triple<String, String, String>>()
    val failurePaths = mutableListOf<String>()
    val queue = ArrayDeque<Runnable>()

    var support = PhononProbe.Result(true, "ok", "", "arm64-v8a")
    var cached: String? = null
    var record: PhononCapabilityStore.Record? = null
    var shim = true
    var executorDown = false
    var load: Array<String>? = arrayOf("ok", "")
    var createResult: Array<Any?>? = okCreate()
    var synthCode = arrayOf("", "")
    var synthBufferId = 7.0
    var pcm: ByteArray? = ByteArray(4)

    fun runAll() {
      while (queue.isNotEmpty()) queue.removeFirst().run()
    }

    override fun probe(): PhononProbe.Result {
      calls += "probe"
      return support
    }
    override fun cachedReason() = cached
    override fun storedRecord() = record
    override fun resetSupport() {
      calls += "reset"
      record = null
      cached = null
      support = PhononProbe.Result(true, "ok", "", "arm64-v8a")
    }
    override fun recordFailure(reason: String, detail: String, modelPath: String, modelStamp: String) {
      failures += Triple(reason, detail, modelStamp)
      failurePaths += modelPath
    }
    override fun shimLoaded() = shim
    override fun execute(job: Runnable) {
      if (executorDown) throw IllegalStateException("down")
      queue.addLast(job)
    }
    override fun resolveThreads(requested: Int) = if (requested > 0) requested else 4
    override fun getEnv(name: String): String? = env[name]
    override fun setEnv(name: String, value: String) {
      env[name] = value
    }
    override fun log(warn: Boolean, message: String) {}
    override fun loadLibrary(): Array<String>? {
      calls += "loadLibrary"
      return load
    }
    override fun create(modelDir: String, language: String, computeUnit: String): Array<Any?>? {
      calls += "create:$modelDir:$language:$computeUnit"
      return createResult
    }
    override fun synthesize(
      handleId: Long,
      requestId: Long,
      text: String,
      voice: String,
      language: String,
      enqueuedAtMs: Double,
      out: DoubleArray
    ): Array<String>? {
      calls += "synthesize:$handleId:$requestId"
      out[0] = requestId.toDouble()
      out[1] = synthBufferId
      out[2] = 2400.0
      return synthCode
    }
    override fun destroy(handleId: Long): String {
      calls += "destroy:$handleId"
      return ""
    }
    override fun takePcm16(bufferId: Long, gain: Float): ByteArray? {
      calls += "take:$bufferId:$gain"
      return pcm
    }
    override fun releaseBuffer(bufferId: Long): Boolean {
      released += bufferId
      return true
    }
    override fun cancelAll() {
      calls += "cancelAll"
    }
    override fun releaseOrphans() {
      calls += "releaseOrphans"
    }

    companion object {
      fun okCreate(): Array<Any?> =
        arrayOf("", "", "alba", arrayOf("alba"), arrayOf("en"), doubleArrayOf(1.0, 24000.0, 12.0), "cpu")
    }
  }

  private val host = FakeHost()
  private val session = PhononSession(host)
  private val alive = AtomicBoolean(true)

  private fun params(stamp: String = "stamp-a", threads: Int = 0, spin: Int = 0) =
    PhononSession.CreateParams("/models/a", stamp, "en", "gpu", threads, spin)

  private fun loadFailedRecord(stamp: String) = PhononCapabilityStore.Record(
    "fp", "0.4.0-r1", stamp, PhononCapabilityStore.REASON_LOAD_FAILED, "bad weights", 1L
  )

  // ---- create -------------------------------------------------------------------------------

  @Test
  fun createRejectsWithoutNativeWorkWhenProbeFails() {
    host.support = PhononProbe.Result(false, "missing-cpu-features", "asimddp", "arm64-v8a")
    val s = FakeSettle()
    session.create(params(), alive, s)
    assertEquals(PhononSession.UNSUPPORTED, s.code)
    assertTrue(s.message!!.contains("missing-cpu-features"))
    assertTrue(host.queue.isEmpty())
    assertEquals(listOf("probe"), host.calls)
    assertTrue(host.env.isEmpty())
  }

  @Test
  fun createSucceedsAfterLoadAndPassesComputeUnitThrough() {
    val s = FakeSettle()
    session.create(params(), alive, s)
    assertFalse(s.settled) // runs on the synth thread
    host.runAll()
    assertEquals(listOf("probe", "loadLibrary", "create:/models/a:en:gpu"), host.calls)
    assertEquals(1.0, s.resolved!!["handleId"])
    assertEquals(4.0, s.resolved!!["numThreads"])
    assertEquals("4", host.env["RAYON_NUM_THREADS"])
    assertTrue(host.failures.isEmpty())
  }

  @Test
  fun libraryAndSymbolFailuresArePersistedWithoutModelStamp() {
    for (reason in listOf("library-missing", "symbols-missing")) {
      host.failures.clear()
      host.load = arrayOf(reason, "dlopen: nope")
      val s = FakeSettle()
      session.create(params(), alive, s)
      host.runAll()
      assertEquals(PhononSession.UNSUPPORTED, s.code)
      assertEquals(listOf(Triple(reason, "dlopen: nope", "")), host.failures)
      assertEquals("", host.failurePaths.last())
    }
    assertFalse(host.calls.any { it.startsWith("create:") })
  }

  @Test
  fun malformedLoadResultCountsAsLoadFailed() {
    host.load = null
    val s = FakeSettle()
    session.create(params(), alive, s)
    host.runAll()
    assertEquals(PhononCapabilityStore.REASON_LOAD_FAILED, host.failures.single().first)
  }

  @Test
  fun persistentLoadFailureIsRecordedWithStamp() {
    host.createResult = arrayOf("PHONON_LOAD_FAILED", "weights are corrupt", "", null, null, null, "")
    val msg = "weights are corrupt"
    val s = FakeSettle()
    session.create(params(stamp = "stamp-x"), alive, s)
    host.runAll()
    assertEquals("PHONON_LOAD_FAILED", s.code)
    assertTrue(PhononCapabilityStore.isPersistentLoadFailure(msg))
    assertEquals(Triple(PhononCapabilityStore.REASON_LOAD_FAILED, msg, "stamp-x"), host.failures.single())
    // The folder is recorded so the probe can tell when that model changes.
    assertEquals(listOf("/models/a"), host.failurePaths)
  }

  @Test
  fun configLoadFailureIsNotRecorded() {
    host.createResult = arrayOf("PHONON_LOAD_FAILED", "failed to read config.json: No such file", "", null, null, null, "")
    val s = FakeSettle()
    session.create(params(), alive, s)
    host.runAll()
    assertEquals("PHONON_LOAD_FAILED", s.code)
    assertTrue(host.failures.isEmpty())
  }

  @Test
  fun otherCreateErrorsAreNotRecorded() {
    host.createResult = arrayOf("PHONON_BUSY", "busy", "", null, null, null, "")
    val s = FakeSettle()
    session.create(params(), alive, s)
    host.runAll()
    assertEquals("PHONON_BUSY", s.code)
    assertTrue(host.failures.isEmpty())
  }

  @Test
  fun staleLoadFailedRecordIsResetForAnotherModel() {
    host.cached = PhononCapabilityStore.REASON_LOAD_FAILED
    host.record = loadFailedRecord("stamp-old")
    host.support = PhononProbe.Result(false, PhononCapabilityStore.REASON_LOAD_FAILED, "bad", "arm64-v8a")
    val s = FakeSettle()
    session.create(params(stamp = "stamp-new"), alive, s)
    assertEquals(listOf("reset", "probe"), host.calls)
    host.runAll()
    assertEquals(1, s.resolveCount)
  }

  @Test
  fun loadFailedRecordForTheSameModelStillRejects() {
    host.cached = PhononCapabilityStore.REASON_LOAD_FAILED
    host.record = loadFailedRecord("stamp-a")
    host.support = PhononProbe.Result(false, PhononCapabilityStore.REASON_LOAD_FAILED, "bad", "arm64-v8a")
    val s = FakeSettle()
    session.create(params(stamp = "stamp-a"), alive, s)
    assertEquals(listOf("probe"), host.calls)
    assertEquals(PhononSession.UNSUPPORTED, s.code)
  }

  @Test
  fun libraryRecordIsNotResetByAnotherModel() {
    host.cached = PhononCapabilityStore.REASON_LIBRARY_MISSING
    host.record = loadFailedRecord("x").copy(reason = PhononCapabilityStore.REASON_LIBRARY_MISSING)
    host.support = PhononProbe.Result(false, PhononCapabilityStore.REASON_LIBRARY_MISSING, "", "arm64-v8a")
    val s = FakeSettle()
    session.create(params(stamp = "other"), alive, s)
    assertFalse(host.calls.contains("reset"))
    assertEquals(PhononSession.UNSUPPORTED, s.code)
  }

  @Test
  fun threadPolicyIsAppliedOncePerProcess() {
    session.create(params(threads = 3, spin = 5000), alive, FakeSettle())
    host.runAll()
    assertEquals("3", host.env["RAYON_NUM_THREADS"])
    assertEquals("5000", host.env["XN_SPIN_BUDGET"])
    host.env.clear()
    val s = FakeSettle()
    session.create(params(threads = 6, spin = 9000), alive, s)
    host.runAll()
    assertTrue(host.env.isEmpty())
    assertEquals(3.0, s.resolved!!["numThreads"])
    assertEquals(3, session.effectiveThreads)
  }

  @Test
  fun packedWeightCacheIsTurnedOffOncePerProcess() {
    session.create(params(), alive, FakeSettle())
    host.runAll()
    assertEquals("0", host.env[PhononSession.PACKED_CACHE_ENV])
    host.env.clear()
    session.create(params(), alive, FakeSettle())
    host.runAll()
    assertFalse(host.env.containsKey(PhononSession.PACKED_CACHE_ENV))
  }

  @Test
  fun packedWeightCacheKeepsAValueTheProcessAlreadySet() {
    host.env[PhononSession.PACKED_CACHE_ENV] = "64"
    session.create(params(), alive, FakeSettle())
    host.runAll()
    assertEquals("64", host.env[PhononSession.PACKED_CACHE_ENV])
  }

  @Test
  fun spinBudgetUnsetLeavesEnvAlone() {
    session.create(params(), alive, FakeSettle())
    host.runAll()
    assertFalse(host.env.containsKey("XN_SPIN_BUDGET"))
  }

  @Test
  fun unavailableSynthThreadRejectsAtOnce() {
    host.executorDown = true
    val s = FakeSettle()
    session.create(params(), alive, s)
    assertEquals(PhononSession.INTERNAL, s.code)
  }

  @Test
  fun jobExceptionRejectsInternal() {
    host.createResult = null
    val s = FakeSettle()
    session.create(params(), alive, s)
    host.runAll()
    assertEquals(PhononSession.INTERNAL, s.code)
  }

  // ---- module tokens ------------------------------------------------------------------------

  @Test
  fun invalidatingOneModuleKeepsAnotherModulesPromises() {
    // Two React instances in one process: invalidating A must not strand B's work.
    val other = AtomicBoolean(true)
    val a = FakeSettle()
    val b = FakeSettle()
    session.synthesize(1, 5, "hi", "alba", "en", 0.0, alive, a)
    session.synthesize(1, 6, "hi", "alba", "en", 0.0, other, b)
    session.onModuleInvalidated(alive)
    host.runAll()
    assertFalse(a.settled)
    assertEquals(6.0, b.resolved!!["requestId"])
    assertEquals(listOf(7L), host.released) // only A's dropped result
    assertTrue(other.get())
    // cancelAll stays process-wide (DESIGN.md §1.5).
    assertTrue(host.calls.contains("cancelAll"))
  }

  @Test
  fun invalidatedModuleDropsPendingCreate() {
    val s = FakeSettle()
    session.create(params(), alive, s)
    session.onModuleInvalidated(alive)
    host.runAll()
    assertFalse(s.settled)
  }

  @Test
  fun invalidatedModuleDropsSynthAndReleasesItsBuffer() {
    val s = FakeSettle()
    session.synthesize(1, 5, "hi", "alba", "en", 0.0, alive, s)
    session.onModuleInvalidated(alive)
    host.runAll()
    assertFalse(s.settled)
    assertEquals(listOf(7L), host.released)
  }

  @Test
  fun droppedSynthWithoutBufferReleasesNothing() {
    host.synthBufferId = 0.0
    session.synthesize(1, 5, "hi", "alba", "en", 0.0, alive, FakeSettle())
    session.onModuleInvalidated(alive)
    host.runAll()
    assertTrue(host.released.isEmpty())
  }

  @Test
  fun workOfTheNextModuleSettles() {
    session.onModuleInvalidated(alive)
    // The reloaded RN instance gets a new module, so a new token.
    val next = AtomicBoolean(true)
    val s = FakeSettle()
    session.synthesize(1, 9, "hi", "alba", "en", 0.0, next, s)
    host.runAll()
    assertEquals(9.0, s.resolved!!["requestId"])
    assertTrue(host.released.isEmpty())
  }

  @Test
  fun droppedRejectionIsSilent() {
    host.synthCode = arrayOf("PHONON_CANCELLED", "x")
    val s = FakeSettle()
    session.synthesize(1, 5, "hi", "alba", "en", 0.0, alive, s)
    session.onModuleInvalidated(alive)
    host.runAll()
    assertFalse(s.settled)
  }

  @Test
  fun onModuleInvalidatedCancelsThenReleasesOrphans() {
    session.onModuleInvalidated(alive)
    assertEquals(listOf("cancelAll", "releaseOrphans"), host.calls)
  }

  @Test
  fun onModuleInvalidatedWithoutShimTouchesNoNatives() {
    host.shim = false
    session.onModuleInvalidated(alive)
    assertTrue(host.calls.isEmpty())
  }

  // ---- synth / destroy / buffers ------------------------------------------------------------

  @Test
  fun synthesizeWithoutShimRejects() {
    host.shim = false
    val s = FakeSettle()
    session.synthesize(1, 5, "hi", "alba", "en", 0.0, alive, s)
    assertEquals(PhononSession.UNSUPPORTED, s.code)
    assertTrue(host.queue.isEmpty())
  }

  @Test
  fun synthesizeErrorCodeRejects() {
    host.synthCode = arrayOf("PHONON_VOICE_NOT_FOUND", "no voice zed")
    val s = FakeSettle()
    session.synthesize(1, 5, "hi", "zed", "en", 0.0, alive, s)
    host.runAll()
    assertEquals("PHONON_VOICE_NOT_FOUND", s.code)
    assertEquals("no voice zed", s.message)
  }

  @Test
  fun destroyWithoutShimResolves() {
    host.shim = false
    val s = FakeSettle()
    session.destroy(1, alive, s)
    assertEquals(1, s.resolveCount)
    assertNull(s.resolved)
  }

  @Test
  fun destroyRunsOnSynthThread() {
    val s = FakeSettle()
    session.destroy(3, alive, s)
    assertFalse(s.settled)
    host.runAll()
    assertEquals(listOf("destroy:3"), host.calls)
    assertEquals(1, s.resolveCount)
  }

  @Test
  fun playBufferHandsPcmToPlayer() {
    var played: Triple<Int, Int, Boolean>? = null
    val s = FakeSettle()
    session.playBuffer(7, 0.5f, 22050, true, s) { pcm, rate, duck -> played = Triple(pcm.size, rate, duck) }
    assertEquals(Triple(4, 22050, true), played)
    assertEquals(listOf("take:7:0.5"), host.calls)
    assertFalse(s.settled) // the player owns the promise now
  }

  @Test
  fun playBufferUnknownIdRejects() {
    host.pcm = null
    val s = FakeSettle()
    var played = false
    session.playBuffer(7, 1f, 24000, false, s) { _, _, _ -> played = true }
    assertEquals(PhononSession.INVALID_BUFFER, s.code)
    assertFalse(played)
  }

  @Test
  fun playBufferWithoutShimRejectsWithoutNativeCall() {
    host.shim = false
    val s = FakeSettle()
    session.playBuffer(7, 1f, 24000, false, s) { _, _, _ -> }
    assertEquals(PhononSession.INVALID_BUFFER, s.code)
    assertTrue(host.calls.isEmpty())
  }

  @Test
  fun emptyBufferGoesToPlayer() {
    // The player resolves empty PCM itself.
    host.pcm = ByteArray(0)
    val s = FakeSettle()
    var played = -1
    session.playBuffer(7, 1f, 24000, false, s) { pcm, _, _ -> played = pcm.size }
    assertEquals(0, played)
    assertFalse(s.settled)
  }
}
