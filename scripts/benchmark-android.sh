#!/bin/bash
#
# Android Benchmark Trace Collector (Perfetto + android.os.Trace)
#
# Records a Perfetto trace capturing android.os.Trace sections while
# simultaneously collecting [BENCH] log markers. After collection,
# queries the trace with trace_processor_shell to extract TTS-specific
# trace slices and merges them with benchmark markers into a unified
# JSON report.
#
# The app must be built with RN_SPEECH_TRACE=true to enable
# android.os.Trace instrumentation (see SpeechTrace.kt).
# Trace sections appear as "TTS:*" slices.
#
# Enable: ./gradlew assembleRelease -PRN_SPEECH_TRACE=true
#
# Usage:
#   ./scripts/benchmark-android.sh [--duration 60] [--output report.json]
#
# Prerequisites:
#   - adb connected to device
#   - Example app installed: speech.example
#   - Optional: trace_processor_shell (for SQL querying of trace)
#     Install: https://perfetto.dev/docs/quickstart/traceconv
#
# The script will:
#   1. Start Perfetto recording on device with atrace categories
#   2. Simultaneously capture [BENCH] log markers via logcat
#   3. Wait for user to run benchmark, then Ctrl+C
#   4. Pull trace file and query with trace_processor_shell
#   5. Merge everything into a JSON report
#

set -euo pipefail

DURATION=120
OUTPUT=""
PACKAGE="speech.example"
TRACE_DIR=$(mktemp -d)
DEVICE_TRACE="/data/misc/perfetto-traces/benchmark.perfetto-trace"
LOCAL_TRACE="${TRACE_DIR}/benchmark.perfetto-trace"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --duration) DURATION="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --package) PACKAGE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--duration 120] [--output report.json] [--package speech.example]"
      echo ""
      echo "Options:"
      echo "  --duration  Max recording duration in seconds (default: 120)"
      echo "  --output    Output JSON file path (default: auto-generated)"
      echo "  --package   App package name (default: speech.example)"
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$OUTPUT" ]; then
  OUTPUT="benchmark-android-trace-$(date +%Y%m%d-%H%M%S).json"
fi

# Temp files
LOGCAT_FILE=$(mktemp)
QUERY_FILE=$(mktemp)
PERFETTO_CONFIG=$(mktemp)

cleanup() {
  kill "$LOGCAT_PID" 2>/dev/null || true
  adb shell "kill \$(cat /tmp/perfetto_bench_pid 2>/dev/null) 2>/dev/null; rm -f /tmp/perfetto_bench_pid" 2>/dev/null || true
  rm -f "$LOGCAT_FILE" "$QUERY_FILE" "$PERFETTO_CONFIG"
  if [ -d "$TRACE_DIR" ] && [ -f "$LOCAL_TRACE" ]; then
    echo "Trace file retained at: $LOCAL_TRACE"
    echo "Open in Perfetto UI: https://ui.perfetto.dev"
  else
    rm -rf "$TRACE_DIR"
  fi
}
trap cleanup EXIT

# Verify adb connection
if ! adb devices | grep -q "device$"; then
  echo "ERROR: No Android device connected via adb"
  exit 1
fi

# Check for trace_processor_shell
HAS_TRACE_PROCESSOR=true
TRACE_PROCESSOR_CMD=""
if command -v trace_processor_shell &>/dev/null; then
  TRACE_PROCESSOR_CMD="trace_processor_shell"
elif command -v trace_processor &>/dev/null; then
  TRACE_PROCESSOR_CMD="trace_processor"
else
  echo "WARNING: trace_processor_shell not found."
  echo "Install from: https://perfetto.dev/docs/quickstart/traceconv"
  echo "Trace will be recorded but SQL querying will be skipped."
  HAS_TRACE_PROCESSOR=false
fi

# Check if perfetto is available on device
HAS_PERFETTO=true
if ! adb shell "command -v perfetto" &>/dev/null; then
  echo "WARNING: perfetto not available on device (requires Android 9+)."
  echo "Falling back to [BENCH] marker collection only."
  HAS_PERFETTO=false
fi

# Find the app PID
APP_PID=$(adb shell pidof "$PACKAGE" 2>/dev/null || echo "")
if [ -z "$APP_PID" ]; then
  echo "WARNING: App '$PACKAGE' not running. Start the app first."
fi

