package com.pocketpalai.speech

import org.junit.Assert.assertEquals
import org.junit.Test

class NeuralPlaybackStopTest {
  private fun stop(releaseDucking: Boolean, abandonFocus: Boolean): List<String> {
    val calls = mutableListOf<String>()
    stopNeuralPlaybackInOrder(
      releaseDucking,
      abandonFocus,
      cleanupAudio = { calls += "cleanup" },
      deactivateDucking = { calls += "ducking" },
      abandonInterruptionFocus = { calls += "focus" },
    )
    return calls
  }

  @Test
  fun fullStopReleasesTrackThenDuckingThenFocus() {
    assertEquals(listOf("cleanup", "ducking", "focus"), stop(releaseDucking = true, abandonFocus = true))
  }

  @Test
  fun replacementKeepsInterruptionFocus() {
    assertEquals(listOf("cleanup", "ducking"), stop(releaseDucking = true, abandonFocus = false))
  }

  @Test
  fun permanentFocusLossKeepsDuckingRequest() {
    assertEquals(listOf("cleanup", "focus"), stop(releaseDucking = false, abandonFocus = true))
  }
}
