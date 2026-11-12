package com.pocketpalai.speech

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceInstallerTargetTest {
  private val samsung = "com.samsung.SMT"
  private val google = "com.google.android.tts"
  private val both = setOf(samsung, google)

  @Test
  fun selectedEngineWins() {
    assertEquals(samsung, VoiceInstallerTarget.enginePackage(samsung, google, both::contains))
  }

  @Test
  fun defaultEngineWhenNothingSelected() {
    assertEquals(google, VoiceInstallerTarget.enginePackage(null, google, both::contains))
    assertEquals(google, VoiceInstallerTarget.enginePackage("", google, both::contains))
  }

  @Test
  fun noPackageWhenTheEngineHasNoInstaller() {
    assertNull(VoiceInstallerTarget.enginePackage("com.example.noinstaller", google, both::contains))
  }

  @Test
  fun noPackageWhenNoEngineIsKnown() {
    assertNull(VoiceInstallerTarget.enginePackage(null, null, both::contains))
  }
}
