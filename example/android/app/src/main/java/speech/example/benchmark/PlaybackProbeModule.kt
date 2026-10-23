package speech.example.benchmark

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
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

  @ReactMethod
  fun interrupt(kind: String, holdMs: Double, promise: Promise) {
    executor.execute {
      try {
        val gain = when (kind) {
          "transient" -> AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
          "duck" -> AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
          else -> AudioManager.AUDIOFOCUS_GAIN
        }
        val request = AudioFocusRequest.Builder(gain)
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
              .build()
          )
          .setOnAudioFocusChangeListener { }
          .build()
        val granted = audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        Thread.sleep(holdMs.toLong())
        audioManager.abandonAudioFocusRequest(request)
        promise.resolve(Arguments.createMap().apply { putBoolean("granted", granted) })
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
