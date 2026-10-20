package com.pocketpalai.speech.phonon

import java.io.File

/**
 * Persisted negative capability record (DESIGN.md §2.4). After a library-missing,
 * symbols-missing or (non-config) load-failed outcome, getSupport reports that reason without
 * touching native code again, until a key component changes: the device/OS build
 * (Build.FINGERPRINT), the library release, or (for load-failed) the model.
 *
 * One small flat JSON object in noBackupFilesDir. Hand-rolled encoding keeps it free of
 * org.json, which is a stub on the JVM unit-test classpath.
 */
class PhononCapabilityStore(private val file: File) {
  data class Record(
    val device: String,
    val libraryVersion: String,
    /** [modelStamp] of the model that failed; "" for library failures. */
    val modelStamp: String,
    val reason: String,
    val detail: String,
    val at: Long
  ) {
    /** The probe has no model at hand, so device + library decide; see [isStaleFor]. */
    fun matches(device: String, libraryVersion: String): Boolean =
      this.device == device && this.libraryVersion == libraryVersion

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

  /** Atomic replace (write + rename). Returns false on I/O failure; never throws. */
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

    /** Outcomes that are recorded; everything else is not persisted. */
    val PERSISTED_REASONS = setOf(REASON_LIBRARY_MISSING, REASON_SYMBOLS_MISSING, REASON_LOAD_FAILED)

    /**
     * ptts_new failures caused by the app's input (a missing / half-downloaded / wrong
     * checkpoint folder, a bad language) or by transient memory pressure must not hide the
     * engine: the next attempt with a fixed folder can work. Only failures that match none of
     * these are recorded. On the CPU engine nearly every real failure is one of these, so this
     * is deliberately conservative.
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

    /**
     * Identifies a model folder: canonical path plus name, size and mtime of the files ptts
     * reads. A re-download or another variant changes it.
     */
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
      "{" +
        listOf(
          "device" to quote(r.device),
          "libraryVersion" to quote(r.libraryVersion),
          "modelStamp" to quote(r.modelStamp),
          "reason" to quote(r.reason),
          "detail" to quote(r.detail),
          "at" to r.at.toString()
        ).joinToString(",") { (k, v) -> "\"$k\":$v" } +
        "}"

    /** null for anything that is not a complete record. */
    fun decode(text: String): Record? {
      val fields = HashMap<String, String>()
      for (m in FIELD.findAll(text)) {
        val raw = m.groupValues[2]
        fields[m.groupValues[1]] = if (raw.startsWith("\"")) unquote(raw) else raw
      }
      return Record(
        device = fields["device"] ?: return null,
        libraryVersion = fields["libraryVersion"] ?: return null,
        modelStamp = fields["modelStamp"] ?: "",
        reason = fields["reason"]?.takeIf { it in PERSISTED_REASONS } ?: return null,
        detail = fields["detail"] ?: "",
        at = fields["at"]?.toLongOrNull() ?: 0L
      )
    }

    private val FIELD = Regex("\"(\\w+)\"\\s*:\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|-?\\d+)")

    private fun quote(s: String): String {
      val sb = StringBuilder(s.length + 2).append('"')
      for (c in s) {
        when {
          c == '"' -> sb.append("\\\"")
          c == '\\' -> sb.append("\\\\")
          c == '\n' -> sb.append("\\n")
          c == '\r' -> sb.append("\\r")
          c == '\t' -> sb.append("\\t")
          c < ' ' -> sb.append(String.format("\\u%04x", c.code))
          else -> sb.append(c)
        }
      }
      return sb.append('"').toString()
    }

    private fun unquote(q: String): String {
      val s = q.substring(1, q.length - 1)
      val sb = StringBuilder(s.length)
      var i = 0
      while (i < s.length) {
        val c = s[i]
        if (c != '\\' || i + 1 >= s.length) {
          sb.append(c)
          i++
          continue
        }
        when (val e = s[i + 1]) {
          'n' -> sb.append('\n')
          'r' -> sb.append('\r')
          't' -> sb.append('\t')
          'b' -> sb.append('\b')
          'f' -> sb.append('\u000c')
          'u' -> {
            val hex = s.substring(i + 2, minOf(i + 6, s.length))
            sb.append(hex.toIntOrNull(16)?.toChar() ?: '�')
            i += 4
          }
          else -> sb.append(e)
        }
        i += 2
      }
      return sb.toString()
    }
  }
}
