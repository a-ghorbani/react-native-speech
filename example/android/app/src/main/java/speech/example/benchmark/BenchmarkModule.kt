package speech.example.benchmark

import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Debug
import android.os.Trace
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
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

  /**
   * Total PSS (proportional set size) of the current process, in MB.
   *
   * Matches what Android Studio's memory profiler shows and what lmkd uses
   * for low-memory kills. Includes mmap'd model files, JVM/ART heap, and
   * a fair share of shared pages — unlike [Debug.getNativeHeapAllocatedSize]
   * which only covers the C/C++ malloc heap and misses the mmap'd ONNX
   * weights entirely.
   *
   * Backed by /proc/self/smaps_rollup on Linux 4.14+ (Android 9+), so the
   * call is cheap enough for ~100 ms polling on modern devices.
   */
  private fun footprintMB(): Double = Debug.getPss() / 1024.0

  @ReactMethod
  fun getMemoryStats(promise: Promise) {
    try {
      val footprint = footprintMB()

      val activityManager = reactApplicationContext
        .getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val memoryInfo = ActivityManager.MemoryInfo()
      activityManager.getMemoryInfo(memoryInfo)

      val totalMemMB = memoryInfo.totalMem / (1024.0 * 1024.0)
      val availMemMB = memoryInfo.availMem / (1024.0 * 1024.0)

      // Key names kept for JSON/schema backward compat; the value is now
      // total PSS (profiler-equivalent), not malloc heap size.
      val result = Arguments.createMap().apply {
        putDouble("nativeHeapAllocatedMB", footprint)
        putDouble("nativeHeapFreeMB", 0.0)
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

  /**
   * Draw the current activity's window into a PNG at [path] (self-test
   * evidence). Software draw of the view tree: enough for UI state, not
   * for SurfaceView/TextureView content.
   */
  @ReactMethod
  fun captureScreen(path: String, promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("no_activity", "No current activity")
      return
    }
    activity.runOnUiThread {
      try {
        val view = activity.window.decorView.rootView
        if (view.width <= 0 || view.height <= 0) {
          promise.reject("capture_error", "Window has no size yet")
          return@runOnUiThread
        }
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val file = File(path)
        file.parentFile?.mkdirs()
        FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        promise.resolve(file.absolutePath)
      } catch (e: Exception) {
        promise.reject("capture_error", "Failed to capture screen: ${e.message}", e)
      }
    }
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
        val mb = footprintMB()
        if (mb > peakNativeHeapMB) {
          peakNativeHeapMB = mb
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
