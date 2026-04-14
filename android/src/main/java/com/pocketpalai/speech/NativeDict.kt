package com.pocketpalai.speech

/**
 * NativeDict — Kotlin wrapper around the mmap'd EPD1 phonemizer dict
 * (cpp/native_dict.cpp). Singleton: one open dict at a time.
 */
object NativeDict {
    init {
        try {
            System.loadLibrary("native_dict")
        } catch (e: UnsatisfiedLinkError) {
            android.util.Log.e("NativeDict", "Failed to load native_dict library", e)
            throw e
        }
    }

    /**
     * Open a dict file. Replaces any currently-open dict.
     * Returns true on success.
     */
    fun open(path: String): Boolean = nativeOpen(path)

    /** Close any currently-open dict. */
    fun close() = nativeClose()

    /** Look up a word. Returns null on miss or if no dict open. */
    fun lookup(word: String): String? = nativeLookup(word)

    @JvmStatic external fun nativeOpen(path: String): Boolean
    @JvmStatic external fun nativeClose()
    @JvmStatic external fun nativeLookup(word: String): String?
}
