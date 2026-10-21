package com.pocketpalai.speech.phonon

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Process
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.pocketpalai.speech.BuildConfig
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * PhononBridge (RNSpeech_phononEnabled=true). Process-wide: an RN reload creates a new
 * RNSpeechModule but talks to this same object, synth thread and native handle, so upstream's
 * one-thread-per-handle rule always holds (DESIGN.md §1.5). Same signatures as the flag-off
 * stub in src/phononStub/java.
 *
 *  * getSupport: cheap probe, cached per process (except load-failed, which depends on the
 *    model on disk); never dlopens libptts_ffi.so.
 *  * create: re-checks the probe, then on the synth thread applies the thread policy,
 *    dlopens the library (lazily, after the HWCAP gate) and creates the handle. That
 *    sequence, the per-module liveness token and buffer play/release live in PhononSession (pure,
 *    unit tested); this object supplies the Android and JNI side.
 *  * ids / cancel / release: synchronous, lock-free native calls.
 *  * Work runs on one "phonon-synth" thread with an 8 MB stack at THREAD_PRIORITY_AUDIO.
 */
object PhononBridge {
  const val NOT_COMPILED = "PHONON_NOT_COMPILED"
  const val UNSUPPORTED = "PHONON_UNSUPPORTED"
  private const val INTERNAL = "PHONON_INTERNAL"
  private const val TAG = "Phonon"
  private const val STACK_BYTES = 8L shl 20

  private val supportLock = Any()
  @Volatile private var cachedSupport: PhononProbe.Result? = null
  @Volatile private var shimLoaded = false
  private var loggedReason: String? = null
  // Set by create (the only session entry that probes or touches the capability store).
  @Volatile private var appContext: Context? = null

  private val session = PhononSession(AndroidHost)

