#!/bin/bash
# Run the example app's end-to-end flows (example/e2e) on a connected
# Android device or emulator with Maestro.
#
# usage: scripts/e2e-android.sh [--install <apk>] [ENGINE ...]
#   ENGINE: Kitten (default), Kokoro, Supertonic. Kitten's model is
#   downloaded if missing; other engines need a model already installed.
#
# Uses $ANDROID_SERIAL when several devices are connected. Extra Maestro
# options go in $MAESTRO_ARGS, e.g. MAESTRO_ARGS=--no-reinstall-driver on
# phones that ask to confirm every USB install (MIUI). Writes Maestro
# reports, screenshots and logcat to e2e-artifacts/.
set -euo pipefail

cd "$(dirname "$0")/.."

APK=""
if [[ "${1:-}" == "--install" ]]; then
  APK="$2"
  shift 2
fi
ENGINES=("$@")
[[ ${#ENGINES[@]} -eq 0 ]] && ENGINES=(Kitten)

ADB=(adb)
MAESTRO_DEVICE=()
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  ADB=(adb -s "$ANDROID_SERIAL")
  MAESTRO_DEVICE=(--device "$ANDROID_SERIAL")
fi

OUT=e2e-artifacts
mkdir -p "$OUT"

if [[ -n "$APK" ]]; then
  echo "Installing $APK"
  "${ADB[@]}" install -r "$APK"
fi

"${ADB[@]}" logcat -c || true
save_logcat() {
  "${ADB[@]}" logcat -d >"$OUT/logcat.txt" 2>/dev/null || true
  grep '\[SelfTest\]' "$OUT/logcat.txt" >"$OUT/selftest.txt" || true
}
trap save_logcat EXIT

status=0
for engine in "${ENGINES[@]}"; do
  echo "=== e2e: $engine"
  # shellcheck disable=SC2086 # MAESTRO_ARGS is intentionally word-split
  if ! maestro test ${MAESTRO_DEVICE[@]+"${MAESTRO_DEVICE[@]}"} ${MAESTRO_ARGS:-} \
    --env ENGINE="$engine" \
    --format JUNIT --output "$OUT/report-$engine.xml" \
    --test-output-dir "$OUT/$engine" \
    example/e2e/run.yaml; then
    status=1
  fi
done

save_logcat
echo "--- [SelfTest] log"
cat "$OUT/selftest.txt"
exit $status
