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
    assertEquals(samsung, VoiceInstallerTarget.enginePackage(samsung, google, google, both::contains))
  }

  @Test
  fun instanceDefaultWhenNothingSelected() {
    assertEquals(google, VoiceInstallerTarget.enginePackage(null, google, samsung, both::contains))
  }

  @Test
  fun settingDefaultWhenTtsNotCreatedYet() {
    assertEquals(samsung, VoiceInstallerTarget.enginePackage(null, null, samsung, both::contains))
    assertEquals(samsung, VoiceInstallerTarget.enginePackage("", "", samsung, both::contains))
  }

  @Test
  fun noPackageWhenTheEngineHasNoInstaller() {
    assertNull(VoiceInstallerTarget.enginePackage(null, "com.example.noinstaller", google, both::contains))
  }

  @Test
  fun noPackageWhenNoEngineIsKnown() {
    assertNull(VoiceInstallerTarget.enginePackage(null, null, null, both::contains))
  }
}
