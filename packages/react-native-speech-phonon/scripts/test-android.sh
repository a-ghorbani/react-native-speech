#!/bin/bash
# Kotlin JVM tests of the add-on, run through example/android with the add-on autolinked
# (RN_SPEECH_PHONON=1, example/react-native.config.js). Needs no Phonon binaries.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT/../../example/android"
RN_SPEECH_PHONON=1 ./gradlew :pocketpalai_react-native-speech-phonon:testDebugUnitTest --console=plain "$@"
echo "report: $ROOT/android/build/reports/tests/testDebugUnitTest/index.html"
