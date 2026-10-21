package com.pocketpalai.speech

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactContext

/**
 * Plays interleaved LE Int16 PCM on RNSpeech's neural player, so engine add-ons share its audio focus,
 * ducking and onStart/onFinish events. The promise resolves when playback finishes or is
 * stopped or replaced.
 */
interface NeuralPcmSink {
  fun playPcm16(pcm: ByteArray, sampleRate: Int, channels: Int, ducking: Boolean, promise: Promise)

  companion object {
    @JvmStatic
    fun from(context: ReactContext): NeuralPcmSink? =
      context.getNativeModule(RNSpeechModule::class.java)
  }
}
