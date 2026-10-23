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

  @Volatile private var loss = Loss.NONE

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
 * Helper class to manage audio focus for neural TTS playback.
 *
 * Consumers install a [listener] and call [requestFocus] / [abandonFocus].
 */
class AudioFocusManager(context: Context) {

  private val audioManager: AudioManager =
    context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var audioFocusRequest: AudioFocusRequest? = null
  private var hasAudioFocus = false

  private val mapper = FocusEventMapper()

  val isDucked: Boolean
    get() = mapper.isDucked

  var listener: ((FocusEvent) -> Unit)? = null

  private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
    when (focusChange) {
      AudioManager.AUDIOFOCUS_GAIN -> hasAudioFocus = true
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> hasAudioFocus = false
    }
    mapper.onFocusChange(focusChange)?.let { listener?.invoke(it) }
  }

  /** Returns true if focus was granted. */
  fun requestFocus(): Boolean {
    if (hasAudioFocus) {
      return true
    }

    val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

      audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(audioAttributes)
        .setOnAudioFocusChangeListener(audioFocusChangeListener)
        .build()

      audioManager.requestAudioFocus(audioFocusRequest!!)
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(
        audioFocusChangeListener,
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
      )
    }

    hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    if (hasAudioFocus) {
      mapper.reset()
    }
    return hasAudioFocus
  }

  fun abandonFocus() {
    if (!hasAudioFocus && audioFocusRequest == null) {
      return
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let {
        audioManager.abandonAudioFocusRequest(it)
      }
      audioFocusRequest = null
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(audioFocusChangeListener)
    }

    hasAudioFocus = false
    mapper.reset()
  }
}
