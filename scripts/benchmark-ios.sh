#!/bin/bash
#
# iOS Benchmark Trace Collector (xctrace + os_signpost)
#
# Records an Instruments trace using xctrace while simultaneously polling
# memory/CPU externally and capturing [BENCH] log markers. After collection,
# exports signpost intervals (if present) and merges everything into a
# unified JSON report.
#
# The app must be built with RN_SPEECH_TRACE=1 to enable os_signpost
# instrumentation (see RNSpeechTrace.h/mm). Signpost intervals appear
# under the "com.mhpdev.speech" subsystem with category "TTS"
# (auto-instrumented) or "JS" (benchmark runner phases).
#
# Enable: set ENV['RN_SPEECH_TRACE']='1' in Podfile, then pod install.
#
# Usage:
#   ./scripts/benchmark-ios.sh [--duration 60] [--output report.json]
#
# Templates:
#   Allocations  - Heap allocations, VM, leaks (default — best for TTS)
#   Logging      - os_signpost intervals + os_log (signpost-focused)
#   Time Profiler - CPU sampling, call stacks
#   System Trace  - CPU scheduling, VM, I/O (heavyweight)
#
# Prerequisites:
#   - Xcode command line tools installed (xctrace)
#   - Simulator running or device connected
#   - Example app installed and running: SpeechExample
#

set -euo pipefail

DURATION=120
OUTPUT=""
PROCESS_NAME="SpeechExample"
TEMPLATE="Allocations"
POLL_INTERVAL=2
DEVICE_ARG=""

# Record to temp dir (xctrace is picky about output paths), then copy to benchmarks/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BENCHMARKS_DIR="${PROJECT_DIR}/benchmarks"
mkdir -p "$BENCHMARKS_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TRACE_DIR=$(mktemp -d)
TRACE_FILE="${TRACE_DIR}/benchmark.trace"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --duration) DURATION="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --process) PROCESS_NAME="$2"; shift 2 ;;
    --template) TEMPLATE="$2"; shift 2 ;;
    --interval) POLL_INTERVAL="$2"; shift 2 ;;
    --device) DEVICE_ARG="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --duration  Max recording duration in seconds (default: 120)"
      echo "  --output    Output JSON file path (default: auto-generated)"
      echo "  --process   Process name to attach to (default: SpeechExample)"
      echo "  --template  Instruments template (default: Allocations)"
      echo "  --interval  External poll interval in seconds (default: 2)"
      echo "  --device    Device name or UUID (e.g., 'agh' or UUID from xctrace list devices)"
      echo ""
      echo "Templates:"
      echo "  Allocations   - Heap allocations, VM, leaks (best for TTS memory)"
      echo "  Logging       - os_signpost intervals + os_log (signpost timeline)"
      echo "  Time Profiler - CPU sampling, call stacks"
      echo "  System Trace  - CPU scheduling, VM, I/O (heavyweight)"
      echo ""
      echo "The trace file can be opened in Instruments for interactive inspection."
      echo "Signpost data is exported automatically if the template captures it."
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$OUTPUT" ]; then
  OUTPUT="${BENCHMARKS_DIR}/benchmark-ios-trace-${TIMESTAMP}.json"
fi

# Temp files
LOGSTREAM_FILE=$(mktemp)
EXPORT_FILE=$(mktemp)
MEMORY_FILE=$(mktemp)

cleanup() {
  kill "$LOGSTREAM_PID" 2>/dev/null || true
  # Don't kill xctrace here — it's stopped gracefully in the main flow.
  # Killing it during cleanup can corrupt the trace bundle.
  rm -f "$LOGSTREAM_FILE" "$EXPORT_FILE" "$MEMORY_FILE"
  if [ -e "$TRACE_FILE" ]; then
    SAVED_TRACE="${BENCHMARKS_DIR}/benchmark-${TIMESTAMP}.trace"
    echo ""
    echo "Copying trace to benchmarks/..."
    cp -R "$TRACE_FILE" "$SAVED_TRACE"
    rm -rf "$TRACE_DIR"
    echo "Trace file: $SAVED_TRACE"
    echo "Open in Instruments:    open \"$SAVED_TRACE\""
  else
    rm -rf "$TRACE_DIR"
  fi
}
trap cleanup EXIT

# Check prerequisites
HAS_XCTRACE=true
if ! command -v xctrace &>/dev/null; then
  echo "WARNING: xctrace not found. Install Xcode command line tools."
  echo "Falling back to external polling only."
  HAS_XCTRACE=false
