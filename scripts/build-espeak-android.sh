#!/bin/bash
set -e

# Build espeak-ng for Android
# This script builds espeak-ng native libraries for all Android ABIs

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ESPEAK_DIR="$PROJECT_ROOT/third-party/espeak-ng"
OUTPUT_DIR="$PROJECT_ROOT/android/libs/espeak-ng"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building espeak-ng for Android...${NC}"

# Check for Android NDK
if [ -z "$ANDROID_NDK_HOME" ]; then
    if [ -n "$ANDROID_HOME" ]; then
        ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$(ls $ANDROID_HOME/ndk | sort -V | tail -n1)"
    fi
fi

if [ -z "$ANDROID_NDK_HOME" ] || [ ! -d "$ANDROID_NDK_HOME" ]; then
    echo -e "${RED}Error: ANDROID_NDK_HOME not set or NDK not found${NC}"
    echo "Please set ANDROID_NDK_HOME environment variable"
    echo "Example: export ANDROID_NDK_HOME=\$ANDROID_HOME/ndk/26.1.10909125"
    exit 1
fi

echo -e "${GREEN}Using NDK: $ANDROID_NDK_HOME${NC}"

# Initialize espeak-ng if needed
cd "$ESPEAK_DIR"
if [ ! -f configure ]; then
    echo -e "${YELLOW}Running autogen.sh...${NC}"
    ./autogen.sh
fi

# Android settings
MIN_SDK_VERSION=21
ABIS=("arm64-v8a" "armeabi-v7a" "x86" "x86_64")

# Architecture mapping
declare -A ARCH_MAP=(
    ["arm64-v8a"]="aarch64-linux-android"
    ["armeabi-v7a"]="armv7a-linux-androideabi"
    ["x86"]="i686-linux-android"
    ["x86_64"]="x86_64-linux-android"
)

# Build for each ABI
for ABI in "${ABIS[@]}"; do
    echo -e "${GREEN}Building for $ABI...${NC}"

    HOST="${ARCH_MAP[$ABI]}"
    BUILD_DIR="$ESPEAK_DIR/build-android-$ABI"
    INSTALL_DIR="$BUILD_DIR/install"

    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"

    # Configure
    ../configure \
        --host="$HOST" \
        --prefix="$INSTALL_DIR" \
        --disable-shared \
        --enable-static \
        --without-async \
        --without-mbrola \
        --without-sonic \
        --without-klatt \
        CFLAGS="-fPIC" \
        CXXFLAGS="-fPIC"

    # Build
    make -j$(nproc) 2>&1 | grep -v "warning:"
    make install

    # Create output directories
    mkdir -p "$OUTPUT_DIR/lib/$ABI"
    mkdir -p "$OUTPUT_DIR/include"

    # Copy libraries (convert static to shared for easier integration)
    echo -e "${YELLOW}Copying libraries for $ABI...${NC}"

    # We'll use the static library and let CMake handle it
    if [ -f "$INSTALL_DIR/lib/libespeak-ng.a" ]; then
        cp "$INSTALL_DIR/lib/libespeak-ng.a" "$OUTPUT_DIR/lib/$ABI/"
        echo -e "${GREEN}✓ Copied libespeak-ng.a for $ABI${NC}"
    else
        echo -e "${RED}✗ libespeak-ng.a not found for $ABI${NC}"
    fi

    # Copy headers (only once)
    if [ ! -d "$OUTPUT_DIR/include/espeak-ng" ]; then
        cp -r "$INSTALL_DIR/include/espeak-ng" "$OUTPUT_DIR/include/"
        echo -e "${GREEN}✓ Copied headers${NC}"
    fi
done

# Copy espeak-ng-data
echo -e "${YELLOW}Copying espeak-ng-data...${NC}"
ASSETS_DIR="$PROJECT_ROOT/android/src/main/assets"
mkdir -p "$ASSETS_DIR"

if [ -d "$ESPEAK_DIR/espeak-ng-data" ]; then
    cp -r "$ESPEAK_DIR/espeak-ng-data" "$ASSETS_DIR/"
    echo -e "${GREEN}✓ Copied espeak-ng-data to assets${NC}"
else
    echo -e "${YELLOW}Building espeak-ng-data...${NC}"
    cd "$ESPEAK_DIR/build-android-arm64-v8a"
    make espeak-ng-data
    cp -r espeak-ng-data "$ASSETS_DIR/"
    echo -e "${GREEN}✓ Built and copied espeak-ng-data${NC}"
fi

# Optional: Remove non-English languages to reduce size
read -p "Remove non-English languages to reduce size? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Removing non-English languages...${NC}"
    cd "$ASSETS_DIR/espeak-ng-data"
    find lang -maxdepth 1 -type d ! -name 'lang' ! -name 'en' -exec rm -rf {} + 2>/dev/null || true
    find voices -maxdepth 1 -type d ! -name 'voices' ! -name 'en' ! -name '!v' -exec rm -rf {} + 2>/dev/null || true
    echo -e "${GREEN}✓ Removed non-English languages${NC}"
    echo -e "${GREEN}  Data size reduced from ~5MB to ~500KB${NC}"
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Build complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Output:"
echo "  Libraries: $OUTPUT_DIR/lib/"
echo "  Headers:   $OUTPUT_DIR/include/"
echo "  Data:      $ASSETS_DIR/espeak-ng-data/"
echo ""
echo "Next steps:"
echo "  1. Update CMakeLists.txt to use static libraries"
echo "  2. Build your Android app: cd android && ./gradlew assembleDebug"
echo ""
