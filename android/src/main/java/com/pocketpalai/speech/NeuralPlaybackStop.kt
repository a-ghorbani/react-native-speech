package com.pocketpalai.speech

/**
 * Stops neural playback: the track first, then its ducking focus (before a replacement's activate
 * overwrites the request), then the interruption focus.
 */
internal fun stopNeuralPlaybackInOrder(
  releaseDucking: Boolean,
  abandonFocus: Boolean,
  cleanupAudio: () -> Unit,
  deactivateDucking: () -> Unit,
  abandonInterruptionFocus: () -> Unit,
) {
  cleanupAudio()
  if (releaseDucking) deactivateDucking()
  if (abandonFocus) abandonInterruptionFocus()
}
