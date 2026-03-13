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

# Initialized later, but need defaults before cleanup trap (set -u)
LOGSTREAM_PID=""
NOTIFY_PID=""
XCTRACE_PID=""
NOTIFY_LOG=""
DEVICE_MARKERS_FILE=""

cleanup() {
  [ -n "$LOGSTREAM_PID" ] && kill "$LOGSTREAM_PID" 2>/dev/null || true
  [ -n "$NOTIFY_PID" ] && kill "$NOTIFY_PID" 2>/dev/null || true
  # Don't kill xctrace here — it's stopped gracefully in the main flow.
  # Killing it during cleanup can corrupt the trace bundle.
  rm -f "$LOGSTREAM_FILE" "$EXPORT_FILE" "$MEMORY_FILE" "${NOTIFY_LOG:-}" "${DEVICE_MARKERS_FILE:-}"
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

# Start marker collection.
# - Simulator/local: use /usr/bin/log stream to capture [BENCH] markers in real time.
# - Physical device: markers are written to the app's Documents/benchmark-markers.json
#   by the native RNBenchmark module. We pull the file after recording via devicectl.
#   Auto-stop uses Darwin notification observation via devicectl.
BUNDLE_ID="com.mhpdev.rn.speech"
DARWIN_NOTIFICATION="com.mhpdev.rn.speech.benchmarkComplete"

if $IS_REMOTE; then
  echo "Physical device: markers collected via app file (devicectl copy)."
  echo "Auto-stop via Darwin notification observation."

  # Start a long-running observer with --log-output.
  # Key insight: stdout and --json-output are buffered until exit,
  # but --log-output is flushed in real-time. We grep it in the poll loop.
  NOTIFY_LOG=$(mktemp -t notify-log.XXXXXX.txt)
  xcrun devicectl device notification observe \
    --device "$DEVICE_UUID" \
    --name "$DARWIN_NOTIFICATION" \
    --session-timeout "$DURATION" \
    --log-output "$NOTIFY_LOG" \
    </dev/null >/dev/null 2>/dev/null &
  NOTIFY_PID=$!
  sleep 2
  if kill -0 "$NOTIFY_PID" 2>/dev/null; then
    echo "Darwin notification observer started (PID: $NOTIFY_PID)"
  else
    echo "WARNING: Darwin notification observer failed to start."
    echo "Auto-stop will NOT work — you'll need to Ctrl+C manually."
    NOTIFY_PID=""
  fi
else
  # Simulator/local: use log stream for [BENCH] markers
  /usr/bin/log stream \
    --predicate 'composedMessage CONTAINS "[BENCH]" OR eventMessage CONTAINS "[BENCH]"' \
    --level debug --style compact \
    > "$LOGSTREAM_FILE" 2>/dev/null &
  LOGSTREAM_PID=$!
fi

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
echo "Will auto-stop when SUITE_COMPLETE is detected (or press Ctrl+C)."
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

  # Auto-stop when benchmark suite completes
  if $IS_REMOTE; then
    # Physical device: check --log-output from the background observer.
    # --log-output is flushed in real-time (unlike stdout/--json-output).
    if [ -s "$NOTIFY_LOG" ] && grep -q "Observed" "$NOTIFY_LOG" 2>/dev/null; then
      echo ""
      echo "SUITE_COMPLETE detected (Darwin notification) — stopping collection."
      break
    fi
  else
    # Simulator/local: check log stream for SUITE_COMPLETE
    if [ -s "$LOGSTREAM_FILE" ] && grep -q "SUITE_COMPLETE" "$LOGSTREAM_FILE" 2>/dev/null; then
      echo ""
      echo "SUITE_COMPLETE detected — stopping collection."
      break
    fi
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

# For physical devices, pull benchmark markers from the app container
DEVICE_MARKERS_FILE=""
if $IS_REMOTE && [ -n "$DEVICE_UUID" ]; then
  echo "Pulling benchmark markers from device..."
  DEVICE_MARKERS_FILE=$(mktemp -t benchmark-markers.XXXXXX.json)

  COPY_OUTPUT=$(xcrun devicectl device copy from \
      --device "$DEVICE_UUID" \
      --domain-type appDataContainer \
      --domain-identifier "$BUNDLE_ID" \
      --source "Documents/benchmark-markers.json" \
      --destination "$DEVICE_MARKERS_FILE" \
      2>&1) || true

  if [ -s "$DEVICE_MARKERS_FILE" ]; then
    DEVICE_MARKER_COUNT=$(python3 -c "import json; print(len(json.load(open('$DEVICE_MARKERS_FILE'))))" 2>/dev/null || echo "0")
    echo "Pulled $DEVICE_MARKER_COUNT markers from device."
  else
    DEVICE_MARKERS_FILE=""
    echo "WARNING: Could not pull markers from device."
    echo "Make sure the app has been rebuilt with the latest RNBenchmark module."
    if [ -n "$COPY_OUTPUT" ]; then
      echo "devicectl output: $COPY_OUTPUT"
    fi
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

  # [BENCH] markers: from device file (physical) or log stream (simulator)
  if [ -n "$DEVICE_MARKERS_FILE" ] && [ -s "$DEVICE_MARKERS_FILE" ]; then
    # Device markers are already a JSON array — embed directly
    echo -n "  \"benchmarkMarkers\": "
    cat "$DEVICE_MARKERS_FILE"
    echo ""
  else
    # Parse from log stream output
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
  fi

  echo "}"
} > "$OUTPUT"

