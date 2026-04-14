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
  /** Transient loss (may duck or full transient). Host should pause. */
  object LostTransient : FocusEvent()
  /** Permanent loss. Host should stop and abandon. */
  object Lost : FocusEvent()
}

/**
 * Helper class to manage audio focus for neural TTS playback.
 *
 * Consumers install a [listener] and call [requestFocus] / [abandonFocus].
 * The manager tracks whether we were in a loss state and fires [FocusEvent.Gained]
 * only when focus returns after a loss (not on the initial grant).
 */
class AudioFocusManager(context: Context) {

  private val audioManager: AudioManager =
    context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var audioFocusRequest: AudioFocusRequest? = null
  private var hasAudioFocus = false
  private var wasLost = false

  var listener: ((FocusEvent) -> Unit)? = null

  private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
    when (focusChange) {
      AudioManager.AUDIOFOCUS_LOSS -> {
        hasAudioFocus = false
        wasLost = true
        listener?.invoke(FocusEvent.Lost)
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        hasAudioFocus = false
        wasLost = true
        listener?.invoke(FocusEvent.LostTransient)
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        hasAudioFocus = true
        if (wasLost) {
          wasLost = false
          listener?.invoke(FocusEvent.Gained)
        }
      }
    }
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
      wasLost = false
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
    wasLost = false
  }
}
