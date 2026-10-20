package com.pocketpalai.speech.phonon

import java.io.File

/**
 * Worker-thread policy for Phonon on Android (DESIGN.md §1.5). The result becomes
 * RAYON_NUM_THREADS, which sizes both the rayon pool and xn's own spinning pool, once per
 * process (both pools are fixed after the first init). Pure, so the cpufreq layouts of the
 * device matrix are unit tested on the JVM.
 */
object PhononThreads {
  /** A CPU counts as "big" when its max frequency is at least this share of the highest. */
  const val BIG_CORE_RATIO = 0.70
  const val MIN_DEFAULT = 2
  const val MAX_DEFAULT = 4

  /**
   * @param requested PhononConfig.numThreads; > 0 is honored (clamped to [1, cores]).
   * @param cpuMaxFreqs cpuinfo_max_freq per CPU, or null when sysfs is unreadable.
   * @param availableProcessors Runtime.availableProcessors().
   */
  fun resolve(requested: Int, cpuMaxFreqs: List<Long>?, availableProcessors: Int): Int {
    val cores = availableProcessors.coerceAtLeast(1)
    if (requested > 0) return requested.coerceIn(1, cores)
    val freqs = cpuMaxFreqs?.filter { it > 0 }
    if (freqs.isNullOrEmpty()) return minOf(MAX_DEFAULT, cores / 2).coerceAtLeast(1)
    val top = freqs.maxOrNull() ?: return minOf(MAX_DEFAULT, cores / 2).coerceAtLeast(1)
    val big = freqs.count { it >= top * BIG_CORE_RATIO }
    return big.coerceIn(MIN_DEFAULT, MAX_DEFAULT).coerceAtMost(cores)
  }

  /**
   * Reads <cpuRoot>/cpu<N>/cpufreq/cpuinfo_max_freq for every cpu<N> directory. Returns null
   * when nothing is readable (SELinux, emulators), so [resolve] falls back to core count.
   */
  fun readCpuMaxFreqs(cpuRoot: File = File("/sys/devices/system/cpu")): List<Long>? {
    val dirs = try {
      cpuRoot.listFiles { f -> f.isDirectory && CPU_DIR.matches(f.name) }
    } catch (e: SecurityException) {
      null
    } ?: return null
    val freqs = dirs
      .sortedBy { it.name.removePrefix("cpu").toInt() }
      .mapNotNull { dir ->
        try {
          File(dir, "cpufreq/cpuinfo_max_freq").readText().trim().toLongOrNull()
        } catch (e: Exception) {
          null
        }
      }
    return freqs.ifEmpty { null }
  }

  private val CPU_DIR = Regex("cpu[0-9]+")
}
