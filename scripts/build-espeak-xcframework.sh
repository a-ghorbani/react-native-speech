#!/bin/bash
set -e

# Build espeak-ng XCFramework for iOS (device + simulator)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ESPEAK_SRC="${PROJECT_ROOT}/third-party/espeak-ng/src"
BUILD_DIR="${PROJECT_ROOT}/ios/build-espeak"

echo "Building espeak-ng XCFramework for iOS..."

# Clean and create build directory
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

# Copy config.h
cp "${PROJECT_ROOT}/ios/espeak-config.h" config.h
cp config.h "${ESPEAK_SRC}/libespeak-ng/config.h"

# Build for iOS device (arm64)
echo "Building for iOS device (arm64)..."
mkdir -p device
cd device

# Compile espeak-ng library files
find "${ESPEAK_SRC}/libespeak-ng" -name "*.c" \
  -not -name "espeak_command.c" \
  -not -name "compilembrola.c" \
  -not -name "compiledata.c" \
  -not -name "sPlayer.c" \
  -not -name "klatt.c" | while read file; do
  xcrun -sdk iphoneos clang -c "$file" \
    -x c \
    -arch arm64 \
    -mios-version-min=13.0 \
    -DLIBESPEAK_NG_EXPORT= \
    -DN_PHONEME_LIST=4000 \
    -I"${ESPEAK_SRC}/include" \
    -I"${ESPEAK_SRC}/libespeak-ng" \
    -I"${ESPEAK_SRC}/ucd-tools/src/include" \
    -Wno-everything
done

# Compile ucd-tools files
find "${ESPEAK_SRC}/ucd-tools/src" -name "*.c" | while read file; do
  xcrun -sdk iphoneos clang -c "$file" \
    -x c \
    -arch arm64 \
    -mios-version-min=13.0 \
    -I"${ESPEAK_SRC}/ucd-tools/src/include" \
    -Wno-everything
done

xcrun -sdk iphoneos ar rcs libespeak-ng.a *.o
echo "✓ Device library: $(ls -lh libespeak-ng.a | awk '{print $5}')"
cd ..

# Build for iOS simulator (arm64 + x86_64)
echo "Building for iOS Simulator (arm64 + x86_64)..."
mkdir -p simulator
cd simulator

# Compile espeak-ng library files
find "${ESPEAK_SRC}/libespeak-ng" -name "*.c" \
  -not -name "espeak_command.c" \
  -not -name "compilembrola.c" \
  -not -name "compiledata.c" \
  -not -name "sPlayer.c" \
  -not -name "klatt.c" | while read file; do
  xcrun -sdk iphonesimulator clang -c "$file" \
    -x c \
    -arch arm64 -arch x86_64 \
    -mios-simulator-version-min=13.0 \
    -DLIBESPEAK_NG_EXPORT= \
    -DN_PHONEME_LIST=4000 \
    -I"${ESPEAK_SRC}/include" \
    -I"${ESPEAK_SRC}/libespeak-ng" \
    -I"${ESPEAK_SRC}/ucd-tools/src/include" \
    -Wno-everything
done

# Compile ucd-tools files
find "${ESPEAK_SRC}/ucd-tools/src" -name "*.c" | while read file; do
  xcrun -sdk iphonesimulator clang -c "$file" \
    -x c \
    -arch arm64 -arch x86_64 \
    -mios-simulator-version-min=13.0 \
    -I"${ESPEAK_SRC}/ucd-tools/src/include" \
    -Wno-everything
done

xcrun -sdk iphonesimulator ar rcs libespeak-ng.a *.o
echo "✓ Simulator library: $(ls -lh libespeak-ng.a | awk '{print $5}')"
cd ..

# Create XCFramework
echo "Creating XCFramework..."
xcodebuild -create-xcframework \
  -library device/libespeak-ng.a \
  -library simulator/libespeak-ng.a \
  -output libespeak-ng.xcframework

echo ""
echo "✓ XCFramework built successfully!"
ls -lh libespeak-ng.xcframework/
