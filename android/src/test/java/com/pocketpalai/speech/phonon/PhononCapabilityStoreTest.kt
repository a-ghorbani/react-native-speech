package com.pocketpalai.speech.phonon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class PhononCapabilityStoreTest {
  @get:Rule val tmp = TemporaryFolder()

  private val fingerprint = "google/tokay/tokay:15/AP4A.250105.002/12701944:user/release-keys"

  private fun record(
    reason: String = PhononCapabilityStore.REASON_SYMBOLS_MISSING,
    detail: String = "missing symbols: ptts_set_language",
    modelStamp: String = ""
  ) = PhononCapabilityStore.Record(fingerprint, "0.4.0-r1", modelStamp, reason, detail, 1760000000000L)

  @Test
  fun roundTrip() {
    val store = PhononCapabilityStore(File(tmp.root, PhononCapabilityStore.FILE_NAME))
    assertNull(store.read())
    val r = record(detail = "dlopen failed: \"libptts_ffi.so\" not found\n\ttab \\ é \u0001")
    assertTrue(store.write(r))
    assertEquals(r, store.read())
    // Replace, not append.
    val r2 = record(reason = PhononCapabilityStore.REASON_LIBRARY_MISSING, detail = "x")
    assertTrue(store.write(r2))
    assertEquals(r2, store.read())
    assertFalse(File(tmp.root, PhononCapabilityStore.FILE_NAME + ".tmp").exists())
  }

  @Test
  fun writesIntoMissingDirectory() {
    val store = PhononCapabilityStore(File(tmp.root, "no_backup/sub/" + PhononCapabilityStore.FILE_NAME))
    assertTrue(store.write(record()))
    assertEquals(record(), store.read())
  }

  @Test
  fun clear() {
    val file = File(tmp.root, PhononCapabilityStore.FILE_NAME)
    val store = PhononCapabilityStore(file)
    assertTrue(store.clear()) // nothing to clear
    store.write(record())
    assertTrue(store.clear())
    assertFalse(file.exists())
    assertNull(store.read())
  }

  @Test
  fun corruptOrForeignContentReadsAsNoRecord() {
    val file = File(tmp.root, PhononCapabilityStore.FILE_NAME)
    val store = PhononCapabilityStore(file)
    for (text in listOf("", "not json", "{\"device\":\"x\"}", "{\"device\":\"x\",\"libraryVersion\":\"y\",\"reason\":\"ok\"}")) {
      file.writeText(text)
      assertNull("'$text'", store.read())
    }
    // A directory where the file should be.
    file.delete()
    file.mkdirs()
    assertNull(store.read())
  }

  @Test
  fun keyMatching() {
    val r = record()
    assertTrue(r.matches(fingerprint, "0.4.0-r1"))
    // OS update → new fingerprint → probe re-enabled.
    assertFalse(r.matches(fingerprint.replace("AP4A", "BP1A"), "0.4.0-r1"))
    // New library release (or a local build) → re-enabled.
    assertFalse(r.matches(fingerprint, "0.4.0-r2"))
    assertFalse(r.matches(fingerprint, "0.4.0-r1+local"))
  }

  @Test
  fun loadFailedRecordIsPerModel() {
    val r = record(reason = PhononCapabilityStore.REASON_LOAD_FAILED, modelStamp = "/m|a")
    assertFalse(r.isStaleFor("/m|a"))
    assertTrue(r.isStaleFor("/m|b"))
    // Library failures do not depend on the model.
    assertFalse(record().isStaleFor("/anything"))
  }

  @Test
  fun modelStampChangesWithTheModel() {
    val dir = tmp.newFolder("phonon-31m-en")
    val empty = PhononCapabilityStore.modelStamp(dir)
    File(dir, "config.json").writeText("{}")
    val gguf = File(dir, "model.q8.gguf")
    gguf.writeText("weights")
    gguf.setLastModified(1_000_000L)
    val a = PhononCapabilityStore.modelStamp(dir)
    assertNotEquals(empty, a)
    assertEquals(a, PhononCapabilityStore.modelStamp(dir))
    gguf.writeText("other weights")
    gguf.setLastModified(2_000_000L)
    assertNotEquals(a, PhononCapabilityStore.modelStamp(dir))
    // Unrelated files do not matter.
    val b = PhononCapabilityStore.modelStamp(dir)
    File(dir, "voices.jsonl").writeText("{}")
    assertEquals(b, PhononCapabilityStore.modelStamp(dir))
    // Another folder is another model.
    assertNotEquals(b, PhononCapabilityStore.modelStamp(tmp.newFolder("other")))
  }

  @Test
  fun onlyUnexplainedLoadFailuresArePersisted() {
    // Input / config problems and memory pressure: retryable, never hide the engine.
    for (msg in listOf(
      "no such file or directory (os error 2)",
      "/data/x/config.json: No such file or directory",
      "no weights in /data/x; expected one of model.q8.gguf, model.safetensors",
      "unknown language 'klingon'",
      "compute unit 2 is Apple only; use PTTS_UNIT_CPU",
      "failed to parse tokenizer.json",
      "gguf: unexpected end of file",
      "memory allocation of 67108864 bytes failed",
      "",
      "   "
    )) {
      assertFalse(msg, PhononCapabilityStore.isPersistentLoadFailure(msg))
    }
    assertFalse(PhononCapabilityStore.isPersistentLoadFailure(null))
    // Anything else is a device-level failure worth remembering.
    assertTrue(PhononCapabilityStore.isPersistentLoadFailure("rayon thread pool build failed: Resource busy"))
    assertTrue(PhononCapabilityStore.isPersistentLoadFailure("backend initialization failed"))
  }
}
