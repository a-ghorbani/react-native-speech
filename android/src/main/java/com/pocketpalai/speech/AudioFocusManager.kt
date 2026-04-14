package com.pocketpalai.speech

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

/**
 * Helper class to manage audio focus for neural TTS playback
 */
class AudioFocusManager(context: Context) {
  
  private val audioManager: AudioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var audioFocusRequest: AudioFocusRequest? = null
  private var hasAudioFocus = false
  
  private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
    when (focusChange) {
      AudioManager.AUDIOFOCUS_LOSS -> {
        // Permanent loss of audio focus - stop playback
        hasAudioFocus = false
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        // Temporary loss of audio focus - pause playback
        hasAudioFocus = false
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        // Temporary loss of audio focus but can duck (lower volume)
        // We'll let the system handle ducking
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        // Regained audio focus
        hasAudioFocus = true
      }
    }
  }
  
  fun requestAudioFocus(): Boolean {
    if (hasAudioFocus) {
      return true
    }
    
    val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
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
        AudioManager.STREAM_NOTIFICATION,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
      )
    }
    
    hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    return hasAudioFocus
  }
  
  fun abandonAudioFocus() {
    if (!hasAudioFocus) {
      return
    }
    
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let {
        audioManager.abandonAudioFocusRequest(it)
      }
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(audioFocusChangeListener)
    }
    
    hasAudioFocus = false
  }
}

