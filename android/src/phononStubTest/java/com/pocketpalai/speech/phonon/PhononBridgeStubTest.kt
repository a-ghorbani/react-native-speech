package com.pocketpalai.speech.phonon

import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Flag-off stub contract: reports not-compiled, never does native work. */
class PhononBridgeStubTest {
  private class RecordingPromise : Promise {
    var resolved = false
    var value: Any? = null
    var code: String? = null

    override fun resolve(value: Any?) {
      resolved = true
      this.value = value
    }
    override fun reject(code: String?, message: String?) { this.code = code }
    override fun reject(code: String?, throwable: Throwable?) { this.code = code }
    override fun reject(code: String?, message: String?, throwable: Throwable?) { this.code = code }
    override fun reject(throwable: Throwable) { code = "throwable" }
    override fun reject(throwable: Throwable, userInfo: WritableMap) { code = "throwable" }
    override fun reject(code: String?, userInfo: WritableMap) { this.code = code }
    override fun reject(code: String?, throwable: Throwable?, userInfo: WritableMap) { this.code = code }
    override fun reject(code: String?, message: String?, userInfo: WritableMap) { this.code = code }
    override fun reject(code: String?, message: String?, throwable: Throwable?, userInfo: WritableMap?) {
      this.code = code
    }
    @Deprecated("test only")
    override fun reject(message: String) { code = "message" }
  }

  @Test
  fun supportInfoReportsNotCompiled() {
    val info = PhononBridge.supportInfo()
    assertEquals(false, info["supported"])
    assertEquals("not-compiled", info["reason"])
    assertEquals("", info["libraryVersion"])
    for (key in listOf("detail", "abi", "osVersion", "isSimulator", "pageSize")) {
      assertTrue("missing $key", info.containsKey(key))
    }
  }

  @Test
  fun diagnosticsReportNothingLoaded() {
    val diag = PhononBridge.diagnosticsInfo()
    assertEquals(false, diag["libraryLoaded"])
    assertEquals(false, diag["handleOpen"])
    assertEquals(0.0, diag["liveBuffers"])
    assertEquals("idle", diag["busy"])
  }

  @Test
  fun syncMethodsReturnValues() {
    assertEquals(0L, PhononBridge.allocRequestId())
    assertFalse(PhononBridge.cancelUpTo(5))
    assertFalse(PhononBridge.cancelAll())
    assertFalse(PhononBridge.releaseBuffer(1))
    assertFalse(PhononBridge.releaseBuffer(1))
  }

  @Test
  fun workMethodsRejectNotCompiled() {
    val calls = listOf<(Promise) -> Unit>(
      { PhononBridge.needsCompile("/models", it) },
      { PhononBridge.synthesize(1, 1, "hi", "", "en", it) },
      { PhononBridge.playBuffer(1, JavaOnlyMap(), it) },
      { PhononBridge.copyBuffer(1, it) }
    )
    for (call in calls) {
      val promise = RecordingPromise()
      call(promise)
      assertFalse(promise.resolved)
      assertEquals(PhononBridge.NOT_COMPILED, promise.code)
    }
  }

  @Test
  fun destroyResolves() {
    val promise = RecordingPromise()
    PhononBridge.destroy(1, promise)
    assertTrue(promise.resolved)
    assertNull(promise.value)
    assertNull(promise.code)
  }
}