echo "=== Android Benchmark Trace Collector ==="
echo "Package:  $PACKAGE (PID: ${APP_PID:-not found yet})"
echo "Duration: ${DURATION}s max"
echo "Output:   $OUTPUT"
echo "Trace:    $LOCAL_TRACE"
echo "Perfetto: $HAS_PERFETTO"
echo "Trace processor: $HAS_TRACE_PROCESSOR"
echo ""

# Clear and start logcat capture for [BENCH] markers
adb logcat -c 2>/dev/null || true
adb logcat -v time | grep --line-buffered "\[BENCH\]" > "$LOGCAT_FILE" &
LOGCAT_PID=$!

# Create Perfetto config for atrace with our app
if $HAS_PERFETTO; then
  cat > "$PERFETTO_CONFIG" << PERFCFG
buffers {
  size_kb: 65536
  fill_policy: RING_BUFFER
}
data_sources {
  config {
    name: "linux.ftrace"
    ftrace_config {
      ftrace_events: "ftrace/print"
      atrace_categories: "view"
      atrace_apps: "$PACKAGE"
    }
  }
}
data_sources {
  config {
    name: "linux.process_stats"
    process_stats_config {
      scan_all_processes_on_start: true
      proc_stats_poll_ms: 500
    }
  }
}
duration_ms: $((DURATION * 1000))
PERFCFG

  # Push config to device and start recording
  adb push "$PERFETTO_CONFIG" /data/local/tmp/perfetto_config.pbtx 2>/dev/null

  echo "Starting Perfetto recording..."
  adb shell "nohup perfetto \
    --config /data/local/tmp/perfetto_config.pbtx \
    --out $DEVICE_TRACE \
    </dev/null >/dev/null 2>&1 &
    echo \$! > /tmp/perfetto_bench_pid" 2>/dev/null

  sleep 1

  PERFETTO_PID=$(adb shell "cat /tmp/perfetto_bench_pid 2>/dev/null" 2>/dev/null || echo "")
  if [ -n "$PERFETTO_PID" ]; then
    echo "Perfetto recording started (device PID: $PERFETTO_PID)"
  else
    echo "WARNING: Could not start Perfetto recording."
    HAS_PERFETTO=false
  fi
fi

echo ""
echo "Run the benchmark in the app now."
echo "Press Ctrl+C when the benchmark completes."
echo ""

# Wait for user interrupt
COLLECTING=true
trap 'COLLECTING=false' INT TERM

ELAPSED=0
while $COLLECTING; do
  # Check if perfetto is still running
  if $HAS_PERFETTO && [ -n "${PERFETTO_PID:-}" ]; then
    if ! adb shell "kill -0 $PERFETTO_PID 2>/dev/null" 2>/dev/null; then
      echo "Perfetto recording finished (duration limit reached)."
      break
    fi
  fi

  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$DURATION" ]; then
    echo "Duration limit (${DURATION}s) reached."
    break
  fi
done

echo ""
echo "Collection stopped. Processing..."

# Stop Perfetto
if $HAS_PERFETTO && [ -n "${PERFETTO_PID:-}" ]; then
  echo "Stopping Perfetto recording..."
  adb shell "kill $PERFETTO_PID 2>/dev/null" 2>/dev/null || true
  sleep 3

  # Pull trace from device
  echo "Pulling trace from device..."
  if adb pull "$DEVICE_TRACE" "$LOCAL_TRACE" 2>/dev/null; then
    TRACE_SIZE=$(du -h "$LOCAL_TRACE" | cut -f1)
    echo "Trace pulled: $TRACE_SIZE"

    # Clean up device trace
    adb shell "rm -f $DEVICE_TRACE /data/local/tmp/perfetto_config.pbtx /tmp/perfetto_bench_pid" 2>/dev/null || true
  else
    echo "WARNING: Could not pull trace from device."
    HAS_PERFETTO=false
  fi
fi

