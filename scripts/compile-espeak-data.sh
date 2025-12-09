#!/bin/bash
set -e

# Compile espeak-ng data files using macOS espeak-ng installation
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ESPEAK_ROOT="${PROJECT_ROOT}/third-party/espeak-ng"
DATA_DIR="${ESPEAK_ROOT}/espeak-ng-data"

echo "Compiling espeak-ng data files..."

# Check if espeak-ng is installed on macOS
if ! command -v espeak-ng &> /dev/null; then
    echo "ERROR: espeak-ng not found. Installing via Homebrew..."
    brew install espeak-ng
fi

# Get the system espeak-ng data directory (usually in Homebrew)
SYSTEM_DATA="/opt/homebrew/share/espeak-ng-data"

# Try alternate locations if not found
if [ ! -d "$SYSTEM_DATA" ]; then
    SYSTEM_DATA="/usr/local/share/espeak-ng-data"
fi

if [ ! -d "$SYSTEM_DATA" ]; then
    echo "ERROR: Could not find espeak-ng-data. Tried:"
    echo "  /opt/homebrew/share/espeak-ng-data"
    echo "  /usr/local/share/espeak-ng-data"
    exit 1
fi

echo "System espeak-ng data path: $SYSTEM_DATA"

# Copy the compiled data files to our repo
if [ -d "$SYSTEM_DATA" ]; then
    echo "Copying compiled data files from system installation..."

    # Copy root data files (phondata, phontab, intonations, etc.)
    for file in "$SYSTEM_DATA"/*; do
        if [ -f "$file" ]; then
            filename=$(basename "$file")
            echo "  Copying $filename..."
            cp "$file" "$DATA_DIR/"
        fi
    done

    echo "✓ Data files compiled and copied successfully!"
    echo ""
    echo "Files in espeak-ng-data:"
    ls -lh "$DATA_DIR" | grep -v "^d"
else
    echo "ERROR: Could not find system espeak-ng data directory"
    exit 1
fi
