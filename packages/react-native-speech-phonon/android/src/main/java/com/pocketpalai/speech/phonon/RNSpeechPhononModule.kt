package com.pocketpalai.speech.phonon

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import com.pocketpalai.speech.NeuralPcmSink
import java.util.concurrent.atomic.AtomicBoolean

@ReactModule(name = RNSpeechPhononModule.NAME)
class RNSpeechPhononModule(reactContext: ReactApplicationContext) :
  NativeSpeechPhononSpec(reactContext) {

  // Cleared by invalidate(), so only this module's pending promises are dropped.
  private val alive = AtomicBoolean(true)

  override fun getName(): String = NAME

  override fun getSupport(promise: Promise) {
    PhononBridge.getSupport(reactApplicationContext, promise)
  }

  override fun needsCompile(modelDir: String, promise: Promise) {
    PhononBridge.needsCompile(modelDir, promise)
  }

  override fun create(modelDir: String, options: ReadableMap, promise: Promise) {
    PhononBridge.create(reactApplicationContext, modelDir, options, alive, promise)
  }

  override fun allocRequestId(): Double = PhononBridge.allocRequestId().toDouble()

  override fun synthesize(
    handleId: Double,
    requestId: Double,
    text: String,
    voice: String,
    language: String,
    promise: Promise
  ) {
    PhononBridge.synthesize(handleId.toLong(), requestId.toLong(), text, voice, language, alive, promise)
  }

  override fun cancel(upToRequestId: Double): Boolean = PhononBridge.cancelUpTo(upToRequestId.toLong())

  override fun cancelAll(): Boolean = PhononBridge.cancelAll()

  override fun playBuffer(bufferId: Double, config: ReadableMap, promise: Promise) {
    PhononBridge.playBuffer(bufferId.toLong(), config, promise) { pcm, sampleRate, ducking ->
      val sink = NeuralPcmSink.from(reactApplicationContext)
      if (sink == null) {
        promise.reject(PhononSession.INTERNAL, "The RNSpeech native module is not available")
      } else {
        sink.playPcm16(pcm, sampleRate, 1, ducking, promise)
      }
    }
  }

  override fun copyBuffer(bufferId: Double, promise: Promise) {
    PhononBridge.copyBuffer(bufferId.toLong(), promise)
  }

  override fun releaseBuffer(bufferId: Double): Boolean = PhononBridge.releaseBuffer(bufferId.toLong())

  override fun destroy(handleId: Double, promise: Promise) {
    PhononBridge.destroy(handleId.toLong(), alive, promise)
  }

  override fun getDiagnostics(promise: Promise) {
    PhononBridge.getDiagnostics(promise)
  }

  override fun resetSupport(promise: Promise) {
    PhononBridge.resetSupport(reactApplicationContext, promise)
  }

  override fun invalidate() {
    super.invalidate()
    // Phonon state is process-wide: cancel only, never destroy or join.
    PhononBridge.onModuleInvalidated(alive)
  }

  companion object {
    const val NAME = "RNSpeechPhonon"
  }
}