fi

# Find the process and detect device context
PID=""
DEVICE_UUID=""
DEVICE_NAME=""
IS_REMOTE=false  # true for physical devices (can't pgrep)

find_process() {
  local pid=""
  pid=$(pgrep -x "$PROCESS_NAME" 2>/dev/null | head -1 || echo "")
  if [ -z "$pid" ]; then
    pid=$(pgrep -f "$PROCESS_NAME" 2>/dev/null | head -1 || echo "")
  fi
  echo "$pid"
}

detect_simulator() {
  local pid="$1"
  PROC_PATH=$(ps -p "$pid" -o command= 2>/dev/null || echo "")
  if echo "$PROC_PATH" | grep -q "CoreSimulator/Devices"; then
    DEVICE_UUID=$(echo "$PROC_PATH" | sed -n 's|.*CoreSimulator/Devices/\([^/]*\)/.*|\1|p')
  fi
}

# Resolve --device argument to a UUID
if [ -n "$DEVICE_ARG" ] && $HAS_XCTRACE; then
  # Check if it's already a UUID
  if echo "$DEVICE_ARG" | grep -qE '^[0-9A-Fa-f-]{36}$'; then
    DEVICE_UUID="$DEVICE_ARG"
    DEVICE_NAME="$DEVICE_ARG"
  else
    # Search by name in xctrace device list
    DEVICE_LINE=$(xctrace list devices 2>/dev/null | grep -i "$DEVICE_ARG" | head -1 || echo "")
    if [ -n "$DEVICE_LINE" ]; then
      DEVICE_UUID=$(echo "$DEVICE_LINE" | sed -n 's/.*(\([0-9A-Fa-f-]*\))$/\1/p')
      DEVICE_NAME=$(echo "$DEVICE_LINE" | sed 's/ ([^)]*)$//')
      echo "Resolved device: $DEVICE_NAME ($DEVICE_UUID)"
    else
      echo "ERROR: Device '$DEVICE_ARG' not found. Available devices:"
      xctrace list devices 2>/dev/null | grep -v "^==" | grep -v "^$"
      exit 1
    fi
  fi

  # Physical devices: can't use pgrep, xctrace will find the process by name
  if ! echo "$DEVICE_UUID" | grep -qE '^[0-9A-F]{8}-'; then
    # Not a simulator UUID format — it's a physical device
    IS_REMOTE=true
  else
    # Could be simulator, check
    SIM_CHECK=$(xctrace list devices 2>/dev/null | grep -A999 "Simulators" | grep "$DEVICE_UUID" || echo "")
    if [ -z "$SIM_CHECK" ]; then
      IS_REMOTE=true
    fi
  fi
fi

# For local targets (no --device or simulator), find process by PID
if ! $IS_REMOTE; then
  PID=$(find_process)
  if [ -n "$PID" ]; then
    # Auto-detect simulator if --device wasn't specified
    if [ -z "$DEVICE_UUID" ]; then
      detect_simulator "$PID"
      if [ -n "$DEVICE_UUID" ]; then
        echo "Detected simulator device: $DEVICE_UUID"
      fi
    fi
  else
    echo "WARNING: Process '$PROCESS_NAME' not found. Start the app first."
    echo "Will attempt to find it when recording starts..."
  fi
fi

echo "=== iOS Benchmark Trace Collector ==="
if $IS_REMOTE; then
  echo "Device:    ${DEVICE_NAME:-$DEVICE_UUID}"
  echo "Process:   $PROCESS_NAME (will attach on device)"
else
  echo "Process:   $PROCESS_NAME (PID: ${PID:-not found yet})"
  if [ -n "$DEVICE_UUID" ]; then
    echo "Simulator: $DEVICE_UUID"
  fi
fi
echo "Template:  $TEMPLATE"
echo "Duration:  ${DURATION}s max"
echo "Output:    $OUTPUT"
echo ""

# Start log stream capture for [BENCH] markers
# Try both eventMessage and composedMessage predicates, with debug level
log stream \
  --predicate 'composedMessage CONTAINS "[BENCH]" OR eventMessage CONTAINS "[BENCH]"' \
  --level debug --style compact > "$LOGSTREAM_FILE" 2>/dev/null &
LOGSTREAM_PID=$!

