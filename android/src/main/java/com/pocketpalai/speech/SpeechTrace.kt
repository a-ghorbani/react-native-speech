package com.pocketpalai.speech

import android.os.Trace

object SpeechTrace {
    const val ENABLED: Boolean = BuildConfig.RN_SPEECH_TRACE

    inline fun beginSection(name: String) {
        if (ENABLED) Trace.beginSection(name)
    }

    inline fun endSection() {
        if (ENABLED) try { Trace.endSection() } catch (_: Exception) {}
    }
}
