package com.pocketpalai.speech

import com.facebook.react.bridge.Promise
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

  @Test
  fun frameBytesClampsToMonoAndRejectsMoreThanStereo() {
    assertEquals(2, pcmFrameBytes(1))
    assertEquals(2, pcmFrameBytes(0))
    assertEquals(2, pcmFrameBytes(-1))
    assertEquals(4, pcmFrameBytes(2))
    assertNull(pcmFrameBytes(3))
    assertNull(pcmFrameBytes(6))
  }

  @Test
  fun partialFrameCountsAsEmpty() {
    fun frames(size: Int, channels: Int) = size / pcmFrameBytes(channels)!!
    assertEquals(0, frames(1, 1))
    assertEquals(1, frames(2, 1))
    assertEquals(0, frames(2, 2))
    assertEquals(0, frames(3, 2))
    assertEquals(1, frames(4, 2))
    assertEquals(1, frames(5, 2))
  }
}
