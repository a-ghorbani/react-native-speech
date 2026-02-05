#!/bin/bash
set -e

# Manual espeak-ng-data preparation script
# NOTE: This script is for development/debugging only.
# - Android: Data is automatically copied from submodule at build time (see android/build.gradle)
# - iOS: Data is bundled via podspec resources from third-party/espeak-ng/espeak-ng-data/

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}espeak-ng-data preparation script${NC}"
echo ""

# Check if submodule is initialized
if [ ! -d "$PROJECT_ROOT/third-party/espeak-ng/espeak-ng-data" ]; then
    echo -e "${YELLOW}espeak-ng submodule not found. Initializing...${NC}"
    cd "$PROJECT_ROOT"
    git submodule update --init --recursive
fi

# Verify data exists
if [ -d "$PROJECT_ROOT/third-party/espeak-ng/espeak-ng-data" ]; then
    echo -e "${GREEN}✓ espeak-ng-data found in submodule${NC}"
    echo ""
    echo "Platform behavior:"
    echo "  - Android: Copied automatically at build time (Gradle task)"
    echo "  - iOS: Bundled automatically via podspec resources"
    echo ""
    echo "No manual action required for normal builds."
else
    echo -e "${YELLOW}✗ espeak-ng-data not found${NC}"
    echo "Run: git submodule update --init --recursive"
    exit 1
fi

# Optional: Manual copy for Android (for debugging)
if [ "$1" == "--android" ]; then
    ANDROID_ASSETS="$PROJECT_ROOT/android/src/main/assets"
    mkdir -p "$ANDROID_ASSETS"

    if [ -d "$ANDROID_ASSETS/espeak-ng-data" ]; then
        rm -rf "$ANDROID_ASSETS/espeak-ng-data"
    fi

    echo -e "${YELLOW}Manually copying espeak-ng-data to Android assets...${NC}"
    cp -r "$PROJECT_ROOT/third-party/espeak-ng/espeak-ng-data" "$ANDROID_ASSETS/"
    echo -e "${GREEN}✓ Done${NC}"
fi
