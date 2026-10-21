package com.pocketpalai.speech.phonon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class PhononThreadsTest {
  @get:Rule val tmp = TemporaryFolder()

  // cpuinfo_max_freq (kHz) per CPU of the device matrix.
  private val pixel9 = listOf(1950000L, 1950000, 1950000, 1950000, 2600000, 2600000, 2600000, 3105000) // Tensor G4 4+3+1
  private val s23 = listOf(2016000L, 2016000, 2016000, 2803200, 2803200, 2803200, 2803200, 3360000) // SM8550 3+2+2+1
  private val sm8850 = listOf(3628800L, 3628800, 3628800, 3628800, 3628800, 3628800, 4608000, 4608000) // 6+2
  private val mt6899 = listOf(2100000L, 2100000, 2100000, 2100000, 3000000, 3000000, 3000000, 3250000) // 4+3+1
  private val sd845 = listOf(1766400L, 1766400, 1766400, 1766400, 2803200, 2803200, 2803200, 2803200) // 4+4

  @Test
  fun deviceDefaults() {
    assertEquals(4, PhononThreads.resolve(0, pixel9, 8)) // 3 + prime
    assertEquals(4, PhononThreads.resolve(0, s23, 8)) // 5 big, clamped to 4
    assertEquals(4, PhononThreads.resolve(0, sm8850, 8)) // all 8 within 70 %, clamped
    assertEquals(4, PhononThreads.resolve(0, mt6899, 8))
    assertEquals(4, PhononThreads.resolve(0, sd845, 8))
  }

  @Test
  fun defaultClampsToAtLeastTwoBigCores() {
    // One prime core far above the rest still gets two workers.
    assertEquals(2, PhononThreads.resolve(0, listOf(1000000L, 1000000, 1000000, 3000000), 4))
  }

  @Test
  fun defaultNeverExceedsCores() {
    assertEquals(1, PhononThreads.resolve(0, listOf(2000000L), 1))
  }

  @Test
  fun unreadableSysfsFallsBackToHalfTheCores() {
    assertEquals(4, PhononThreads.resolve(0, null, 8))
    assertEquals(3, PhononThreads.resolve(0, null, 6))
    assertEquals(4, PhononThreads.resolve(0, emptyList(), 12))
    assertEquals(1, PhononThreads.resolve(0, null, 1))
    assertEquals(1, PhononThreads.resolve(0, listOf(0L, 0L), 2)) // zeros = unreadable
  }

  @Test
  fun explicitRequestIsClampedToCores() {
    assertEquals(6, PhononThreads.resolve(6, pixel9, 8))
    assertEquals(8, PhononThreads.resolve(16, pixel9, 8))
    assertEquals(1, PhononThreads.resolve(1, null, 8))
    assertEquals(1, PhononThreads.resolve(3, null, 0)) // 0 cores reported → treated as 1
  }

  @Test
  fun readsCpufreqLayout() {
    val root = tmp.newFolder("cpu")
    for ((i, f) in pixel9.withIndex()) writeFreq(root, i, f.toString())
    File(root, "cpufreq").mkdirs() // policy dir, not a cpu<N>
    File(root, "cpuidle").mkdirs()
    assertEquals(pixel9, PhononThreads.readCpuMaxFreqs(root))
  }

  @Test
  fun readsInNumericOrderAndSkipsUnreadable() {
    val root = tmp.newFolder("cpu")
    writeFreq(root, 10, "3000000")
    writeFreq(root, 2, "2000000\n")
    writeFreq(root, 1, "garbage")
    File(root, "cpu3").mkdirs() // offline core without cpufreq
    assertEquals(listOf(2000000L, 3000000L), PhononThreads.readCpuMaxFreqs(root))
  }

  @Test
  fun unreadableRootIsNull() {
    assertNull(PhononThreads.readCpuMaxFreqs(File(tmp.root, "missing")))
    val empty = tmp.newFolder("empty")
    assertNull(PhononThreads.readCpuMaxFreqs(empty))
  }

  private fun writeFreq(root: File, cpu: Int, value: String) {
    val dir = File(root, "cpu$cpu/cpufreq")
    dir.mkdirs()
    File(dir, "cpuinfo_max_freq").writeText(value)
  }
}
