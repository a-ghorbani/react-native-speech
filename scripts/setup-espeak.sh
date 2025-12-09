#!/bin/bash
set -e

# espeak-ng Setup Script
# Automates the setup of espeak-ng for react-native-speech

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  espeak-ng Setup for react-native-speech${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check if submodule is initialized
if [ ! -f "$PROJECT_ROOT/third-party/espeak-ng/configure.ac" ]; then
    echo -e "${YELLOW}Initializing git submodules...${NC}"
    cd "$PROJECT_ROOT"
    git submodule update --init --recursive
    echo -e "${GREEN}✓ Submodules initialized${NC}"
fi

# Platform selection
echo ""
echo "Select platform to build for:"
echo "  1) Android"
echo "  2) iOS"
echo "  3) Both"
echo ""
read -p "Enter choice [1-3]: " choice

case $choice in
    1)
        echo -e "${GREEN}Building for Android...${NC}"
        "$SCRIPT_DIR/build-espeak-android.sh"
        ;;
    2)
        echo -e "${GREEN}Building for iOS...${NC}"
        "$SCRIPT_DIR/build-espeak-ios-framework.sh"
        ;;
    3)
        echo -e "${GREEN}Building for both platforms...${NC}"
        "$SCRIPT_DIR/build-espeak-android.sh"
        echo ""
        "$SCRIPT_DIR/build-espeak-ios-framework.sh"
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Setup complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Next steps:"
echo "  • See ESPEAK_SETUP.md for platform-specific configuration"
echo "  • For Android: Build your app with ./gradlew assembleDebug"
echo "  • For iOS: Follow the Xcode setup instructions in ESPEAK_SETUP.md"
echo ""
