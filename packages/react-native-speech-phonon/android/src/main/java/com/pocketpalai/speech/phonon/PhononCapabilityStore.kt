package com.pocketpalai.speech.phonon

import org.json.JSONObject
import java.io.File

/**
 * Persisted negative capability record (DESIGN.md §2.4): getSupport keeps reporting it without
 * touching native code until Build.FINGERPRINT, the library release or (load-failed only) the
 * recorded model changes, or Speech.resetEngineSupport clears it.
 */
class PhononCapabilityStore(private val file: File) {
  data class Record(
    val device: String,
    val libraryVersion: String,
    /** [modelStamp] of the model that failed; "" for library failures. */
    val modelStamp: String,
    val reason: String,
    val detail: String,
    val at: Long,
    /** Folder of the model that failed (load-failed only); "" for library failures. */
    val modelPath: String = ""
  ) {
    fun matches(device: String, libraryVersion: String): Boolean =
      this.device == device && this.libraryVersion == libraryVersion

    /**
     * Whether the probe, which has no model at hand, still reports this record: load-failed
     * re-stamps its own [modelPath] with [stampOf], so a replaced model re-enables the engine.
     */
    fun applies(device: String, libraryVersion: String, stampOf: (String) -> String): Boolean =
      matches(device, libraryVersion) &&
        (reason != REASON_LOAD_FAILED || modelPath.isEmpty() || stampOf(modelPath) == modelStamp)

    /** A load-failed record no longer applies once the app points at a different model. */
    fun isStaleFor(modelStamp: String): Boolean =
      reason == REASON_LOAD_FAILED && this.modelStamp != modelStamp
  }

  fun read(): Record? =
    try {
      if (file.isFile) decode(file.readText()) else null
    } catch (e: Exception) {
      null
    }

  /** Atomic replace; false on I/O failure, never throws. */
  fun write(record: Record): Boolean =
    try {
      file.parentFile?.mkdirs()
      val tmp = File(file.path + ".tmp")
      tmp.writeText(encode(record))
      tmp.renameTo(file) || run {
        file.delete()
        tmp.renameTo(file)
      }
    } catch (e: Exception) {
      false
    }

  fun clear(): Boolean = !file.exists() || file.delete()

  companion object {
    const val FILE_NAME = "rnspeech-phonon-cap.json"
    const val REASON_LIBRARY_MISSING = "library-missing"
    const val REASON_SYMBOLS_MISSING = "symbols-missing"
    const val REASON_LOAD_FAILED = "load-failed"

    val PERSISTED_REASONS = setOf(REASON_LIBRARY_MISSING, REASON_SYMBOLS_MISSING, REASON_LOAD_FAILED)

    /**
     * ptts_new messages that point at the app's input (bad folder or language) or memory
     * pressure: retryable, so never persisted. Upstream has no error codes, hence the match.
     */
    private val NOT_PERSISTED = Regex(
      listOf(
        "no such file", "not found", "os error", "does not exist", "cannot find",
        "permission denied", "not a directory", "is a directory", "no weights",
        "config\\.json", "tokenizer", "voice", "language", "invalid", "expected",
        "parse", "json", "eof", "gguf", "safetensors", "header", "memory", "alloc",
        "mmap", "unit", "path"
      ).joinToString("|"),
      RegexOption.IGNORE_CASE
    )

    fun isPersistentLoadFailure(message: String?): Boolean {
      val msg = message?.trim().orEmpty()
      return msg.isNotEmpty() && !NOT_PERSISTED.containsMatchIn(msg)
    }

    /** Canonical path plus name, size and mtime of the files ptts reads. */
    fun modelStamp(dir: File): String {
      val path = try {
        dir.canonicalPath
      } catch (e: Exception) {
        dir.absolutePath
      }
      val parts = MODEL_FILES.mapNotNull { name ->
        val f = File(dir, name)
        if (f.isFile) "$name:${f.length()}:${f.lastModified()}" else null
      }
      return (listOf(path) + parts).joinToString("|")
    }

    private val MODEL_FILES =
      listOf("config.json", "tokenizer.json", "model.q8.gguf", "model.safetensors")

    fun encode(r: Record): String =
      JSONObject()
        .put("device", r.device)
        .put("libraryVersion", r.libraryVersion)
        .put("modelStamp", r.modelStamp)
        .put("reason", r.reason)
        .put("detail", r.detail)
        .put("modelPath", r.modelPath)
        .put("at", r.at)
        .toString()

    fun decode(text: String): Record? {
      val o = try {
        JSONObject(text)
      } catch (e: Exception) {
        return null
      }
      fun str(key: String): String? = if (o.has(key) && !o.isNull(key)) o.optString(key) else null
      return Record(
        device = str("device") ?: return null,
        libraryVersion = str("libraryVersion") ?: return null,
        modelStamp = str("modelStamp") ?: "",
        reason = str("reason")?.takeIf { it in PERSISTED_REASONS } ?: return null,
        detail = str("detail") ?: "",
        at = o.optLong("at", 0L),
        modelPath = str("modelPath") ?: ""
      )
    }
  }
}
