package com.pocketpalai.speech

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

/**
 * Audio-focus events surfaced to the host module.
 */
sealed class FocusEvent {
  /** Focus (re)gained after a loss. */
  object Gained : FocusEvent()
  /** Full transient loss. Host should pause. */
  object LostTransient : FocusEvent()
  /** Permanent loss. Host should stop and abandon. */
  object Lost : FocusEvent()
  /** May-duck transient loss. Host should lower its volume and keep playing. */
  object Duck : FocusEvent()
  /** Focus regained after a [Duck]. Host should restore its volume. */
  object Unduck : FocusEvent()
}

/**
 * Maps focus changes to [FocusEvent]s. [FocusEvent.Gained] fires only when focus returns after a
 * pause or stop, [FocusEvent.Unduck] only after a duck, and nothing on the initial grant.
 */
internal class FocusEventMapper {
  private enum class Loss { NONE, DUCKED, LOST }

  private var loss = Loss.NONE

  val isDucked: Boolean
    get() = loss == Loss.DUCKED

  fun onFocusChange(focusChange: Int): FocusEvent? = when (focusChange) {
    AudioManager.AUDIOFOCUS_LOSS -> {
      loss = Loss.LOST
      FocusEvent.Lost
    }
    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
      loss = Loss.LOST
      FocusEvent.LostTransient
    }
    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
      if (loss == Loss.NONE) {
        loss = Loss.DUCKED
        FocusEvent.Duck
      } else {
        null
      }
    }
    AudioManager.AUDIOFOCUS_GAIN -> {
      val event = when (loss) {
        Loss.NONE -> null
        Loss.DUCKED -> FocusEvent.Unduck
        Loss.LOST -> FocusEvent.Gained
      }
      loss = Loss.NONE
      event
    }
    else -> null
  }

  fun reset() {
    loss = Loss.NONE
  }
}

/**
 * Owns the neural focus state under the host's [lock]: each focus request gets a generation, a
 * callback is mapped and delivered under [lock] only while its request is the current one, so a
 * duck can't land between a reset and the host's volume change, and a late callback of an
 * abandoned request is dropped.
 */
internal class FocusEventGate(private val lock: Any) {
  private val mapper = FocusEventMapper()
  private var generation = 0

  val isDucked: Boolean
    get() = synchronized(lock) { mapper.isDucked }

  /** The generation the next [begin] returns. */
  fun nextGeneration(): Int = synchronized(lock) { generation + 1 }

  /** Starts a new request and returns its generation; callbacks of earlier ones are dropped. */
  fun begin(): Int {
    synchronized(lock) {
      mapper.reset()
      return ++generation
    }
  }

  /** Ends the current request; its later callbacks are dropped. */
  fun end() {
    synchronized(lock) {
      mapper.reset()
      generation++
    }
  }

  /** Returns false when [gen] is no longer the current request. */
  fun onFocusChange(gen: Int, focusChange: Int, deliver: (FocusEvent) -> Unit): Boolean =
    synchronized(lock) {
      if (gen != generation) return false
      mapper.onFocusChange(focusChange)?.let(deliver)
      true
    }
}

/**
 * Audio focus for neural TTS playback: one `GAIN_TRANSIENT_MAY_DUCK` request, so other apps duck
 * while speech plays. [listener] runs under [lock], on the focus callback thread.
 */
class AudioFocusManager(context: Context, private val lock: Any) {

  private val audioManager: AudioManager =
    context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var audioFocusRequest: AudioFocusRequest? = null
  private var focusChangeListener: AudioManager.OnAudioFocusChangeListener? = null
  private var hasAudioFocus = false

  private val gate = FocusEventGate(lock)

  val isDucked: Boolean
    get() = gate.isDucked

  var listener: ((FocusEvent) -> Unit)? = null

  /**
   * Returns true if focus is held. A new request replaces the current one only when granted; a
   * refused one (during a call) leaves the current request on the stack, so it still gets the
   * call's end.
   */
  fun requestFocus(): Boolean = synchronized(lock) {
    if (hasAudioFocus) {
      return true
    }

    val gen = gate.nextGeneration()
    // A listener per request: AudioManager keys requests by listener, so a shared one would route
    // a late callback of an abandoned request to the next request.
    val focusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
      gate.onFocusChange(gen, focusChange) { event ->
        when (focusChange) {
          AudioManager.AUDIOFOCUS_GAIN -> hasAudioFocus = true
          AudioManager.AUDIOFOCUS_LOSS,
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> hasAudioFocus = false
        }
        listener?.invoke(event)
      }
    }

    var request: AudioFocusRequest? = null
    val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

      request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(audioAttributes)
        .setOnAudioFocusChangeListener(focusListener)
        .build()

      audioManager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(
        focusListener,
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
      )
    }
    if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      return false
    }

    // After a transient loss the previous request is still on the stack: drop it, or it would
    // outlive us.
    releaseRequest()
    gate.begin()
    focusChangeListener = focusListener
    audioFocusRequest = request
    hasAudioFocus = true
    return true
  }

  fun abandonFocus(): Unit = synchronized(lock) {
    if (!releaseRequest()) return
    hasAudioFocus = false
    gate.end()
  }

  /** Abandons the current request, if any; returns false when there was none. Under [lock]. */
  private fun releaseRequest(): Boolean {
    val focusListener = focusChangeListener ?: return false

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let {
        audioManager.abandonAudioFocusRequest(it)
      }
      audioFocusRequest = null
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(focusListener)
    }
    focusChangeListener = null
    return true
  }
}
