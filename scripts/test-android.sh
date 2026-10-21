#!/bin/bash
# Runs through example/android: the library has no Gradle wrapper.
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "🧪 Running Android Native Tests (JUnit)..."
echo ""

cd "$ROOT/example/android"
./gradlew :pocketpalai_react-native-speech:testDebugUnitTest --console=plain "$@"

echo ""
echo "✅ Android tests completed!"
echo ""
echo "📊 Test report: android/build/reports/tests/testDebugUnitTest/index.html"
