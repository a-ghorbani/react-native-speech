package com.pocketpalai.speech

internal object VoiceInstallerTarget {
  /**
   * The engine whose voice installer to open: the one set with setEngine(), else the
   * default engine. Null means start the installer intent with no package, as before.
   */
  fun enginePackage(selected: String?, default: String?, hasInstaller: (String) -> Boolean): String? =
    listOf(selected, default)
      .firstOrNull { !it.isNullOrEmpty() }
      ?.takeIf(hasInstaller)
}
