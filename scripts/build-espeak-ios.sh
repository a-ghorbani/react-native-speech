#!/bin/bash
set -e

# Build espeak-ng for iOS
# This script prepares espeak-ng source files and data for iOS integration

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ESPEAK_DIR="$PROJECT_ROOT/third-party/espeak-ng"
IOS_DIR="$PROJECT_ROOT/ios"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Preparing espeak-ng for iOS...${NC}"

# Initialize espeak-ng if needed
cd "$ESPEAK_DIR"
if [ ! -f configure ]; then
    echo -e "${YELLOW}Running autogen.sh...${NC}"
    ./autogen.sh
fi

# Create symbolic link in ios directory
echo -e "${YELLOW}Creating symbolic link to espeak-ng...${NC}"
cd "$IOS_DIR"
if [ -L "espeak-ng" ]; then
    rm espeak-ng
fi
ln -s "../third-party/espeak-ng" espeak-ng
echo -e "${GREEN}✓ Created symbolic link${NC}"

# Copy espeak-ng-data to ios directory (for bundling)
echo -e "${YELLOW}Preparing espeak-ng-data...${NC}"

# First, we need to build espeak-ng-data if it doesn't exist
if [ ! -d "$ESPEAK_DIR/espeak-ng-data" ]; then
    echo -e "${YELLOW}Building espeak-ng-data...${NC}"
    cd "$ESPEAK_DIR"

    # Configure for host (macOS)
    if [ ! -f Makefile ]; then
        ./configure --prefix="$ESPEAK_DIR/build-host"
    fi

    # Build just the data
    make espeak-ng-data

    echo -e "${GREEN}✓ Built espeak-ng-data${NC}"
fi

# Copy data to ios directory
if [ -d "$IOS_DIR/espeak-ng-data" ]; then
    rm -rf "$IOS_DIR/espeak-ng-data"
fi
cp -r "$ESPEAK_DIR/espeak-ng-data" "$IOS_DIR/"
echo -e "${GREEN}✓ Copied espeak-ng-data${NC}"

# Optional: Remove non-English languages to reduce size
read -p "Remove non-English languages to reduce size? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Removing non-English languages...${NC}"
    cd "$IOS_DIR/espeak-ng-data"
    find lang -maxdepth 1 -type d ! -name 'lang' ! -name 'en' -exec rm -rf {} + 2>/dev/null || true
    find voices -maxdepth 1 -type d ! -name 'voices' ! -name 'en' ! -name '!v' -exec rm -rf {} + 2>/dev/null || true
    echo -e "${GREEN}✓ Removed non-English languages${NC}"
    echo -e "${GREEN}  Data size reduced from ~5MB to ~500KB${NC}"
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Preparation complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Next steps:"
echo "  1. Open your Xcode project"
echo "  2. Add espeak-ng source files to your project:"
echo "     • Right-click project → Add Files"
echo "     • Navigate to ios/espeak-ng/src/libespeak-ng"
echo "     • Select all .c files"
echo "     • Check 'Copy items if needed' is UNCHECKED"
echo "     • Click Add"
echo ""
echo "  3. Add espeak-ng-data to bundle resources:"
echo "     • Right-click project → Add Files"
echo "     • Navigate to ios/espeak-ng-data"
echo "     • Check 'Create folder references'"
echo "     • Click Add"
echo "     • Verify it appears in Build Phases → Copy Bundle Resources"
echo ""
echo "  4. Configure build settings:"
echo "     • Build Settings → Header Search Paths"
echo "     • Add: \$(SRCROOT)/espeak-ng/src/include (recursive)"
echo "     • Build Settings → Other C Flags"
echo "     • Add: -DHAVE_CONFIG_H"
echo ""
echo "  5. Build: cmd+B"
echo ""
echo "See ESPEAK_SETUP.md for detailed instructions"
echo ""
