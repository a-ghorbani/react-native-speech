package com.mhpdev.speech

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import android.content.Context
import android.content.res.AssetManager

/**
 * Native espeak-ng phonemizer
 * Uses JNI to call espeak-ng C library
 */
object EspeakNative {
    init {
        try {
            System.loadLibrary("espeak-wrapper")
        } catch (e: UnsatisfiedLinkError) {
            android.util.Log.e("EspeakNative", "Failed to load espeak-wrapper library", e)
            throw e
        }
    }

    /**
     * Convert text to IPA phonemes using espeak-ng
     * @param text The input text
     * @param language Language code (e.g., "en-us", "en-gb")
     * @param dataPath Path to espeak-ng-data directory
     * @return IPA phoneme string
     */
    external fun phonemize(text: String, language: String, dataPath: String): String

    /**
     * Ensure espeak-ng-data is extracted to internal storage
     * @param context Application context
     * @return Path to espeak-ng-data directory
     */
    fun ensureDataPath(context: Context): String {
        val dataDir = File(context.filesDir, "espeak-ng-data")

        // Check if already extracted
        if (dataDir.exists() && isDataValid(dataDir)) {
            return dataDir.absolutePath
        }

        // Extract from assets
        dataDir.mkdirs()
        copyAssetFolder(context.assets, "espeak-ng-data", dataDir.absolutePath)

        return dataDir.absolutePath
    }

    /**
     * Check if espeak-ng-data is valid (has required files)
     */
    private fun isDataValid(dataDir: File): Boolean {
        // Check for essential files
        val phondata = File(dataDir, "phondata")
        val phontab = File(dataDir, "phontab")
        val phonindex = File(dataDir, "phonindex")
        val voicesDir = File(dataDir, "voices")

        return phondata.exists() && phontab.exists() && phonindex.exists() && voicesDir.exists()
    }

    /**
     * Recursively copy asset folder to filesystem
     */
    private fun copyAssetFolder(
        assetManager: AssetManager,
        fromAssetPath: String,
        toPath: String
    ) {
        val assets = assetManager.list(fromAssetPath) ?: return

        File(toPath).mkdirs()

        for (asset in assets) {
            val from = if (fromAssetPath.isEmpty()) asset else "$fromAssetPath/$asset"
            val to = "$toPath/$asset"

            try {
                val subAssets = assetManager.list(from)
                if (subAssets != null && subAssets.isNotEmpty()) {
                    // It's a directory
                    copyAssetFolder(assetManager, from, to)
                } else {
                    // It's a file
                    copyAssetFile(assetManager, from, to)
                }
            } catch (e: Exception) {
                // Assume it's a file
                copyAssetFile(assetManager, from, to)
            }
        }
    }

    /**
     * Copy a single asset file
     */
    private fun copyAssetFile(assetManager: AssetManager, fromPath: String, toPath: String) {
        var inputStream: InputStream? = null
        var outputStream: OutputStream? = null

        try {
            inputStream = assetManager.open(fromPath)
            File(toPath).also { file ->
                file.parentFile?.mkdirs()
                outputStream = file.outputStream()
                inputStream.copyTo(outputStream!!, bufferSize = 8192)
            }
        } catch (e: Exception) {
            android.util.Log.e("EspeakNative", "Failed to copy asset: $fromPath", e)
        } finally {
            inputStream?.close()
            outputStream?.close()
        }
    }
}
