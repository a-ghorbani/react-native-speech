#!/bin/bash
# Run the library's Android JVM unit tests (JUnit).
#
# The library has no Gradle wrapper of its own, so this runs through the example app's:
#   cd example/android && ./gradlew :pocketpalai_react-native-speech:testDebugUnitTest
#
# Flag off (default) runs the not-compiled stub tests plus the pure Phonon policy tests.
# PHONON=1 builds the library with Phonon enabled; it needs local binaries
# (scripts/phonon/README.md), taken from RNSpeech_phononLibDir or, by default,
# scripts/out/phonon/android/jniLibs.
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARGS=(:pocketpalai_react-native-speech:testDebugUnitTest --console=plain)

if [[ "${PHONON:-0}" == "1" ]]; then
  LIBDIR="${RNSpeech_phononLibDir:-$ROOT/scripts/out/phonon/android/jniLibs}"
  ARGS+=(-PRNSpeech_phononEnabled=true "-PRNSpeech_phononLibDir=$LIBDIR")
else
  ARGS+=(-PRNSpeech_phononEnabled=false)
fi

echo "🧪 Running Android Native Tests (JUnit)..."
echo ""

cd "$ROOT/example/android"
./gradlew "${ARGS[@]}"

echo ""
echo "✅ Android tests completed!"
echo ""
echo "📊 Test report: android/build/reports/tests/testDebugUnitTest/index.html"
