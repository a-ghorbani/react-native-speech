#!/usr/bin/env bash
# Build the Android Phonon JNI shim for the host and run PhononNativeHostTest against it
# (test/jni/README.md). Linux or macOS, with a JDK, CMake and jq.
#
# Env:
#   PHONON_HOST_LIB     optional host libptts_ffi.so (enables the create/speak tests), with
#   PHONON_MODEL_DIR    a checkpoint folder (e.g. phonon-31m-en)
#   RNSpeech_phononLibDir  Android jniLibs for the add-on's library build
#                       (default scripts/out/android/jniLibs)
#   JAVA_HOME           JDK for the JNI headers (default: from `javac` on PATH)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/test/jni/build"
FEATURES="$(jq -er '.arm64Features' "$ROOT/phonon.lock.json")"

if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
fi
[[ -f "$JAVA_HOME/include/jni.h" ]] || { echo "no jni.h under JAVA_HOME=$JAVA_HOME" >&2; exit 1; }

mkdir -p "$BUILD/include"
bash "$ROOT/scripts/gen-hwcaps-header.sh" "$FEATURES" "$BUILD/include/phonon_required_hwcaps.h"
cmake -S "$ROOT/test/jni" -B "$BUILD" -DCMAKE_BUILD_TYPE=Debug \
  "-DJNI_INCLUDE=$JAVA_HOME/include" "-DPHONON_HWCAPS_DIR=$BUILD/include" \
  "-DPHONON_ARM64_FEATURES=$FEATURES" >/dev/null
cmake --build "$BUILD" -j >/dev/null
SHIM=""
for f in "$BUILD"/librnspeech_phonon.so "$BUILD"/librnspeech_phonon.dylib; do
  [[ -f "$f" ]] && SHIM="$f"
done
[[ -n "$SHIM" ]] || { echo "host shim not built" >&2; exit 1; }
echo "host shim: $SHIM"

LIBDIR="${RNSpeech_phononLibDir:-$ROOT/scripts/out/android/jniLibs}"
ARGS=(:pocketpalai_react-native-speech-phonon:testDebugUnitTest --console=plain
  --tests 'com.pocketpalai.speech.phonon.PhononNativeHostTest'
  "-PRNSpeech_phononLibDir=$LIBDIR"
  "-PRNSpeech_phononHostShim=$SHIM")
[[ -n "${PHONON_HOST_LIB:-}" ]] && ARGS+=("-PRNSpeech_phononHostLib=$PHONON_HOST_LIB")
[[ -n "${PHONON_MODEL_DIR:-}" ]] && ARGS+=("-PRNSpeech_phononModelDir=$PHONON_MODEL_DIR")

# The example autolinks the add-on only with RN_SPEECH_PHONON=1 (example/react-native.config.js).
cd "$ROOT/../../example/android"
RN_SPEECH_PHONON=1 ./gradlew "${ARGS[@]}"
echo "report: $ROOT/android/build/reports/tests/testDebugUnitTest/index.html"
