#!/bin/bash
set -e

# Prepare espeak-ng-data for distribution
# This copies data from the submodule to Android assets

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}Preparing espeak-ng-data...${NC}"

# Check if submodule is initialized
if [ ! -d "$PROJECT_ROOT/third-party/espeak-ng/espeak-ng-data" ]; then
    echo -e "${YELLOW}espeak-ng submodule not found. Initializing...${NC}"
    cd "$PROJECT_ROOT"
    git submodule update --init --recursive
fi

# Android: Copy to assets
ANDROID_ASSETS="$PROJECT_ROOT/android/src/main/assets"
mkdir -p "$ANDROID_ASSETS"

if [ -d "$ANDROID_ASSETS/espeak-ng-data" ]; then
    echo -e "${YELLOW}Removing old Android espeak-ng-data...${NC}"
    rm -rf "$ANDROID_ASSETS/espeak-ng-data"
fi

echo -e "${YELLOW}Copying espeak-ng-data to Android assets...${NC}"
cp -r "$PROJECT_ROOT/third-party/espeak-ng/espeak-ng-data" "$ANDROID_ASSETS/"

# iOS: Data is referenced directly from submodule via Podspec resource_bundles
# No need to copy for iOS

echo -e "${GREEN}✓ espeak-ng-data prepared successfully${NC}"
echo ""
echo "Android: Data copied to android/src/main/assets/espeak-ng-data/"
echo "iOS: Data will be bundled automatically from third-party/espeak-ng/espeak-ng-data/"
echo ""

# Optional: Size optimization
read -p "Remove non-English languages to reduce size? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Removing non-English languages...${NC}"

    # Android
    cd "$ANDROID_ASSETS/espeak-ng-data"
    find lang -maxdepth 1 -type d ! -name 'lang' ! -name 'en' -exec rm -rf {} + 2>/dev/null || true
    find voices -maxdepth 1 -type d ! -name 'voices' ! -name 'en' ! -name '!v' -exec rm -rf {} + 2>/dev/null || true

    echo -e "${GREEN}✓ Removed non-English languages from Android${NC}"
    echo -e "${GREEN}  Data size reduced from ~5MB to ~500KB${NC}"
    echo ""
    echo "Note: iOS will still have all languages (referenced from submodule)"
    echo "To remove from iOS, edit the submodule directly (not recommended)"
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Data preparation complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
