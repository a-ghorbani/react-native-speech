package com.pocketpalai.speech

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IdleFocusReleaseTest {
  private val lock = Any()
  private val scheduled = mutableListOf<Pair<Long, Runnable>>()
  private var released = 0
  private val idle = IdleFocusRelease(lock, 5000L, { ms, task -> scheduled += ms to task }) {
    assertTrue(Thread.holdsLock(lock))
    released++
  }

  @Test
  fun aGapLongerThanTheGraceReleasesFocus() {
    idle.arm()
    assertEquals(5000L, scheduled.single().first)
    scheduled.single().second.run()
    assertEquals(1, released)
  }

  @Test
  fun aChunkStartingWithinTheGraceKeepsFocus() {
    idle.arm()
    idle.cancel()
    scheduled.single().second.run()
    assertEquals(0, released)
  }

  @Test
  fun onlyTheLastChunkEndCounts() {
    idle.arm()
    idle.cancel()
    idle.arm()
    scheduled[0].second.run()
    assertEquals(0, released)
    scheduled[1].second.run()
    assertEquals(1, released)
  }
}
