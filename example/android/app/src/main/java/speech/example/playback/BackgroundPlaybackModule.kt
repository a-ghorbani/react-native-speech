package speech.example.playback

import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/** Starts and stops [BackgroundPlaybackService]. Call start() while the app is in the foreground. */
class BackgroundPlaybackModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  override fun getName(): String = "BackgroundPlayback"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      ContextCompat.startForegroundService(context, Intent(context, BackgroundPlaybackService::class.java))
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("background_playback", e.message, e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    context.stopService(Intent(context, BackgroundPlaybackService::class.java))
    promise.resolve(null)
  }
}

class BackgroundPlaybackPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
    listOf(BackgroundPlaybackModule(context))

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
