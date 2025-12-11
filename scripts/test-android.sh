#!/bin/bash
set -e

echo "🧪 Running Android Native Tests (JUnit)..."
echo ""

cd android

# Run tests
./gradlew test --console=plain

echo ""
echo "✅ Android tests completed!"
echo ""
echo "📊 Test report: android/build/reports/tests/test/index.html"