echo ""
echo "=== Report Complete ==="
echo "JSON report: $OUTPUT"

# Summary
if [ -n "$DEVICE_MARKERS_FILE" ] && [ -s "$DEVICE_MARKERS_FILE" ]; then
  MARKER_COUNT=$(python3 -c "
import json
markers = json.load(open('$DEVICE_MARKERS_FILE'))
count = sum(1 for m in markers if isinstance(m, dict) and m.get('event') in ('INIT_END','SPEAK_END','RELEASE_END'))
print(count)
" 2>/dev/null || echo "0")
else
  MARKER_COUNT=$(grep -c "INIT_END\|SPEAK_END\|RELEASE_END" "$LOGSTREAM_FILE" 2>/dev/null)
  MARKER_COUNT=${MARKER_COUNT:-0}
fi
SNAPSHOT_COUNT=0
if [ -s "$MEMORY_FILE" ]; then
  SNAPSHOT_COUNT=$(wc -l < "$MEMORY_FILE" | tr -d ' ')
fi
echo "Benchmark markers: $MARKER_COUNT"
echo "Memory/CPU polls:  $SNAPSHOT_COUNT"

if [ "$MARKER_COUNT" = "0" ]; then
  echo ""
  echo "NOTE: No [BENCH] markers captured."
  if $IS_REMOTE; then
    echo "Make sure the app has been rebuilt with the latest RNBenchmark module"
    echo "that includes file-based marker collection."
  else
    echo "In debug mode, React Native console.log goes through Metro, not os_log."
    echo "Build the app in Release mode or use the Metro terminal output."
  fi
fi

# Clean up device markers temp dir
# DEVICE_MARKERS_FILE is a mktemp file, cleaned up by rm -f in cleanup trap

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

# Convert raw report to canonical benchmark format
if [ "$MARKER_COUNT" != "0" ]; then
  echo ""
  echo "Converting to canonical benchmark format..."

  CANONICAL_DIR="${BENCHMARKS_DIR}/latest"
  mkdir -p "$CANONICAL_DIR"

  # Detect device model
  DEVICE_MODEL="unknown"
  if [ -n "$DEVICE_NAME" ]; then
    DEVICE_MODEL="$DEVICE_NAME"
  elif [ -n "$DEVICE_UUID" ]; then
    DEVICE_MODEL=$(xcrun simctl list devices | grep "$DEVICE_UUID" | sed 's/ (.*//' | xargs 2>/dev/null || echo "Simulator")
  else
    DEVICE_MODEL=$(sysctl -n hw.model 2>/dev/null || echo "Mac")
  fi

  # Sanitize device name for filename
  DEVICE_SLUG=$(echo "$DEVICE_MODEL" | tr ' /' '-' | tr -cd 'a-zA-Z0-9_-')

  COMMIT_SHA=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
  BRANCH=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

  python3 - "$OUTPUT" "$CANONICAL_DIR/ios-${DEVICE_SLUG}.json" \
    "$DEVICE_MODEL" "$COMMIT_SHA" "$BRANCH" << 'PYEOF'
import json, sys

raw_path, out_path, device, commit_sha, branch = sys.argv[1:6]

with open(raw_path) as f:
    raw = json.load(f)

markers = raw.get("benchmarkMarkers", [])

suite_complete = None
run_ends = []
suite_start = None

for m in markers:
    ev = m.get("event", "")
    if ev == "SUITE_COMPLETE":
        suite_complete = m
    elif ev == "RUN_END":
        run_ends.append(m)
    elif ev == "SUITE_START":
        suite_start = m

if not suite_complete:
    print("No SUITE_COMPLETE marker found. Skipping canonical output.", file=sys.stderr)
    sys.exit(0)

config = {}
if suite_start:
    config = {
        "iterations": suite_start.get("iterations", 0),
        "warmupIterations": suite_start.get("warmupIterations", 0),
        "testPhrase": "(captured)",
        "provider": suite_start.get("provider", "auto"),
    }

engines = []
for summary in suite_complete.get("summaries", []):
    eng_name = summary["engine"]
    variant = summary.get("variant", "default")

    iters = []
    for r in run_ends:
        if r.get("engine") == eng_name and r.get("variant", "default") == variant:
            iters.append({
                "iteration": r.get("iteration", 0),
                "isWarmup": r.get("isWarmup", False),
                "initMs": r.get("initMs", 0),
                "ttfaMs": r.get("ttfaMs", 0),
                "totalSpeakMs": r.get("totalSpeakMs", 0),
                "releaseMs": r.get("releaseMs", 0),
                "peakInitMemoryMB": r.get("peakInitMemoryMB"),
                "peakSpeakMemoryMB": r.get("peakSpeakMemoryMB"),
                "memoryBaseline": r.get("memoryBaseline"),
                "memoryPostInit": r.get("memoryPostInit"),
                "memoryPostSpeak": r.get("memoryPostSpeak"),
                "memoryPostRelease": r.get("memoryPostRelease"),
            })

    engines.append({
        "engine": eng_name,
        "variant": variant,
        "stats": summary.get("stats", {}),
        "peakInitMemoryMB": summary.get("stats", {}).get("peakInitMemoryMB"),
        "peakSpeakMemoryMB": summary.get("stats", {}).get("peakSpeakMemoryMB"),
        "iterations": iters,
    })

canonical = {
    "version": 1,
    "platform": "ios",
    "device": device,
    "collectedAt": raw.get("collectedAt", ""),
    "commitSha": commit_sha,
    "branch": branch,
    "config": config,
    "engines": engines,
}

with open(out_path, "w") as f:
    json.dump(canonical, f, indent=2)
print(f"Canonical result: {out_path}")
PYEOF

  # Compare against baseline if it exists
  BASELINE_FILE="${BENCHMARKS_DIR}/baseline/ios-${DEVICE_SLUG}.json"
  LATEST_FILE="${CANONICAL_DIR}/ios-${DEVICE_SLUG}.json"
  COMPARE_SCRIPT="${SCRIPT_DIR}/benchmark-compare.py"

  if [ -f "$BASELINE_FILE" ] && [ -f "$LATEST_FILE" ] && [ -f "$COMPARE_SCRIPT" ]; then
    echo ""
    python3 "$COMPARE_SCRIPT" --baseline "$BASELINE_FILE" --current "$LATEST_FILE" || true
  fi
fi
