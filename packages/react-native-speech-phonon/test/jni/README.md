# Phonon JNI shim on the host

`scripts/test-jni-host.sh` builds `android/src/main/cpp/phonon_jni.cpp` (plus
`cpp/`) as a host shared library against the JDK's JNI headers, with stand-ins for the
two bionic APIs it uses (`include/`, `fake_android.cpp`), and runs the JVM test
`android/src/phononTest/java/.../PhononNativeHostTest.kt` against it through the example's
Gradle wrapper (library built with Phonon enabled).

That covers the JNI marshalling (UTF-16 ⇄ UTF-8, result arrays, buffers), the dlopen /
symbols-missing paths and, with a host `libptts_ffi.so` and a checkpoint folder, real
create / speak / cancel / take / destroy, without a phone. Bionic-only behaviour (HWCAP values
of real phones, `System.loadLibrary` from the APK, linker namespaces) still needs a device.

```bash
# Host libptts_ffi.so (aarch64 Linux: explicit target flags, never target-cpu=native):
#   see test/core/README.md "Optional: real libptts_ffi on an aarch64 Linux host"
PHONON_HOST_LIB=/path/to/target/release/libptts_ffi.so \
PHONON_MODEL_DIR=/path/to/phonon-31m-en \
  scripts/test-jni-host.sh
```

Without `PHONON_HOST_LIB` / `PHONON_MODEL_DIR` the tests that need them are skipped (JUnit
assumptions). The flag-on library build needs local Android binaries
(`RNSpeech_phononLibDir`, default `scripts/out/android/jniLibs`); see
`scripts/README.md`.
