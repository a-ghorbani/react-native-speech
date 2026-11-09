#!/usr/bin/env bash
# I57 experiment: run the self-test, always keep logcat + crash buffer + a system-crash summary.
set -uo pipefail
out=emulator-evidence
mkdir -p "$out"
adb shell getprop ro.build.fingerprint > "$out/fingerprint.txt" || true
packages/react-native-speech-phonon/scripts/ci-emulator-selftest.sh --apk app-debug.apk \
  --model "$HOME/phonon-model/phonon-31m-en" --page-size 16384 --scenarios s3 \
  --require S1_support,S2_init,S3_short_speak --out "$out" > "$out/run.txt" 2>&1
st=$?
cat "$out/run.txt"
adb logcat -d -b all -v threadtime > "$out/logcat-all.txt" 2>/dev/null || true
echo "$st" > "$out/exit.txt"
exit "$st"
