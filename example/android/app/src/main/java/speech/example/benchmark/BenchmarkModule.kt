package speech.example.benchmark

import android.app.ActivityManager
import android.content.Context
import android.os.Debug
import android.os.Trace
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class BenchmarkModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "RNBenchmark"

  private var memoryPollingExecutor: ScheduledExecutorService? = null
  private var memoryPollingFuture: ScheduledFuture<*>? = null
  private var peakNativeHeapMB: Double = 0.0
  private var memorySampleCount: Int = 0
  @Volatile private var isMemoryPolling = false

  @ReactMethod
  fun getMemoryStats(promise: Promise) {
    try {
      val nativeHeapAllocated = Debug.getNativeHeapAllocatedSize() / (1024.0 * 1024.0)
      val nativeHeapFree = Debug.getNativeHeapFreeSize() / (1024.0 * 1024.0)

      val activityManager = reactApplicationContext
        .getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val memoryInfo = ActivityManager.MemoryInfo()
      activityManager.getMemoryInfo(memoryInfo)

      val totalMemMB = memoryInfo.totalMem / (1024.0 * 1024.0)
      val availMemMB = memoryInfo.availMem / (1024.0 * 1024.0)

      val result = Arguments.createMap().apply {
        putDouble("nativeHeapAllocatedMB", nativeHeapAllocated)
        putDouble("nativeHeapFreeMB", nativeHeapFree)
        putDouble("totalMemoryMB", totalMemMB)
        putDouble("availableMemoryMB", availMemMB)
      }
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("memory_error", "Failed to get memory stats: ${e.message}", e)
    }
  }

  @ReactMethod
  fun beginTraceInterval(name: String) {
    Trace.beginSection("TTS:$name")
  }

  @ReactMethod
  fun endTraceInterval(name: String) {
    try {
      Trace.endSection()
    } catch (_: Exception) {
      // Ignore if no matching beginSection
    }
  }

  @ReactMethod
  fun logMarker(message: String) {
    // Emit via android.util.Log directly so logcat captures it regardless
    // of debug/release mode (console.log may be stripped in release).
    android.util.Log.i("RNBenchmark", "[BENCH] $message")
  }

  @ReactMethod
  fun clearMarkers() {
    // No-op on Android — markers are captured via logcat, not file-based.
  }

  @ReactMethod
  fun startMemoryPolling(intervalMs: Double) {
    if (isMemoryPolling) return

    isMemoryPolling = true
    peakNativeHeapMB = 0.0
    memorySampleCount = 0

    memoryPollingExecutor = Executors.newSingleThreadScheduledExecutor()
    memoryPollingFuture = memoryPollingExecutor?.scheduleAtFixedRate({
      try {
        val heapMB = Debug.getNativeHeapAllocatedSize() / (1024.0 * 1024.0)
        if (heapMB > peakNativeHeapMB) {
          peakNativeHeapMB = heapMB
        }
        memorySampleCount++
      } catch (_: Exception) {}
    }, 0, intervalMs.toLong(), TimeUnit.MILLISECONDS)
  }

  @ReactMethod
  fun stopMemoryPolling(promise: Promise) {
    memoryPollingFuture?.cancel(false)
    memoryPollingExecutor?.shutdown()
    memoryPollingFuture = null
    memoryPollingExecutor = null
    isMemoryPolling = false

    val result = Arguments.createMap().apply {
      putDouble("peakNativeHeapMB", peakNativeHeapMB)
      putInt("sampleCount", memorySampleCount)
    }
    promise.resolve(result)
  }

  override fun invalidate() {
    super.invalidate()
    memoryPollingFuture?.cancel(true)
    memoryPollingExecutor?.shutdownNow()
    memoryPollingFuture = null
    memoryPollingExecutor = null
    isMemoryPolling = false
  }
}
