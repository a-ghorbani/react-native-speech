#!/bin/bash
set -e

# Build espeak-ng as an XCFramework for iOS
# This creates a prebuilt binary that can be distributed with the module

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ESPEAK_DIR="$PROJECT_ROOT/third-party/espeak-ng"
OUTPUT_DIR="$PROJECT_ROOT/ios"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}Building espeak-ng XCFramework for iOS...${NC}"

# Check for Xcode
if ! command -v xcodebuild &> /dev/null; then
    echo -e "${RED}Error: Xcode not found${NC}"
    echo "Please install Xcode from the App Store"
    exit 1
fi

# Initialize espeak-ng if needed
cd "$ESPEAK_DIR"
if [ ! -f configure ]; then
    echo -e "${YELLOW}Running autogen.sh...${NC}"
    ./autogen.sh
fi

# Build for iOS device (arm64)
echo -e "${YELLOW}Building for iOS device (arm64)...${NC}"
BUILD_DIR_IOS="$ESPEAK_DIR/build-ios-arm64"
mkdir -p "$BUILD_DIR_IOS"
cd "$BUILD_DIR_IOS"

export SDKROOT=$(xcrun --sdk iphoneos --show-sdk-path)
export CFLAGS="-arch arm64 -mios-version-min=13.0 -isysroot $SDKROOT -fembed-bitcode"
export CXXFLAGS="$CFLAGS"

../configure \
    --host=arm-apple-darwin \
    --prefix="$BUILD_DIR_IOS/install" \
    --disable-shared \
    --enable-static \
    --without-async \
    --without-mbrola \
    --without-sonic \
    --without-klatt

make -j$(sysctl -n hw.ncpu) 2>&1 | grep -v "warning:" || true
make install

# Build for iOS simulator x86_64
echo -e "${YELLOW}Building for iOS simulator (x86_64)...${NC}"
BUILD_DIR_SIM_X86="$ESPEAK_DIR/build-ios-simulator-x86_64"
mkdir -p "$BUILD_DIR_SIM_X86"
cd "$BUILD_DIR_SIM_X86"

export SDKROOT=$(xcrun --sdk iphonesimulator --show-sdk-path)
export CFLAGS="-arch x86_64 -mios-simulator-version-min=13.0 -isysroot $SDKROOT"
export CXXFLAGS="$CFLAGS"

../configure \
    --host=x86_64-apple-darwin \
    --prefix="$BUILD_DIR_SIM_X86/install" \
    --disable-shared \
    --enable-static \
    --without-async \
    --without-mbrola \
    --without-sonic \
    --without-klatt

make -j$(sysctl -n hw.ncpu) 2>&1 | grep -v "warning:" || true
make install

# Build for iOS simulator arm64
echo -e "${YELLOW}Building for iOS simulator (arm64)...${NC}"
BUILD_DIR_SIM_ARM="$ESPEAK_DIR/build-ios-simulator-arm64"
mkdir -p "$BUILD_DIR_SIM_ARM"
cd "$BUILD_DIR_SIM_ARM"

export SDKROOT=$(xcrun --sdk iphonesimulator --show-sdk-path)
export CFLAGS="-arch arm64 -mios-simulator-version-min=13.0 -isysroot $SDKROOT"
export CXXFLAGS="$CFLAGS"

../configure \
    --host=arm-apple-darwin \
    --prefix="$BUILD_DIR_SIM_ARM/install" \
    --disable-shared \
    --enable-static \
    --without-async \
    --without-mbrola \
    --without-sonic \
    --without-klatt

make -j$(sysctl -n hw.ncpu) 2>&1 | grep -v "warning:" || true
make install

# Create fat library for simulator
echo -e "${YELLOW}Creating fat library for simulator...${NC}"
BUILD_DIR_SIM="$ESPEAK_DIR/build-ios-simulator"
mkdir -p "$BUILD_DIR_SIM/install/lib"
mkdir -p "$BUILD_DIR_SIM/install/include"

lipo -create \
    "$BUILD_DIR_SIM_X86/install/lib/libespeak-ng.a" \
    "$BUILD_DIR_SIM_ARM/install/lib/libespeak-ng.a" \
    -output "$BUILD_DIR_SIM/install/lib/libespeak-ng.a"

cp -r "$BUILD_DIR_SIM_X86/install/include/"* "$BUILD_DIR_SIM/install/include/"

# Create XCFramework
echo -e "${YELLOW}Creating XCFramework...${NC}"
XCFRAMEWORK_PATH="$OUTPUT_DIR/espeak-ng.xcframework"

if [ -d "$XCFRAMEWORK_PATH" ]; then
    rm -rf "$XCFRAMEWORK_PATH"
fi

xcodebuild -create-xcframework \
    -library "$BUILD_DIR_IOS/install/lib/libespeak-ng.a" \
    -headers "$BUILD_DIR_IOS/install/include" \
    -library "$BUILD_DIR_SIM/install/lib/libespeak-ng.a" \
    -headers "$BUILD_DIR_SIM/install/include" \
    -output "$XCFRAMEWORK_PATH"

echo -e "${GREEN}✓ XCFramework created at: $XCFRAMEWORK_PATH${NC}"

# Copy espeak-ng-data
echo -e "${YELLOW}Preparing espeak-ng-data...${NC}"

if [ ! -d "$ESPEAK_DIR/espeak-ng-data" ]; then
    echo -e "${YELLOW}Building espeak-ng-data...${NC}"
    cd "$BUILD_DIR_IOS"
    make espeak-ng-data
fi

# Copy data
if [ -d "$OUTPUT_DIR/espeak-ng-data" ]; then
    rm -rf "$OUTPUT_DIR/espeak-ng-data"
fi
cp -r "$ESPEAK_DIR/espeak-ng-data" "$OUTPUT_DIR/"

echo -e "${GREEN}✓ Copied espeak-ng-data${NC}"

# Optional: Remove non-English languages
read -p "Remove non-English languages to reduce size? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Removing non-English languages...${NC}"
    cd "$OUTPUT_DIR/espeak-ng-data"
    find lang -maxdepth 1 -type d ! -name 'lang' ! -name 'en' -exec rm -rf {} + 2>/dev/null || true
    find voices -maxdepth 1 -type d ! -name 'voices' ! -name 'en' ! -name '!v' -exec rm -rf {} + 2>/dev/null || true
    echo -e "${GREEN}✓ Removed non-English languages${NC}"
    echo -e "${GREEN}  Data size reduced from ~5MB to ~500KB${NC}"
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ iOS build complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Output:"
echo "  XCFramework: $XCFRAMEWORK_PATH"
echo "  Data:        $OUTPUT_DIR/espeak-ng-data/"
echo ""
echo "The XCFramework is automatically included via Podspec."
echo "Users don't need to add any source files manually!"
echo ""
echo "Next steps:"
echo "  1. cd ios && pod install"
echo "  2. Open Xcode and build"
echo ""
