package com.pocketpalai.speech

import android.media.AudioManager.AUDIOFOCUS_GAIN
import android.media.AudioManager.AUDIOFOCUS_LOSS
import android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
import android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FocusEventMapperTest {
  private fun events(vararg changes: Int): List<FocusEvent?> {
    val mapper = FocusEventMapper()
    return changes.map(mapper::onFocusChange)
  }

  @Test
  fun mayDuckLossDucksAndGainUnducks() {
    assertEquals(listOf(FocusEvent.Duck, FocusEvent.Unduck), events(AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK, AUDIOFOCUS_GAIN))
  }

  @Test
  fun transientLossPausesAndGainEndsTheInterruption() {
    assertEquals(listOf(FocusEvent.LostTransient, FocusEvent.Gained), events(AUDIOFOCUS_LOSS_TRANSIENT, AUDIOFOCUS_GAIN))
  }

  @Test
  fun permanentLossStops() {
    assertEquals(listOf(FocusEvent.Lost, FocusEvent.Gained), events(AUDIOFOCUS_LOSS, AUDIOFOCUS_GAIN))
  }

  @Test
  fun duckEscalatingToTransientLossEndsWithGained() {
    assertEquals(
      listOf(FocusEvent.Duck, FocusEvent.LostTransient, FocusEvent.Gained),
      events(AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK, AUDIOFOCUS_LOSS_TRANSIENT, AUDIOFOCUS_GAIN),
    )
  }

  @Test
  fun duckEscalatingToPermanentLossStops() {
    assertEquals(
      listOf(FocusEvent.Duck, FocusEvent.Lost),
      events(AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK, AUDIOFOCUS_LOSS),
    )
  }

  @Test
  fun mayDuckWhilePausedStaysPaused() {
    assertEquals(
      listOf(FocusEvent.LostTransient, null, FocusEvent.Gained),
      events(AUDIOFOCUS_LOSS_TRANSIENT, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK, AUDIOFOCUS_GAIN),
    )
  }

  @Test
  fun gainWithoutLossIsSilent() {
    assertEquals(listOf(null), events(AUDIOFOCUS_GAIN))
  }

  @Test
  fun isDuckedTracksTheDuckUntilGainOrReset() {
    val mapper = FocusEventMapper()
    mapper.onFocusChange(AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
    assertTrue(mapper.isDucked)
    mapper.onFocusChange(AUDIOFOCUS_GAIN)
    assertFalse(mapper.isDucked)

    mapper.onFocusChange(AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
    mapper.reset()
    assertFalse(mapper.isDucked)
    assertEquals(null, mapper.onFocusChange(AUDIOFOCUS_GAIN))
  }

  @Test
  fun escalationClearsTheDuck() {
    val mapper = FocusEventMapper()
    mapper.onFocusChange(AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
    mapper.onFocusChange(AUDIOFOCUS_LOSS_TRANSIENT)
    assertFalse(mapper.isDucked)
  }
}
