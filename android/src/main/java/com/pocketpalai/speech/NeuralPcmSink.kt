package com.pocketpalai.speech

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactContext

/**
 * Plays interleaved LE Int16 PCM on RNSpeech's neural player, so engine add-ons share its audio focus,
 * ducking and onStart/onFinish events. Callable from any thread; playback runs on the module's single
 * audio executor. The promise resolves when playback finishes or is stopped or replaced, and rejects
 * with "audio_error" on failure. [channels] must be 1 or 2; values below 1 are treated as mono.
 * Calls made from a TurboModule method stay ordered with RNSpeech's JS-called stopAudio/pauseAudio:
 * TurboModule async methods share one native thread, and playback runs on the single audio executor.
 *
 * EXPERIMENTAL: may change in a minor release until a second add-on exists; add-ons should pin a
 * tilde range (~2.7.0) on the core.
 */
interface NeuralPcmSink {
  fun playPcm16(pcm: ByteArray, sampleRate: Int, channels: Int, ducking: Boolean, promise: Promise)

  companion object {
    @JvmStatic
    fun from(context: ReactContext): NeuralPcmSink? =
      context.getNativeModule(RNSpeechModule::class.java)
  }
}

/** Bytes per interleaved Int16 frame, or null when [channels] is not playable (> 2). */
internal fun pcmFrameBytes(channels: Int): Int? {
  val ch = channels.coerceAtLeast(1)
  return if (ch > 2) null else 2 * ch
}
