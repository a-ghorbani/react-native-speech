#!/bin/bash
#
# Benchmark Runner Convenience Wrapper
#
# Runs the platform-specific benchmark script and automatically compares
# results against the stored baseline.
#
# Usage:
#   ./scripts/benchmark-run.sh ios [--device agh] [--duration 60]
#   ./scripts/benchmark-run.sh android [--duration 60]
#   ./scripts/benchmark-run.sh compare --baseline b.json --current c.json
#   ./scripts/benchmark-run.sh update-baseline ios   # copy latest -> baseline
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BENCHMARKS_DIR="${PROJECT_DIR}/benchmarks"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <ios|android|compare|update-baseline> [options]"
  echo ""
  echo "Commands:"
  echo "  ios              Run iOS benchmark (passes remaining args to benchmark-ios.sh)"
  echo "  android          Run Android benchmark (passes remaining args to benchmark-android.sh)"
  echo "  compare          Compare two result files (--baseline X --current Y)"
  echo "  update-baseline  Copy latest results to baseline (specify platform: ios|android)"
  echo ""
  echo "Examples:"
  echo "  $0 ios --device agh --duration 60"
  echo "  $0 android"
  echo "  $0 update-baseline ios"
  echo "  $0 compare --baseline benchmarks/baseline/ios-Mac.json --current benchmarks/latest/ios-Mac.json"
  exit 1
fi

COMMAND="$1"
shift

case "$COMMAND" in
  ios)
    exec "$SCRIPT_DIR/benchmark-ios.sh" "$@"
    ;;

  android)
    exec "$SCRIPT_DIR/benchmark-android.sh" "$@"
    ;;

  compare)
    exec python3 "$SCRIPT_DIR/benchmark-compare.py" "$@"
    ;;

  update-baseline)
    PLATFORM="${1:-}"
    if [ -z "$PLATFORM" ]; then
      echo "Usage: $0 update-baseline <ios|android>"
      exit 1
    fi

    LATEST_DIR="${BENCHMARKS_DIR}/latest"
    BASELINE_DIR="${BENCHMARKS_DIR}/baseline"
    mkdir -p "$BASELINE_DIR"

    FOUND=0
    for f in "$LATEST_DIR/${PLATFORM}"-*.json; do
      if [ -f "$f" ]; then
        BASENAME=$(basename "$f")
        cp "$f" "$BASELINE_DIR/$BASENAME"
        echo "Updated baseline: $BASELINE_DIR/$BASENAME"
        FOUND=1
      fi
    done

    if [ "$FOUND" -eq 0 ]; then
      echo "No latest results found for platform '$PLATFORM'."
      echo "Run a benchmark first: $0 $PLATFORM"
      exit 1
    fi

    echo ""
    echo "Baseline updated. Commit to persist:"
    echo "  git add benchmarks/baseline/ && git commit -m 'bench: update $PLATFORM baseline'"
    ;;

  *)
    echo "Unknown command: $COMMAND"
    echo "Use: ios, android, compare, or update-baseline"
    exit 1
    ;;
esac
