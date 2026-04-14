#!/bin/bash
set -e

echo "🧪 Running iOS Native Tests (XCTest)..."
echo ""

# Default simulator
SIMULATOR="${IOS_SIMULATOR:-iPhone 17 Pro}"

# Check if xcpretty is installed for better output
if command -v xcpretty &> /dev/null; then
    xcodebuild test \
      -workspace example/ios/SpeechExample.xcworkspace \
      -scheme SpeechExample \
      -destination "platform=iOS Simulator,name=$SIMULATOR" \
      | xcpretty --color
else
    echo "💡 Tip: Install xcpretty for better test output: gem install xcpretty"
    echo ""
    xcodebuild test \
      -workspace example/ios/SpeechExample.xcworkspace \
      -scheme SpeechExample \
      -destination "platform=iOS Simulator,name=$SIMULATOR"
fi

echo ""
echo "✅ iOS tests completed!"