# Query trace with trace_processor_shell
SLICE_JSON="[]"
if $HAS_PERFETTO && $HAS_TRACE_PROCESSOR && [ -f "$LOCAL_TRACE" ]; then
  echo "Querying trace for TTS slices..."

  # Query for all TTS: trace sections
  SLICE_JSON=$($TRACE_PROCESSOR_CMD --query-file /dev/stdin "$LOCAL_TRACE" << 'SQL' 2>/dev/null | python3 -c "
import csv
import json
import sys

reader = csv.DictReader(sys.stdin)
slices = []
for row in reader:
    slices.append({
        'name': row.get('name', ''),
        'startNs': row.get('ts', '0'),
        'durationNs': row.get('dur', '0'),
        'category': row.get('category', ''),
        'threadName': row.get('thread_name', ''),
        'processName': row.get('process_name', ''),
    })
json.dump(slices, sys.stdout)
" 2>/dev/null || echo "[]"
SELECT
  s.name,
  s.ts,
  s.dur,
  s.category,
  t.name AS thread_name,
  p.name AS process_name
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE s.name LIKE 'TTS:%'
ORDER BY s.ts ASC;
SQL
)

  SLICE_COUNT=$(echo "$SLICE_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  echo "Extracted $SLICE_COUNT TTS trace slices."

  # Also query for memory counters if available
  MEMORY_JSON=$($TRACE_PROCESSOR_CMD --query-file /dev/stdin "$LOCAL_TRACE" << 'SQL' 2>/dev/null | python3 -c "
import csv
import json
import sys

reader = csv.DictReader(sys.stdin)
samples = []
for row in reader:
    samples.append({
        'ts': row.get('ts', '0'),
        'name': row.get('name', ''),
        'valueMB': round(float(row.get('value', '0')) / (1024 * 1024), 1),
    })
json.dump(samples, sys.stdout)
" 2>/dev/null || echo "[]"
SELECT
  c.ts,
  c.name,
  c.value
FROM counter c
JOIN process_counter_track pct ON c.track_id = pct.id
JOIN process p ON pct.upid = p.upid
WHERE p.name LIKE '%${PACKAGE}%'
  AND (c.name LIKE '%rss%' OR c.name LIKE '%heap%' OR c.name LIKE '%mem%')
ORDER BY c.ts ASC
LIMIT 1000;
SQL
)

  MEM_COUNT=$(echo "$MEMORY_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  if [ "$MEM_COUNT" != "0" ]; then
    echo "Extracted $MEM_COUNT memory counter samples."
  fi
else
  MEMORY_JSON="[]"
fi

echo "Generating merged report..."

# Build JSON report
{
  echo "{"
  echo "  \"platform\": \"android\","
  echo "  \"package\": \"$PACKAGE\","
  echo "  \"collectedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"traceFile\": \"$LOCAL_TRACE\","
  echo "  \"hasPerfettoData\": $HAS_PERFETTO,"
  echo "  \"hasTraceProcessor\": $HAS_TRACE_PROCESSOR,"

  # Trace slices from perfetto
  echo "  \"traceSlices\": $SLICE_JSON,"

  # Memory counters from perfetto
  echo "  \"memoryCounters\": $MEMORY_JSON,"

  # [BENCH] markers from logcat
  echo "  \"benchmarkMarkers\": ["
  FIRST=true
  while IFS= read -r line; do
    JSON=$(echo "$line" | sed 's/.*\[BENCH\] //')
    if [ -n "$JSON" ] && echo "$JSON" | grep -q '^{'; then
      if [ "$FIRST" = true ]; then
        FIRST=false
      else
        echo ","
      fi
      echo -n "    $JSON"
    fi
  done < "$LOGCAT_FILE"
  echo ""
  echo "  ]"

  echo "}"
} > "$OUTPUT"

echo ""
echo "=== Report Complete ==="
echo "JSON report: $OUTPUT"
echo "Trace file:  $LOCAL_TRACE"
echo ""

# Summary
MARKER_COUNT=$(grep -c "INIT_END\|SPEAK_END\|RELEASE_END" "$LOGCAT_FILE" 2>/dev/null || echo "0")
echo "Benchmark markers captured: $MARKER_COUNT"

if $HAS_PERFETTO && [ -f "$LOCAL_TRACE" ]; then
  echo ""
  echo "To inspect the trace in Perfetto UI:"
  echo "  1. Open https://ui.perfetto.dev"
  echo "  2. Drag and drop: $LOCAL_TRACE"
  echo "  3. Search for 'TTS:' in the search bar"
  echo ""
  echo "To query the trace with SQL:"
  if $HAS_TRACE_PROCESSOR; then
    echo "  $TRACE_PROCESSOR_CMD \"$LOCAL_TRACE\" --query 'SELECT name, dur/1e6 as ms FROM slice WHERE name LIKE \"TTS:%\" ORDER BY ts'"
  else
    echo "  Install trace_processor_shell first:"
    echo "  curl -LO https://get.perfetto.dev/trace_processor && chmod +x trace_processor"
  fi
fi
