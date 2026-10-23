package speech.example.benchmark

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import java.util.concurrent.Executors

/** Self-test helpers for the playback-edges suite (src/selftest/edgesSelfTest.ts). */
class PlaybackProbeModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "RNPlaybackProbe"

  companion object {
    private const val CHIME_CHANNEL = "edges_chime"
    private const val CHIME_ID = 4545
  }

  private val executor = Executors.newSingleThreadExecutor()
  private val audioManager: AudioManager
    get() = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private fun outputRoute(): WritableArray = Arguments.createArray().apply {
    audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      .filter { it.isSink }
      .forEach { pushString(deviceType(it.type)) }
  }

  private fun deviceType(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired_headphones"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bt_a2dp"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bt_sco"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "usb_headset"
    AudioDeviceInfo.TYPE_USB_DEVICE -> "usb_device"
    AudioDeviceInfo.TYPE_TELEPHONY -> "telephony"
    else -> "type_$type"
  }

  private fun hiddenOutputLatencyMs(): Int = try {
    val m = AudioManager::class.java.getMethod("getOutputLatency", Int::class.javaPrimitiveType)
    m.invoke(audioManager, AudioManager.STREAM_MUSIC) as Int
  } catch (_: Throwable) {
    -1
  }

  /** Head position (what the library's end marker follows) minus the frame presented now. */
  private fun probeLatencyMs(): Double {
    val rate = 24000
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val format = AudioFormat.Builder()
      .setSampleRate(rate)
      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .build()
    val silence = ByteArray(rate * 2)
    val track = AudioTrack.Builder()
      .setAudioAttributes(attrs)
      .setAudioFormat(format)
      .setBufferSizeInBytes(silence.size)
      .setTransferMode(AudioTrack.MODE_STATIC)
      .build()
    try {
      track.write(silence, 0, silence.size)
      track.play()
      val ts = AudioTimestamp()
      val samples = mutableListOf<Double>()
      val deadline = System.nanoTime() + 700_000_000L
      while (System.nanoTime() < deadline && samples.size < 5) {
        Thread.sleep(80)
        val head = track.playbackHeadPosition.toLong()
        if (track.getTimestamp(ts) && ts.framePosition > 0) {
          val presented = ts.framePosition + (System.nanoTime() - ts.nanoTime) * rate / 1e9
          samples.add((head - presented) * 1000.0 / rate)
        }
      }
      return if (samples.isEmpty()) -1.0 else samples.sorted()[samples.size / 2]
    } finally {
      track.stop()
      track.release()
    }
  }

  @ReactMethod
  fun getOutputInfo(promise: Promise) {
    executor.execute {
      try {
        val rate = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull() ?: 0
        val frames = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toIntOrNull() ?: 0
        promise.resolve(Arguments.createMap().apply {
          putDouble("outputLatencyMs", hiddenOutputLatencyMs().toDouble())
          putDouble("probeLatencyMs", probeLatencyMs())
          putDouble("bufferMs", if (rate > 0) frames * 1000.0 / rate else -1.0)
          putInt("sampleRate", rate)
          putArray("route", outputRoute())
        })
      } catch (e: Exception) {
        promise.reject("probe_error", e.message, e)
      }
    }
  }

  /** States of the library's speech tracks (USAGE_MEDIA/CONTENT_TYPE_SPEECH): 2 started, 3 paused, 4 stopped. */
  private fun speechPlayerStates(): WritableArray = Arguments.createArray().apply {
    val getState = try {
      AudioPlaybackConfiguration::class.java.getMethod("getPlayerState")
    } catch (_: Throwable) {
      null
    }
    audioManager.activePlaybackConfigurations
      .filter {
        it.audioAttributes.usage == AudioAttributes.USAGE_MEDIA &&
          it.audioAttributes.contentType == AudioAttributes.CONTENT_TYPE_SPEECH
      }
      .forEach {
        val state = try {
          getState?.invoke(it) as? Int ?: -1
        } catch (_: Throwable) {
          -1
        }
        pushInt(state)
      }
  }

  /** Speech player states every 100 ms for `holdMs`; `t` is ms since `t0`. */
  private fun sampleWhile(holdMs: Long, t0: Long): WritableArray {
    val samples = Arguments.createArray()
    val deadline = System.currentTimeMillis() + holdMs
    while (System.currentTimeMillis() < deadline) {
      samples.pushMap(Arguments.createMap().apply {
        putDouble("t", (System.currentTimeMillis() - t0).toDouble())
        putArray("players", speechPlayerStates())
      })
      Thread.sleep(100)
    }
    return samples
  }

  @ReactMethod
  fun interrupt(kind: String, holdMs: Double, promise: Promise) {
    executor.execute {
      try {
        val gain = when (kind) {
          "transient" -> AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
          "duck", "notification" -> AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
          else -> AudioManager.AUDIOFOCUS_GAIN
        }
        val attrs = if (kind == "notification") {
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        } else {
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()
        }
        val request = AudioFocusRequest.Builder(gain)
          .setAudioAttributes(attrs)
          .setOnAudioFocusChangeListener { }
          .build()
        val t0 = System.currentTimeMillis()
        val before = speechPlayerStates()
        val granted = audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        val samples = sampleWhile(holdMs.toLong(), t0)
        audioManager.abandonAudioFocusRequest(request)
        promise.resolve(Arguments.createMap().apply {
          putBoolean("granted", granted)
          putArray("before", before)
          putArray("samples", samples)
        })
      } catch (e: Exception) {
        promise.reject("probe_error", e.message, e)
      }
    }
  }

  /** Posts a notification on a default-sound channel, keeps it `holdMs`, then cancels it. */
  @ReactMethod
  fun postNotification(holdMs: Double, promise: Promise) {
    executor.execute {
      try {
        val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
          NotificationChannel(CHIME_CHANNEL, "Self-test chime", NotificationManager.IMPORTANCE_DEFAULT)
        )
        val notification = Notification.Builder(reactApplicationContext, CHIME_CHANNEL)
          .setSmallIcon(android.R.drawable.ic_dialog_info)
          .setContentTitle("Playback self-test")
          .setContentText("Notification chime during speech")
          .build()
        val t0 = System.currentTimeMillis()
        val before = speechPlayerStates()
        nm.notify(CHIME_ID, notification)
        val samples = sampleWhile(holdMs.toLong(), t0)
        nm.cancel(CHIME_ID)
        promise.resolve(Arguments.createMap().apply {
          putBoolean("enabled", nm.areNotificationsEnabled())
          putInt("ringerMode", audioManager.ringerMode)
          putInt("interruptionFilter", nm.currentInterruptionFilter)
          putArray("before", before)
          putArray("samples", samples)
        })
      } catch (e: Exception) {
        promise.reject("probe_error", e.message, e)
      }
    }
  }

  @ReactMethod
  fun routeChange(holdMs: Double, promise: Promise) {
    executor.execute {
      val am = audioManager
      val previousMode = am.mode
      try {
        val before = outputRoute()
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          am.availableCommunicationDevices
            .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
            ?.let { am.setCommunicationDevice(it) }
        }
        Thread.sleep(holdMs.toLong() / 2)
        val during = outputRoute()
        Thread.sleep(holdMs.toLong() / 2)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          am.clearCommunicationDevice()
        }
        am.mode = previousMode
        promise.resolve(Arguments.createMap().apply {
          putArray("before", before)
          putArray("during", during)
          putArray("after", outputRoute())
        })
      } catch (e: Exception) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          am.clearCommunicationDevice()
        }
        am.mode = previousMode
        promise.reject("probe_error", e.message, e)
      }
    }
  }

  @ReactMethod
  fun recordProbe(ms: Double, promise: Promise) {
    executor.execute {
      val result = Arguments.createMap()
      if (reactApplicationContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
        PackageManager.PERMISSION_GRANTED
      ) {
        result.putBoolean("started", false)
        result.putInt("bytes", 0)
        result.putString("error", "no_permission")
        promise.resolve(result)
        return@execute
      }
      val rate = 16000
      val minBuf = AudioRecord.getMinBufferSize(
        rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
      )
      var record: AudioRecord? = null
      try {
        record = AudioRecord(
          MediaRecorder.AudioSource.VOICE_RECOGNITION,
          rate,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          minBuf * 2
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
          throw IllegalStateException("AudioRecord not initialized")
        }
        record.startRecording()
        val started = record.recordingState == AudioRecord.RECORDSTATE_RECORDING
        val buf = ByteArray(minBuf)
        var total = 0
        val deadline = System.nanoTime() + (ms * 1e6).toLong()
        while (started && System.nanoTime() < deadline) {
          val n = record.read(buf, 0, buf.size)
          if (n < 0) throw IllegalStateException("read error $n")
          total += n
        }
        record.stop()
        result.putBoolean("started", started)
        result.putInt("bytes", total)
      } catch (e: Exception) {
        result.putBoolean("started", false)
        result.putInt("bytes", 0)
        result.putString("error", e.message ?: e.javaClass.simpleName)
      } finally {
        record?.release()
      }
      promise.resolve(result)
    }
  }

  override fun invalidate() {
    super.invalidate()
    executor.shutdownNow()
  }
}
