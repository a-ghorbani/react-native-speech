#!/bin/bash
# Run the example app's playback-edges suite (example/src/selftest/edgesSelfTest.ts)
# on a connected Android device through its deep link, and collect the evidence.
#
# usage: scripts/e2e-edges-android.sh [--install <apk>] [--cold] [query]
#   query: deep-link parameters, e.g. "engine=kitten&scenarios=stop,fuzz&seed=7"
#   --cold: force-stop the app first, so the run starts in a fresh process
#
# JS timers stop while the screen is off, so the screen is kept on for the run
# (stay on while plugged in, restored afterwards, plus a wake key every poll).
# Grants RECORD_AUDIO (mic scenario) and POST_NOTIFICATIONS (duck scenario)
# and revokes the ones the app did not already have. Uses
# $ANDROID_SERIAL when several devices are connected; EDGES_TIMEOUT (s,
# default 5400) bounds the wait for the DONE line. Writes logcat, the
# [SelfTest] lines and the pulled edges-evidence/ folder to e2e-artifacts/edges/.
set -euo pipefail

cd "$(dirname "$0")/.."

APP=speech.example
APK=""
COLD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) APK="$2"; shift 2 ;;
    --cold) COLD=1; shift ;;
    *) break ;;
  esac
done
QUERY="${1:-engine=kitten}"

ADB=(adb)
[[ -n "${ANDROID_SERIAL:-}" ]] && ADB=(adb -s "$ANDROID_SERIAL")

RUN_ID="edges-$(date +%Y%m%d-%H%M%S)"
OUT="e2e-artifacts/edges/${ANDROID_SERIAL:-device}-$RUN_ID"
mkdir -p "$OUT"

if [[ -n "$APK" ]]; then
  echo "Installing $APK"
  "${ADB[@]}" install -r "$APK"
fi

PERMS=(android.permission.RECORD_AUDIO android.permission.POST_NOTIFICATIONS)
granted=$("${ADB[@]}" shell dumpsys package "$APP" || true)
to_revoke=()
for perm in "${PERMS[@]}"; do
  if ! grep -q "$perm: granted=true" <<<"$granted"; then
    to_revoke+=("$perm")
  fi
  "${ADB[@]}" shell pm grant "$APP" "$perm" || true
done

stay_on=$("${ADB[@]}" shell settings get global stay_on_while_plugged_in | tr -d '\r')
"${ADB[@]}" shell svc power stayon true
"${ADB[@]}" shell input keyevent KEYCODE_WAKEUP
"${ADB[@]}" shell wm dismiss-keyguard || true

cleanup() {
  "${ADB[@]}" shell settings put global stay_on_while_plugged_in "${stay_on:-0}" || true
  "${ADB[@]}" logcat -d >"$OUT/logcat.txt" 2>/dev/null || true
  grep '\[SelfTest\]' "$OUT/logcat.txt" >"$OUT/selftest.txt" || true
  "${ADB[@]}" pull "/sdcard/Android/data/$APP/files/edges-evidence/$RUN_ID" "$OUT/" >/dev/null 2>&1 || true
  # Revoking kills the app, and Android would relaunch it with the same deep link.
  "${ADB[@]}" shell am force-stop "$APP" || true
  for perm in ${to_revoke[@]+"${to_revoke[@]}"}; do
    "${ADB[@]}" shell pm revoke "$APP" "$perm" || true
  done
}
trap cleanup EXIT

[[ $COLD -eq 1 ]] && "${ADB[@]}" shell am force-stop "$APP"
"${ADB[@]}" logcat -c || true

URL="speechexample://selftest?suite=edges&runId=$RUN_ID&$QUERY"
echo "=== edges: $URL"
"${ADB[@]}" shell am start -W -a android.intent.action.VIEW -d "'$URL'" "$APP" >/dev/null

deadline=$(( $(date +%s) + ${EDGES_TIMEOUT:-5400} ))
status=1
while [[ $(date +%s) -lt $deadline ]]; do
  done_line=$("${ADB[@]}" logcat -d -s ReactNativeJS:V | grep -m1 'SELFTEST DONE suite=edges' || true)
  if [[ -n "$done_line" ]]; then
    echo "$done_line"
    [[ "$done_line" == *" failed=0 "* ]] && status=0
    break
  fi
  "${ADB[@]}" shell input keyevent KEYCODE_WAKEUP || true
  "${ADB[@]}" shell wm dismiss-keyguard || true
  if ! "${ADB[@]}" shell pidof "$APP" >/dev/null; then
    echo "app process died (crash?); see $OUT/logcat.txt"
    break
  fi
  sleep 5
done

cleanup
trap - EXIT
echo "--- results ($OUT)"
grep -E '\[SelfTest\] E[0-9]_\S+ (PASS|FAIL|SKIP)' "$OUT/selftest.txt" | sed 's/.*\[SelfTest\] //' || true
exit $status