  private val executor: ThreadPoolExecutor by lazy {
    val factory = ThreadFactory { r ->
      Thread(null, {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
        r.run()
      }, "phonon-synth", STACK_BYTES).apply { isDaemon = true }
    }
    ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, LinkedBlockingQueue(), factory)
  }

  // ---- support ------------------------------------------------------------------------------

  fun getSupport(context: ReactApplicationContext, promise: Promise) {
    try {
      promise.resolve(Arguments.makeNativeMap(supportInfo(probe(context))))
    } catch (t: Throwable) {
      promise.reject(INTERNAL, "Phonon support probe failed: ${t.message}", t)
    }
  }

  private fun supportInfo(r: PhononProbe.Result): Map<String, Any> = mapOf(
    "supported" to r.supported,
    "reason" to r.reason,
    "detail" to r.detail,
    "abi" to r.abi,
    "osVersion" to (Build.VERSION.RELEASE ?: ""),
    "libraryVersion" to BuildConfig.RN_SPEECH_PHONON_VERSION,
    "isSimulator" to isEmulator(),
    "pageSize" to pageSize().toDouble()
  )

  // A load-failed result is re-evaluated on every call: it stops applying once the recorded
  // model changes (a cheap file read plus a few stats), see PhononCapabilityStore.Record.applies.
  private fun cached(): PhononProbe.Result? =
    cachedSupport?.takeIf { it.reason != PhononCapabilityStore.REASON_LOAD_FAILED }

  private fun probe(context: Context): PhononProbe.Result {
    cached()?.let { return it }
    synchronized(supportLock) {
      cached()?.let { return it }
      val result = try {
        PhononProbe.evaluate(probeInputs(context))
      } catch (t: Throwable) {
        PhononProbe.Result(false, "error", t.message ?: t.javaClass.simpleName, primaryAbi())
      }
      cachedSupport = result
      if (!result.supported && loggedReason != result.reason) {
        loggedReason = result.reason
        Log.i(TAG, "unsupported: ${result.reason} (${result.detail})")
      }
      return result
    }
  }

  private fun probeInputs(context: Context) = PhononProbe.Inputs(
    forceReason = BuildConfig.RN_SPEECH_PHONON_FORCE_REASON,
    capability = store(context).read()?.takeIf {
      it.applies(Build.FINGERPRINT ?: "", BuildConfig.RN_SPEECH_PHONON_VERSION) { dir ->
        PhononCapabilityStore.modelStamp(File(dir))
      }
    },
    totalMemBytes = totalMem(context),
    is64Bit = Process.is64Bit(),
    supportedAbis = Build.SUPPORTED_ABIS?.toList() ?: emptyList(),
    packagedAbis = BuildConfig.RN_SPEECH_PHONON_ABIS.split(",").map { it.trim() }.filter { it.isNotEmpty() },
    loadShim = ::loadShim,
    nativeAbi = { PhononNative.nativeAbi() },
    nativeBridge = { PhononNative.nativeSystemProperty("ro.dalvik.vm.native.bridge") },
    hwcaps = { longArrayOf(PhononNative.nativeHwcap(), PhononNative.nativeHwcap2()) },
    requirements = { PhononCpu.parseRequirements(PhononNative.nativeRequiredHwcaps()) },
    arm64Features = { PhononNative.nativeArm64Features() }
  )

  private fun loadShim(): Throwable? =
    try {
      System.loadLibrary(PhononNative.SHIM)
      shimLoaded = true
      null
    } catch (e: UnsatisfiedLinkError) {
      e
    } catch (e: SecurityException) {
      e
    }

  /** Records a negative outcome and makes the cached probe report it from now on. */
  private fun recordFailure(
    context: Context,
    reason: String,
    detail: String,
    modelPath: String,
    modelStamp: String
  ) {
    val record = PhononCapabilityStore.Record(
      device = Build.FINGERPRINT ?: "",
      libraryVersion = BuildConfig.RN_SPEECH_PHONON_VERSION,
      modelStamp = modelStamp,
      reason = reason,
      detail = detail,
      at = System.currentTimeMillis(),
      modelPath = modelPath
    )
    if (!store(context).write(record)) Log.w(TAG, "could not persist capability record")
    synchronized(supportLock) {
      cachedSupport = PhononProbe.Result(false, reason, detail, cachedSupport?.abi ?: primaryAbi())
    }
    Log.w(TAG, "disabled for this device: $reason ($detail)")
  }

  /** Clears the persisted record and the cached probe (Speech.resetEngineSupport). */
  fun resetSupport(context: Context): Boolean {
    synchronized(supportLock) {
      cachedSupport = null
      loggedReason = null
    }
    return store(context).clear()
  }

  /** phononResetSupport: resolves true if no record is left. */
  fun resetSupport(context: Context, promise: Promise) {
    try {
      promise.resolve(resetSupport(context))
    } catch (t: Throwable) {
      promise.reject(INTERNAL, "Phonon support reset failed: ${t.message}", t)
    }
  }

  private fun store(context: Context) =
    PhononCapabilityStore(File(context.noBackupFilesDir, PhononCapabilityStore.FILE_NAME))

  // ---- model --------------------------------------------------------------------------------

  /** Android loads checkpoint folders; nothing is ever compiled. */
  fun needsCompile(modelDir: String, promise: Promise) {
    promise.resolve(false)
  }

  /** [alive]: the calling module's token (see [onModuleInvalidated]). */
  fun create(
    context: ReactApplicationContext,
    modelDir: String,
    options: ReadableMap,
    alive: AtomicBoolean,
    promise: Promise
  ) {
    val params = PhononSession.CreateParams(
      modelDir = modelDir,
      modelStamp = PhononCapabilityStore.modelStamp(File(modelDir)),
      language = options.stringOr("language", "en"),
      computeUnit = options.stringOr("computeUnit", "cpu"),
      numThreads = options.intOr("numThreads", 0),
      // PhononConfig.spinBudget -> XN_SPIN_BUDGET (0 = upstream default).
      spinBudget = options.intOr("spinBudget", 0)
    )
    session(context).create(params, alive, settle(promise))
  }

  // ---- ids / cancel -------------------------------------------------------------------------

  fun allocRequestId(): Long = if (shimLoaded) PhononNative.nativeAllocRequestId() else 0L

  fun cancelUpTo(upToRequestId: Long): Boolean {
    if (!shimLoaded) return false
    PhononNative.nativeCancelUpTo(upToRequestId)
    return true
  }

  fun cancelAll(): Boolean {
    if (!shimLoaded) return false
    PhononNative.nativeCancelAll()
    return true
  }

  // ---- synthesis ----------------------------------------------------------------------------

  fun synthesize(
    handleId: Long,
    requestId: Long,
    text: String,
    voice: String,
    language: String,
    alive: AtomicBoolean,
    promise: Promise
  ) {
    val enqueuedAt = if (shimLoaded) PhononNative.nativeMonotonicMs() else 0.0
    session.synthesize(handleId, requestId, text, voice, language, enqueuedAt, alive, settle(promise))
  }

  // ---- buffers ------------------------------------------------------------------------------

  /**
   * Takes (consumes) the buffer, converts it to PCM16 with the config's volume as gain, and
   * hands it to the module's shared PCM player. [play] receives (pcm, sampleRate, ducking).
   * The config is read (null- and type-safe) before the take.
   */
  fun playBuffer(
    bufferId: Long,
    config: ReadableMap,
    promise: Promise,
    play: (ByteArray, Int, Boolean) -> Unit
  ) {
    val gain = config.doubleOr("volume", 1.0).toFloat()
    val sampleRate = config.intOr("sampleRate", 24000).takeIf { it > 0 } ?: 24000
    val ducking = config.boolOr("ducking", false)
    session.playBuffer(bufferId, gain, sampleRate, ducking, settle(promise), play)
  }

  fun copyBuffer(bufferId: Long, promise: Promise) {
    val bytes = if (shimLoaded) PhononNative.nativeCopyFloat32(bufferId) else null
    if (bytes == null) {
      promise.reject(PhononSession.INVALID_BUFFER, "Unknown Phonon buffer $bufferId")
      return
    }
    promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP))
  }

  fun releaseBuffer(bufferId: Long): Boolean =
    shimLoaded && PhononNative.nativeReleaseBuffer(bufferId)

  /** Enqueued behind any in-flight work; never blocks the caller. */
  fun destroy(handleId: Long, alive: AtomicBoolean, promise: Promise) {
    session.destroy(handleId, alive, settle(promise))
  }

  fun getDiagnostics(promise: Promise) {
    try {
      val proc = PhononResults.parseProcStatus(
        try {
          File("/proc/self/status").readText()
        } catch (e: Exception) {
          null
        }
      )
      val core = if (shimLoaded) PhononNative.nativeDiagnostics() else null
      val busy = if (shimLoaded) PhononNative.nativeBusy() else "idle"
      promise.resolve(Arguments.makeNativeMap(PhononResults.diagnostics(core, busy, proc)))
    } catch (t: Throwable) {
      promise.reject(PhononSession.INTERNAL, "Phonon diagnostics failed: ${t.message}", t)
    }
  }

  /**
   * RNSpeechModule.invalidate() only (real module teardown, e.g. an RN reload; never
   * setEngine): see [PhononSession.onModuleInvalidated].
   */
  fun onModuleInvalidated(alive: AtomicBoolean) {
    session.onModuleInvalidated(alive)
  }

  // ---- helpers ------------------------------------------------------------------------------

  private fun session(context: Context): PhononSession {
    appContext = context.applicationContext ?: context
    return session
  }

  /** The real natives, capability store and synth thread behind [PhononSession]. */
  private object AndroidHost : PhononSession.Host {
    private val context: Context get() = checkNotNull(appContext) { "Phonon used before create" }

    override fun probe() = PhononBridge.probe(context)
    override fun cachedReason() = cachedSupport?.reason
    override fun storedRecord() = store(context).read()
    override fun resetSupport() {
      PhononBridge.resetSupport(context)
    }
    override fun recordFailure(reason: String, detail: String, modelPath: String, modelStamp: String) =
      PhononBridge.recordFailure(context, reason, detail, modelPath, modelStamp)
    override fun shimLoaded() = shimLoaded
    override fun execute(job: Runnable) = executor.execute(job)
    override fun resolveThreads(requested: Int) =
      PhononThreads.resolve(requested, PhononThreads.readCpuMaxFreqs(), Runtime.getRuntime().availableProcessors())
    override fun setEnv(name: String, value: String) = Os.setenv(name, value, true)
    override fun log(warn: Boolean, message: String) {
      if (warn) Log.w(TAG, message) else Log.i(TAG, message)
    }

    override fun loadLibrary() = PhononNative.nativeLoadLibrary(PhononNative.LIBRARY)
    override fun create(modelDir: String, language: String, computeUnit: String) =
      PhononNative.nativeCreate(modelDir, language, computeUnit)
    override fun synthesize(
      handleId: Long,
      requestId: Long,
      text: String,
      voice: String,
      language: String,
      enqueuedAtMs: Double,
      out: DoubleArray
    ) = PhononNative.nativeSynthesize(handleId, requestId, text, voice, language, enqueuedAtMs, out)
    override fun destroy(handleId: Long) = PhononNative.nativeDestroy(handleId)
    override fun takePcm16(bufferId: Long, gain: Float) = PhononNative.nativeTakePcm16(bufferId, gain)
    override fun releaseBuffer(bufferId: Long) = PhononNative.nativeReleaseBuffer(bufferId)
    override fun cancelAll() = PhononNative.nativeCancelAll()
    override fun releaseOrphans() {
      PhononNative.nativeReleaseOrphans()
    }
  }

  private fun settle(promise: Promise) = object : PhononSession.Settle {
    override fun resolve(value: Map<String, Any>?) {
      promise.resolve(value?.let { Arguments.makeNativeMap(it) })
    }

    override fun reject(code: String, message: String) {
      promise.reject(code, message)
    }
  }

  private fun ReadableMap.typeOf(key: String): ReadableType? =
    if (hasKey(key)) getType(key) else null

  private fun ReadableMap.stringOr(key: String, fallback: String): String =
    if (typeOf(key) == ReadableType.String) getString(key) ?: fallback else fallback

  private fun ReadableMap.doubleOr(key: String, fallback: Double): Double =
    if (typeOf(key) == ReadableType.Number) getDouble(key) else fallback

  private fun ReadableMap.intOr(key: String, fallback: Int): Int =
    if (typeOf(key) == ReadableType.Number) getDouble(key).toInt() else fallback

  private fun ReadableMap.boolOr(key: String, fallback: Boolean): Boolean =
    if (typeOf(key) == ReadableType.Boolean) getBoolean(key) else fallback

  private fun totalMem(context: Context): Long =
    try {
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }.totalMem
    } catch (e: Exception) {
      0L
    }

  private fun primaryAbi(): String = Build.SUPPORTED_ABIS?.firstOrNull() ?: ""

  private fun isEmulator(): Boolean =
    Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish" ||
      Build.FINGERPRINT?.startsWith("generic") == true

  private fun pageSize(): Long =
    try {
      Os.sysconf(OsConstants._SC_PAGESIZE)
    } catch (e: Throwable) {
      0L
    }
}
