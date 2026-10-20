package com.pocketpalai.speech.phonon

import android.os.Build
import android.system.Os
import android.system.OsConstants
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap

/**
 * PhononBridge (flag-off stub). Compiled only when the library is built
 * without RNSpeech_phononEnabled; the real bridge lives in src/phonon/java
 * with the same signatures. Reports `not-compiled`, never loads native code.
 */
object PhononBridge {
  const val NOT_COMPILED = "PHONON_NOT_COMPILED"
  private const val TAG = "Phonon"
  private const val MESSAGE =
    "Phonon is not compiled into this build (set RNSpeech_phononEnabled=true)"

  @Volatile private var logged = false

  /** Support fields as plain values, so they can be unit tested on the JVM. */
  fun supportInfo(): Map<String, Any> = mapOf(
    "supported" to false,
    "reason" to "not-compiled",
    "detail" to "built without RNSpeech_phononEnabled",
    "abi" to (Build.SUPPORTED_ABIS?.firstOrNull() ?: ""),
    "osVersion" to (Build.VERSION.RELEASE ?: ""),
    "libraryVersion" to "",
    "isSimulator" to (Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish"),
    "pageSize" to pageSize().toDouble()
  )

  fun diagnosticsInfo(): Map<String, Any> = mapOf(
    "memKb" to 0.0,
    "peakMemKb" to 0.0,
    "threads" to 0.0,
    "libraryLoaded" to false,
    "handleOpen" to false,
    "liveBuffers" to 0.0,
    "orphanBuffers" to 0.0,
    "busy" to "idle",
    "lastIssuedId" to 0.0,
    "cancelWatermark" to 0.0
  )

  fun getSupport(context: ReactApplicationContext, promise: Promise) {
    if (!logged) {
      logged = true
      Log.i(TAG, "unsupported: not-compiled")
    }
    promise.resolve(Arguments.makeNativeMap(supportInfo()))
  }

  fun needsCompile(modelDir: String, promise: Promise) = reject(promise)

  fun create(
    context: ReactApplicationContext,
    modelDir: String,
    options: ReadableMap,
    promise: Promise
  ) = reject(promise)

  fun allocRequestId(): Long = 0L

  fun synthesize(
    handleId: Long,
    requestId: Long,
    text: String,
    voice: String,
    language: String,
    promise: Promise
  ) = reject(promise)

  fun cancelUpTo(upToRequestId: Long): Boolean = false

  fun cancelAll(): Boolean = false

  fun playBuffer(
    bufferId: Long,
    config: ReadableMap,
    promise: Promise,
    play: (ByteArray, Int, Boolean) -> Unit
  ) = reject(promise)

  fun copyBuffer(bufferId: Long, promise: Promise) = reject(promise)

  fun releaseBuffer(bufferId: Long): Boolean = false

  fun destroy(handleId: Long, promise: Promise) {
    promise.resolve(null)
  }

  fun getDiagnostics(promise: Promise) {
    promise.resolve(Arguments.makeNativeMap(diagnosticsInfo()))
  }

  /** Called from RNSpeechModule.invalidate(); nothing to cancel here. */
  fun onModuleInvalidated() {}

  private fun reject(promise: Promise) {
    promise.reject(NOT_COMPILED, MESSAGE)
  }

  private fun pageSize(): Long =
    try {
      Os.sysconf(OsConstants._SC_PAGESIZE)
    } catch (e: Throwable) {
      0L
    }
}