# Start xctrace recording
XCTRACE_PID=""
if $HAS_XCTRACE; then
  if $IS_REMOTE; then
    # Physical device: attach by process name (can't use PID)
    echo "Starting xctrace recording ($TEMPLATE template) on ${DEVICE_NAME:-device}..."

    XCTRACE_CMD=(xctrace record --template "$TEMPLATE" --device "$DEVICE_UUID" --attach "$PROCESS_NAME" --time-limit "${DURATION}s" --output "$TRACE_FILE")

    XCTRACE_LOG=$(mktemp)
    "${XCTRACE_CMD[@]}" >"$XCTRACE_LOG" 2>&1 &
    XCTRACE_PID=$!
    sleep 3

    if ! kill -0 "$XCTRACE_PID" 2>/dev/null; then
      echo "ERROR: xctrace failed to start:"
      cat "$XCTRACE_LOG" 2>/dev/null
      echo ""
      echo "Make sure '$PROCESS_NAME' is running on the device."
      echo "Falling back to external polling only."
      HAS_XCTRACE=false
      XCTRACE_PID=""
    else
      echo "xctrace recording started (PID: $XCTRACE_PID)"
    fi
    rm -f "$XCTRACE_LOG"
  else
    # Local: find process by PID
    if [ -z "$PID" ]; then
      echo "Waiting for process '$PROCESS_NAME'..."
      for i in $(seq 1 30); do
        PID=$(find_process)
        if [ -n "$PID" ]; then
          echo "Found PID: $PID"
          if [ -z "$DEVICE_UUID" ]; then
            detect_simulator "$PID"
            if [ -n "$DEVICE_UUID" ]; then
              echo "Detected simulator device: $DEVICE_UUID"
            fi
          fi
          break
        fi
        sleep 1
      done
    fi

    if [ -n "$PID" ]; then
      echo "Starting xctrace recording ($TEMPLATE template)..."

      XCTRACE_CMD=(xctrace record --template "$TEMPLATE" --attach "$PID" --time-limit "${DURATION}s" --output "$TRACE_FILE")
      if [ -n "$DEVICE_UUID" ]; then
        XCTRACE_CMD+=(--device "$DEVICE_UUID")
      fi

      XCTRACE_LOG=$(mktemp)
      "${XCTRACE_CMD[@]}" >"$XCTRACE_LOG" 2>&1 &
      XCTRACE_PID=$!
      sleep 2

      if ! kill -0 "$XCTRACE_PID" 2>/dev/null; then
        echo "ERROR: xctrace failed to start:"
        cat "$XCTRACE_LOG" 2>/dev/null
        echo ""
        echo "Falling back to external polling only."
        HAS_XCTRACE=false
        XCTRACE_PID=""
      else
        echo "xctrace recording started (PID: $XCTRACE_PID)"
      fi
      rm -f "$XCTRACE_LOG"
    else
      echo "WARNING: Could not find process. Skipping xctrace recording."
      HAS_XCTRACE=false
    fi
  fi
fi

echo ""
echo "Run the benchmark in the app now."
echo "Press Ctrl+C when the benchmark completes."
echo ""

# Poll memory/CPU externally alongside xctrace
COLLECTING=true
trap 'COLLECTING=false' INT TERM

while $COLLECTING; do
  # Check if xctrace is still running
  if [ -n "$XCTRACE_PID" ] && ! kill -0 "$XCTRACE_PID" 2>/dev/null; then
    echo "xctrace recording finished (duration limit reached)."
    break
  fi

  # External memory/CPU polling via ps + footprint
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    TS=$(date +%s)
    PS_OUTPUT=$(ps -p "$PID" -o rss=,vsz=,%cpu= 2>/dev/null || echo "")
    if [ -n "$PS_OUTPUT" ]; then
      RSS_KB=$(echo "$PS_OUTPUT" | awk '{print $1}')
      VSZ_KB=$(echo "$PS_OUTPUT" | awk '{print $2}')
      CPU_PCT=$(echo "$PS_OUTPUT" | awk '{print $3}')
      echo "{\"ts\":$TS,\"pid\":$PID,\"rssKB\":${RSS_KB:-0},\"vszKB\":${VSZ_KB:-0},\"cpuPercent\":${CPU_PCT:-0}}" >> "$MEMORY_FILE"
    fi

    if command -v footprint &>/dev/null; then
      FOOTPRINT_OUTPUT=$(footprint -p "$PID" 2>/dev/null | grep "total footprint" || echo "")
      if [ -n "$FOOTPRINT_OUTPUT" ]; then
        FOOTPRINT_MB=$(echo "$FOOTPRINT_OUTPUT" | awk '{print $1}')
        echo "{\"ts\":$TS,\"pid\":$PID,\"footprintMB\":${FOOTPRINT_MB:-0},\"source\":\"footprint\"}" >> "$MEMORY_FILE"
      fi
    fi
  fi

  sleep "$POLL_INTERVAL" || true
