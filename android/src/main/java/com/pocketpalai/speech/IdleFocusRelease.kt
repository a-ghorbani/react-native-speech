package com.pocketpalai.speech

/**
 * Releases the focus an utterance holds between its chunks after [graceMs] with no chunk playing,
 * so an utterance that never ends (a stream never finalized) cannot keep other apps ducked. The
 * next chunk requests focus again. [schedule] runs the task later on any thread; [release] runs
 * under [lock].
 */
internal class IdleFocusRelease(
  private val lock: Any,
  private val graceMs: Long,
  private val schedule: (Long, Runnable) -> Unit,
  private val release: () -> Unit,
) {
  private var generation = 0

  /** A held chunk ended: release after the grace unless [cancel] or [arm] comes first. */
  fun arm() {
    synchronized(lock) {
      val gen = ++generation
      schedule(graceMs, Runnable {
        synchronized(lock) {
          if (gen == generation) release()
        }
      })
    }
  }

  /** A chunk starts, or playback stops. */
  fun cancel() {
    synchronized(lock) { generation++ }
  }
}
