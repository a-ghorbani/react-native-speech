package com.pocketpalai.speech

import com.facebook.react.bridge.Promise
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NeuralPcmSinkTest {
  @Test
  fun rnSpeechModuleIsTheSink() {
    assertTrue(NeuralPcmSink::class.java.isAssignableFrom(RNSpeechModule::class.java))
  }

  @Test
  fun playPcm16KeepsItsPublicSignature() {
    val method = NeuralPcmSink::class.java.getMethod(
      "playPcm16",
      ByteArray::class.java,
      Int::class.javaPrimitiveType,
      Int::class.javaPrimitiveType,
      Boolean::class.javaPrimitiveType,
      Promise::class.java,
    )
    assertEquals(Void.TYPE, method.returnType)
    RNSpeechModule::class.java.getMethod(method.name, *method.parameterTypes)
  }
}
