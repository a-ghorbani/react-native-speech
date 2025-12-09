#!/bin/bash
set -e

# Build espeak-ng static library for iOS
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ESPEAK_SRC="${PROJECT_ROOT}/third-party/espeak-ng/src"
BUILD_DIR="${PROJECT_ROOT}/ios/build-espeak"

echo "Building espeak-ng static library for iOS..."

# Clean and create build directory
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

# Copy config.h
cp "${PROJECT_ROOT}/ios/espeak-config.h" config.h
cp config.h "${ESPEAK_SRC}/libespeak-ng/config.h"

# Find and compile all C files
find "${ESPEAK_SRC}/libespeak-ng" -name "*.c" \
  -not -name "espeak_command.c" \
  -not -name "compiledict.c" \
  -not -name "compilembrola.c" \
  -not -name "compiledata.c" \
  -not -name "sPlayer.c" \
  -not -name "klatt.c" | while read file; do

  echo "Compiling $(basename "$file")..."
  xcrun -sdk iphoneos clang -c "$file" \
    -x c \
    -arch arm64 \
    -mios-version-min=13.0 \
    -DLIBESPEAK_NG_EXPORT= \
    -I"${ESPEAK_SRC}/include" \
    -I"${ESPEAK_SRC}/libespeak-ng" \
    -I"${ESPEAK_SRC}/ucd-tools/src/include" \
    -Wno-everything
done

# Create static library
xcrun -sdk iphoneos ar rcs libespeak-ng.a *.o

echo "✓ Built library with $(ls -1 *.o | wc -l) object files"
ls -lh libespeak-ng.a
