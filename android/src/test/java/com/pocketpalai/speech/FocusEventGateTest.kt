package com.pocketpalai.speech

import android.media.AudioManager.AUDIOFOCUS_GAIN
import android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class FocusEventGateTest {
  private val lock = Any()
  private val gate = FocusEventGate(lock)
  private val delivered = mutableListOf<FocusEvent>()

  private fun change(gen: Int, focusChange: Int) =
    gate.onFocusChange(gen, focusChange) { delivered += it }

  @Test
  fun duckAndRestoreOfTheCurrentRequestAreDelivered() {
    val gen = gate.begin()
    change(gen, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
    assertTrue(gate.isDucked)
    change(gen, AUDIOFOCUS_GAIN)
    assertFalse(gate.isDucked)
    assertEquals(listOf(FocusEvent.Duck, FocusEvent.Unduck), delivered)
  }

  @Test
  fun eventsAreDeliveredUnderTheHostLock() {
    val gen = gate.begin()
    var held = false
    gate.onFocusChange(gen, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) { held = Thread.holdsLock(lock) }
    assertTrue(held)
  }

  @Test
  fun lateCallbackOfAnAbandonedRequestIsDropped() {
    val old = gate.begin()
    gate.end()
    gate.begin()
    assertFalse(change(old, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
    assertFalse(gate.isDucked)
    assertTrue(delivered.isEmpty())
  }

  /**
   * #51 case 2: the duck callback arrives while the host holds its lock to replace the track
   * (abandon + new request). The duck must neither be recorded before the lock nor applied after
   * the new request: nothing would restore it.
   */
  @Test
  fun duckRacingAReplaceIsDroppedNotStranded() {
    val old = gate.begin()
    val callbackBlocked = CountDownLatch(1)
    lateinit var callback: Thread
    synchronized(lock) {
      callback = Thread { change(old, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) }
      callback.start()
      while (callback.state != Thread.State.BLOCKED) Thread.sleep(1)
      callbackBlocked.countDown()
      // Inside the replace: the duck must not have been recorded yet.
      assertFalse(gate.isDucked)
      gate.end()
      gate.begin()
    }
    assertTrue(callbackBlocked.await(1, TimeUnit.SECONDS))
    callback.join(1000)
    assertFalse(gate.isDucked)
    assertTrue(delivered.isEmpty())
  }

  @Test
  fun resetDropsAnUnrestoredDuck() {
    val gen = gate.begin()
    change(gen, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
    gate.end()
    assertFalse(gate.isDucked)
  }
}
