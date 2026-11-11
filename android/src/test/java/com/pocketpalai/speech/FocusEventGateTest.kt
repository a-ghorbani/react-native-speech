package com.pocketpalai.speech

import android.media.AudioManager.AUDIOFOCUS_GAIN
import android.media.AudioManager.AUDIOFOCUS_LOSS
import android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
import android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
   * #51 case 2: a duck callback arrives while the host holds its lock to end the request and start
   * a new one (stop, then play). The duck must neither be recorded before the lock nor applied
   * after the new request: nothing would restore it.
   */
  @Test(timeout = 5000)
  fun duckRacingAReRequestIsDroppedNotStranded() {
    val old = gate.begin()
    lateinit var callback: Thread
    synchronized(lock) {
      callback = Thread { change(old, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) }
      callback.start()
      while (callback.state != Thread.State.BLOCKED && callback.state != Thread.State.TERMINATED) {
        Thread.sleep(1)
      }
      assertEquals(Thread.State.BLOCKED, callback.state)
      // Inside the host's critical section: the duck must not have been recorded yet.
      assertFalse(gate.isDucked)
      gate.end()
      gate.begin()
    }
    callback.join(1000)
    assertFalse(callback.isAlive)
    assertFalse(gate.isDucked)
    assertTrue(delivered.isEmpty())
  }

  /** A request is committed only when granted: until then the current one keeps its callbacks. */
  @Test
  fun pendingRequestTakesOverOnlyOnBegin() {
    val current = gate.begin()
    val pending = gate.nextGeneration()
    assertFalse(change(pending, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
    assertTrue(change(current, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
    assertEquals(pending, gate.begin())
    assertFalse(change(current, AUDIOFOCUS_GAIN))
    assertTrue(change(pending, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
  }

  @Test
  fun resetDropsAnUnrestoredDuck() {
    val gen = gate.begin()
    change(gen, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
    gate.end()
    assertFalse(gate.isDucked)
  }

  /** #133: a held request abandoned during a transient loss goes after the loss's regain. */
  @Test
  fun abandonDuringATransientLossWaitsForTheRegain() {
    val gen = gate.begin()
    change(gen, AUDIOFOCUS_LOSS_TRANSIENT)
    assertTrue(gate.isLost)
    assertFalse(gate.mayAbandonNow())
    assertFalse(gate.takeAbandonOnRegain())
    change(gen, AUDIOFOCUS_GAIN)
    assertEquals(listOf(FocusEvent.LostTransient, FocusEvent.Gained), delivered)
    assertTrue(gate.takeAbandonOnRegain())
    assertFalse(gate.takeAbandonOnRegain())
  }

  @Test
  fun aChunkPlayingAgainKeepsTheRequestAfterTheRegain() {
    val gen = gate.begin()
    change(gen, AUDIOFOCUS_LOSS_TRANSIENT)
    assertFalse(gate.mayAbandonNow())
    gate.keep()
    change(gen, AUDIOFOCUS_GAIN)
    assertFalse(gate.takeAbandonOnRegain())
  }

  @Test
  fun abandonIsImmediateWhenNotLostOrAfterAPermanentLoss() {
    var gen = gate.begin()
    assertTrue(gate.mayAbandonNow())
    change(gen, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
    assertTrue(gate.mayAbandonNow())
    gen = gate.begin()
    change(gen, AUDIOFOCUS_LOSS)
    assertTrue(gate.isLost)
    assertTrue(gate.mayAbandonNow())
  }
}