done

echo ""
echo "Collection stopped. Processing..."

# Ignore further Ctrl+C during finalization — interrupting here corrupts the trace
trap '' INT TERM

# Stop xctrace gracefully and wait for it to finalize the trace
if [ -n "$XCTRACE_PID" ] && kill -0 "$XCTRACE_PID" 2>/dev/null; then
  echo "Stopping xctrace recording (waiting for trace finalization)..."
  kill -INT "$XCTRACE_PID" 2>/dev/null || true
  # Wait for xctrace to fully exit — it needs time to transfer and finalize
  # deferred data from physical devices
  for i in $(seq 1 120); do
    if ! kill -0 "$XCTRACE_PID" 2>/dev/null; then
      echo "xctrace finalized after ${i}s."
      break
    fi
    if [ "$i" = "1" ]; then
      echo -n "Waiting for xctrace to finish writing"
    fi
    echo -n "."
    sleep 1
  done
  echo ""
  wait "$XCTRACE_PID" 2>/dev/null || true
fi

# Export signpost intervals from xctrace (if the template captured them)
SIGNPOST_JSON="[]"
if $HAS_XCTRACE && [ -e "$TRACE_FILE" ]; then
  echo "Exporting signpost intervals from trace..."

  # Try known schema names — varies by Xcode version and template
  EXPORT_OK=false
  for SCHEMA in "os-signpost-interval" "os-signpost" "os-signpost-point-schema" "os-signpost-interval-schema" "signpost-interval"; do
    if xctrace export --input "$TRACE_FILE" --xpath "/trace-toc/run/data/table[@schema=\"$SCHEMA\"]" > "$EXPORT_FILE" 2>/dev/null; then
      if [ -s "$EXPORT_FILE" ]; then
        echo "Found signpost data with schema: $SCHEMA"
        EXPORT_OK=true
        break
      fi
    fi
  done

  # Fallback: export the full TOC to discover available schemas
  if ! $EXPORT_OK; then
    if xctrace export --input "$TRACE_FILE" --toc > "$EXPORT_FILE" 2>/dev/null; then
      SCHEMAS=$(python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('$EXPORT_FILE')
for table in tree.iter('table'):
    schema = table.get('schema', '')
    if 'signpost' in schema.lower():
        print(schema)
" 2>/dev/null || echo "")
      if [ -n "$SCHEMAS" ]; then
        echo "Available signpost schemas: $SCHEMAS"
        FIRST_SCHEMA=$(echo "$SCHEMAS" | head -1)
        if xctrace export --input "$TRACE_FILE" --xpath "/trace-toc/run/data/table[@schema=\"$FIRST_SCHEMA\"]" > "$EXPORT_FILE" 2>/dev/null; then
          EXPORT_OK=true
        fi
      else
        echo "No signpost data in this trace (template '$TEMPLATE' may not capture signposts)."
        echo "Use --template Logging for signpost data."
      fi
    fi
  fi

  if $EXPORT_OK && [ -s "$EXPORT_FILE" ]; then
    # Parse the exported XML into JSON signpost intervals
    # xctrace export format: <schema> defines column mnemonics, then <row> elements
    # contain positional children matching the schema column order.
    SIGNPOST_JSON=$(python3 -c "
import xml.etree.ElementTree as ET
import json
import sys

try:
    tree = ET.parse('$EXPORT_FILE')
    root = tree.getroot()
    intervals = []

    # Extract column mnemonics from schema definition
    mnemonics = []
    for schema in root.iter('schema'):
        for col in schema.findall('col'):
            m = col.find('mnemonic')
            mnemonics.append(m.text if m is not None else '')

    for row in root.iter('row'):
        cols = list(row)
        record = {}

        if mnemonics:
            for i, col in enumerate(cols):
                mnem = mnemonics[i] if i < len(mnemonics) else ''
                val = col.get('fmt', '') or col.text or ''
                if mnem == 'name':
                    record['name'] = val
                elif mnem == 'start':
                    record['start'] = val
                elif mnem == 'duration':
                    record['duration'] = val
                elif mnem == 'subsystem':
                    record['subsystem'] = val
                elif mnem == 'category':
                    record['category'] = val
        else:
            for col in cols:
                ref = col.get('ref', col.tag)
                val = col.get('fmt', '') or col.text or ''
                if 'name' in ref and 'process' not in ref:
                    record['name'] = val
                elif ref == 'start':
                    record['start'] = val
                elif ref == 'duration':
                    record['duration'] = val
                elif 'subsystem' in ref:
                    record['subsystem'] = val
                elif 'category' in ref:
                    record['category'] = val

        # Only include TTS-related signposts
        if record.get('subsystem', '') == 'com.mhpdev.speech' or \
           record.get('name', '').startswith('TTS:'):
            intervals.append(record)

    json.dump(intervals, sys.stdout)
except Exception as e:
    print('[]', end='')
    print(f'Warning: XML parse error: {e}', file=sys.stderr)
" 2>/dev/null || echo "[]")

    SIGNPOST_COUNT=$(echo "$SIGNPOST_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    echo "Exported $SIGNPOST_COUNT signpost intervals."
  fi
fi

echo "Generating merged report..."

# Build JSON report
{
  echo "{"
  echo "  \"platform\": \"ios\","
  echo "  \"processName\": \"$PROCESS_NAME\","
  echo "  \"template\": \"$TEMPLATE\","
  echo "  \"collectedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"traceFile\": \"$TRACE_FILE\","
  echo "  \"hasXctraceData\": $HAS_XCTRACE,"

  # Signpost intervals from xctrace
  echo "  \"signpostIntervals\": $SIGNPOST_JSON,"

  # External memory/CPU snapshots
  echo "  \"externalSnapshots\": ["
  FIRST=true
  if [ -s "$MEMORY_FILE" ]; then
    while IFS= read -r line; do
      if [ "$FIRST" = true ]; then
        FIRST=false
      else
        echo ","
      fi
      echo -n "    $line"
    done < "$MEMORY_FILE"
  fi
  echo ""
  echo "  ],"

  # [BENCH] markers from log stream
  echo "  \"benchmarkMarkers\": ["
  FIRST=true
  while IFS= read -r line; do
    JSON=$(echo "$line" | sed 's/.*\[BENCH\] //')
    if echo "$JSON" | grep -q '^{'; then
      if [ "$FIRST" = true ]; then
        FIRST=false
      else
        echo ","
      fi
      echo -n "    $JSON"
    fi
  done < "$LOGSTREAM_FILE"
  echo ""
  echo "  ]"

  echo "}"
} > "$OUTPUT"

echo ""
echo "=== Report Complete ==="
echo "JSON report: $OUTPUT"

# Summary
MARKER_COUNT=$(grep -c "INIT_END\|SPEAK_END\|RELEASE_END" "$LOGSTREAM_FILE" 2>/dev/null || echo "0")
SNAPSHOT_COUNT=0
if [ -s "$MEMORY_FILE" ]; then
  SNAPSHOT_COUNT=$(wc -l < "$MEMORY_FILE" | tr -d ' ')
fi
echo "Benchmark markers: $MARKER_COUNT"
echo "Memory/CPU polls:  $SNAPSHOT_COUNT"

if [ "$MARKER_COUNT" = "0" ]; then
  echo ""
  echo "NOTE: No [BENCH] markers captured."
  echo "In debug mode, React Native console.log goes through Metro, not os_log."
  echo "The in-app benchmark UI still shows all results. For [BENCH] marker"
  echo "collection, build the app in Release mode or use the Metro terminal output."
fi

SAVED_TRACE="${BENCHMARKS_DIR}/benchmark-${TIMESTAMP}.trace"
if $HAS_XCTRACE && [ -e "$SAVED_TRACE" ]; then
  TRACE_SIZE=$(du -sh "$SAVED_TRACE" 2>/dev/null | cut -f1)
  echo ""
  echo "Trace file: $SAVED_TRACE ($TRACE_SIZE)"
  echo ""
  echo "To inspect in Instruments:"
  echo "  open \"$SAVED_TRACE\""
elif $HAS_XCTRACE && [ -e "$TRACE_FILE" ]; then
  TRACE_SIZE=$(du -sh "$TRACE_FILE" 2>/dev/null | cut -f1)
  echo ""
  echo "Trace file: $TRACE_FILE ($TRACE_SIZE)"
fi
