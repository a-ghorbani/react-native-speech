#!/usr/bin/env bash
# Run the example app's Phonon self-test on an emulator and check it (docs/DESIGN.md §4.2,
# §8.2): the android-emulator-phonon CI job, x86_64 API 35 with 4 KB and 16 KB pages.
#
#   1. device    `getconf PAGE_SIZE` is --page-size (the 16 KB job really runs on 16 KB pages)
#   2. install   the debug APK with the add-on (JS bundled in: no Metro), then the model checkpoint
#                (--model, a CI-cached phonon-31m-en folder) into the app's files dir with
#                run-as, so the run needs no network
#   3. run       the self-test deep link
#                speechexample://selftest/phonon?runs=N&scenarios=...&model=...&runId=ci
#                and wait for `[SelfTest] SELFTEST_DONE` in logcat (--timeout seconds)
#   4. check     every --require'd result logged `[SelfTest] <name> PASS`; S1 reported
#                supported=true and pageSize=--page-size; no crash of the app (crash buffer,
#                tombstone header, UnsatisfiedLinkError)
# Writes logcat.txt, logcat-crash.txt, device.json, selftest.json and check.txt to --out.
#
# Usage: ci-emulator-selftest.sh --apk <app-debug.apk> --model <dir> --page-size 4096|16384
#          --require S1_support,S2_init,S3_short_speak[,...] [--scenarios s3,s6] [--runs 3]
#          [--out <dir>] [--timeout 1200] [--package speech.example] [--serial <adb serial>]
#        ci-emulator-selftest.sh --check-log <logcat.txt> [--crash-log <file>] --page-size N
#          --require ...                                # step 4 alone, on saved logs
#        ci-emulator-selftest.sh --selftest             # step 4 on fixture logs
set -euo pipefail

PKG=speech.example
APK="" MODEL="" PAGE="" REQUIRE="" SCENARIOS="s3,s6" RUNS=3 OUT="emulator-selftest" TIMEOUT=1200
CHECK_LOG="" CRASH_LOG="" SERIAL=""

# check_log <logcat> <crash log or ""> <page size> <required,names> <package>: step 4.
check_log() {
  local log="$1" crash="$2" page="$3" require="$4" pkg="$5" st=0 name line
  for name in ${require//,/ }; do
    line="$(grep -E "\[SelfTest\] $name (PASS|FAIL)( |$)" "$log" | tail -1 || true)"
    if [[ "$line" == *"[SelfTest] $name PASS"* ]]; then
      echo "PASS $name: ${line#*"[SelfTest] $name PASS "}"
    elif [[ -n "$line" ]]; then
      echo "FAIL $name: ${line#*"[SelfTest] "}"; st=1
    else
      echo "FAIL $name: no result logged"; st=1
    fi
  done
  line="$(grep -E '\[SelfTest\] S1_support (PASS|FAIL)' "$log" | tail -1 || true)"
  if [[ "$line" == *" supported=true "* && "$line" == *" pageSize=$page"* ]]; then
    echo "PASS support: supported=true pageSize=$page"
  else
    echo "FAIL support: want supported=true pageSize=$page, got: ${line:-no S1_support line}"; st=1
  fi
  line="$(grep -E '\[SelfTest\] SELFTEST_DONE ' "$log" | tail -1 || true)"
  if [[ -n "$line" ]]; then echo "PASS done: ${line#*"[SelfTest] "}"; else echo "FAIL done: no SELFTEST_DONE"; st=1; fi
  local crashes=""
  if [[ -n "$crash" && -f "$crash" ]]; then
    crashes="$(grep -F "$pkg" "$crash" | head -3 || true)"
  fi
  # Native crash (tombstone header, libc's "Fatal signal ... (pkg)"), a failed library load,
  # and a Java crash (FATAL EXCEPTION, then "Process: pkg" on the next line).
  crashes+="$(grep -E ">>> $pkg <<<|UnsatisfiedLinkError|Fatal signal [0-9]+ .*\($pkg\)" "$log" | head -3 || true)"
  crashes+="$(grep -A2 -F 'FATAL EXCEPTION' "$log" | grep -F "Process: $pkg" | head -3 || true)"
  if [[ -n "$crashes" ]]; then echo "FAIL crash: $crashes"; st=1; else echo "PASS crash: no crash of $pkg"; fi
  return $st
}

selftest() {
  local dir st=0
  dir="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: $dir is local
  trap "rm -rf '$dir'" RETURN
  local ok16="$dir/ok16.txt"
  cat >"$ok16" <<'EOF'
10-21 10:00:00.000  1234  1260 I ReactNativeJS: '[SelfTest] START phonon runId=ci dir=/data/user/0/speech.example/files/phonon-evidence/ci'
10-21 10:00:00.100  1234  1260 I ReactNativeJS: [SelfTest] S1_support PASS supported=true reason=ok abi=x86_64 pageSize=16384
10-21 10:00:02.000  1234  1260 I ReactNativeJS: [SelfTest] S2_init PASS initMs=900 loadMs=700 compiled=true threads=4 unit=cpu voices=1 default="default"
10-21 10:00:09.000  1234  1260 I ReactNativeJS: [SelfTest] S3_short_speak PASS runs=3 firstAudio.median=900 p90=1000 rtf.median=0.9
10-21 10:00:09.500  1234  1260 I ReactNativeJS: [SelfTest] SELFTEST_DONE passed=3 failed=0 dir=/data/user/0/speech.example/files/phonon-evidence/ci
EOF
  local req=S1_support,S2_init,S3_short_speak
  expect() {
    local want="$1" check="$2" what="$3" out rc=0
    shift 3
    out="$("$0" "$@" 2>&1)" || rc=$?
    if [[ "$want" == pass && $rc -eq 0 ]] ||
      [[ "$want" == fail && $rc -ne 0 && "$out" == *"FAIL $check:"* ]]; then
      echo "selftest ok: $what"
    else
      echo "selftest FAILED: $what (exit $rc, wanted $want${check:+ on $check})"
      printf '    %s\n' "${out//$'\n'/$'\n'    }"
      st=1
    fi
  }
  expect pass - "16 KB run" --check-log "$ok16" --page-size 16384 --require "$req"
  expect fail support "16 KB run checked as 4 KB" --check-log "$ok16" --page-size 4096 --require "$req"
  expect fail S6_stop "required result never logged" --check-log "$ok16" --page-size 16384 --require "$req,S6_stop"

  sed 's/S3_short_speak PASS/S3_short_speak FAIL/' "$ok16" >"$dir/s3fail.txt"
  expect fail S3_short_speak "a required result failed" --check-log "$dir/s3fail.txt" --page-size 16384 --require "$req"
  sed 's/supported=true reason=ok/supported=false reason=missing-cpu-features/' "$ok16" >"$dir/unsup.txt"
  expect fail support "engine unsupported" --check-log "$dir/unsup.txt" --page-size 16384 --require S1_support
  grep -v SELFTEST_DONE "$ok16" >"$dir/nodone.txt"
  expect fail "done" "self-test never finished" --check-log "$dir/nodone.txt" --page-size 16384 --require "$req"
  { cat "$ok16"; echo "10-21 10:00:09.600  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main"; \
    echo "10-21 10:00:09.600  1234  1234 E AndroidRuntime: Process: speech.example, PID: 1234"; } >"$dir/java.txt"
  expect fail crash "Java crash of the app" --check-log "$dir/java.txt" --page-size 16384 --require "$req"
  { cat "$ok16"; echo "10-21 10:00:09.600  1234  1290 F libc    : Fatal signal 4 (SIGILL), code 1 (ILL_ILLOPC), fault addr 0x7f in tid 1290 (pool), pid 1234 (speech.example)"; } >"$dir/sigill.txt"
  expect fail crash "native crash of the app" --check-log "$dir/sigill.txt" --page-size 16384 --require "$req"
  { cat "$ok16"; echo "10-21 10:00:09.600  1234  1260 E SoLoader: java.lang.UnsatisfiedLinkError: dlopen failed"; } >"$dir/ule.txt"
  expect fail crash "UnsatisfiedLinkError" --check-log "$dir/ule.txt" --page-size 16384 --require "$req"
  { cat "$ok16"; echo "10-21 10:00:09.600   999   999 E AndroidRuntime: FATAL EXCEPTION: main"; \
    echo "10-21 10:00:09.600   999   999 E AndroidRuntime: Process: com.android.systemui, PID: 999"; } >"$dir/other.txt"
  expect pass - "another process crashing is not ours" --check-log "$dir/other.txt" --page-size 16384 --require "$req"
  echo "--------- beginning of crash" >"$dir/crash-empty.txt"
  expect pass - "empty crash buffer" --check-log "$ok16" --crash-log "$dir/crash-empty.txt" --page-size 16384 --require "$req"
  { echo "--------- beginning of crash"; echo "10-21 10:00:09 F DEBUG   : pid: 1234, tid: 1290, name: pool  >>> speech.example <<<"; } >"$dir/crash.txt"
  expect fail crash "crash buffer has the app" --check-log "$ok16" --crash-log "$dir/crash.txt" --page-size 16384 --require "$req"
  return $st
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk) APK="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --page-size) PAGE="$2"; shift 2 ;;
    --require) REQUIRE="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --package) PKG="$2"; shift 2 ;;
    --serial) SERIAL="$2"; shift 2 ;;
    --check-log) CHECK_LOG="$2"; shift 2 ;;
    --crash-log) CRASH_LOG="$2"; shift 2 ;;
    --selftest) selftest; exit $? ;;
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$PAGE" =~ ^[0-9]+$ ]] || { echo "--page-size is required" >&2; exit 2; }
[[ -n "$REQUIRE" ]] || { echo "--require is required" >&2; exit 2; }

if [[ -n "$CHECK_LOG" ]]; then
  check_log "$CHECK_LOG" "$CRASH_LOG" "$PAGE" "$REQUIRE" "$PKG"
  exit $?
fi

[[ -f "$APK" ]] || { echo "--apk <app-debug.apk> is required" >&2; exit 2; }
[[ -d "$MODEL" ]] || { echo "--model <checkpoint dir> is required" >&2; exit 2; }
ADB=(adb)
[[ -z "$SERIAL" ]] || ADB=(adb -s "$SERIAL")
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

"${ADB[@]}" wait-for-device
for _ in $(seq 1 60); do
  [[ "$("${ADB[@]}" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] && break
  sleep 2
done

# 1. device
device_page="$("${ADB[@]}" shell getconf PAGE_SIZE | tr -d '\r')"
jq -n --arg page "$device_page" --arg abi "$("${ADB[@]}" shell getprop ro.product.cpu.abilist | tr -d '\r')" \
  --arg release "$("${ADB[@]}" shell getprop ro.build.version.release | tr -d '\r')" \
  --arg sdk "$("${ADB[@]}" shell getprop ro.build.version.sdk | tr -d '\r')" \
  --arg fingerprint "$("${ADB[@]}" shell getprop ro.build.fingerprint | tr -d '\r')" \
  --arg apkSha "$(sha256sum "$APK" | cut -d' ' -f1)" \
  '{pageSize: ($page | tonumber), abilist: $abi, release: $release, sdk: $sdk,
    fingerprint: $fingerprint, apkSha256: $apkSha}' >"$OUT/device.json"
cat "$OUT/device.json"
if [[ "$device_page" != "$PAGE" ]]; then
  echo "FAIL device: PAGE_SIZE $device_page, expected $PAGE" | tee "$OUT/check.txt"
  exit 1
fi

# 2. install
"${ADB[@]}" install -r -t "$APK"
name="$(basename "$MODEL")"
dest="files/phonon-ci/$name"
"${ADB[@]}" shell rm -rf "/data/local/tmp/phonon-ci"
"${ADB[@]}" shell mkdir -p "/data/local/tmp/phonon-ci/$name"
"${ADB[@]}" shell run-as "$PKG" mkdir -p "$dest"
for f in "$MODEL"/*; do
  [[ -f "$f" ]] || continue
  base="$(basename "$f")"
  "${ADB[@]}" push "$f" "/data/local/tmp/phonon-ci/$name/$base" >/dev/null
  # run-as cannot read /data/local/tmp under SELinux; the shell can, and pipes it in.
  "${ADB[@]}" shell "cat /data/local/tmp/phonon-ci/$name/$base | run-as $PKG sh -c 'cat > $dest/$base'"
  want="$(wc -c <"$f" | tr -d ' ')"
  have="$("${ADB[@]}" shell run-as "$PKG" stat -c %s "$dest/$base" | tr -d '\r')"
  [[ "$want" == "$have" ]] || { echo "model copy of $base: $have bytes, expected $want" >&2; exit 1; }
done
"${ADB[@]}" shell rm -rf "/data/local/tmp/phonon-ci"
model_path="/data/user/0/$PKG/$dest"
echo "model: $model_path"

# 3. run
"${ADB[@]}" logcat -c || true
"${ADB[@]}" logcat -b crash -c || true
url="speechexample://selftest/phonon?runs=$RUNS&scenarios=$SCENARIOS&model=$model_path&runId=ci"
"${ADB[@]}" shell am force-stop "$PKG"
# The app only mounts (and reads the deep link) in the foreground: screen on, keyguard gone.
"${ADB[@]}" shell input keyevent KEYCODE_WAKEUP || true
"${ADB[@]}" shell wm dismiss-keyguard || true
"${ADB[@]}" shell svc power stayon true || true
"${ADB[@]}" shell "am start -W -a android.intent.action.VIEW -d '$url' $PKG"
deadline=$((SECONDS + TIMEOUT))
done=0
while ((SECONDS < deadline)); do
  # grep without -q reads to the end: no SIGPIPE for adb under pipefail.
  if "${ADB[@]}" logcat -d -s ReactNativeJS:V | grep '\[SelfTest\] SELFTEST_DONE' >/dev/null; then done=1; break; fi
  if [[ -z "$("${ADB[@]}" shell pidof "$PKG" | tr -d '\r')" ]]; then
    sleep 3
    [[ -n "$("${ADB[@]}" shell pidof "$PKG" | tr -d '\r')" ]] || { echo "app is not running" >&2; break; }
  fi
  sleep 5
done
((done)) || echo "no SELFTEST_DONE within ${TIMEOUT}s" >&2

# 4. collect + check
"${ADB[@]}" logcat -d -v threadtime >"$OUT/logcat.txt" || true
"${ADB[@]}" logcat -d -b crash -v threadtime >"$OUT/logcat-crash.txt" || true
"${ADB[@]}" shell run-as "$PKG" cat files/phonon-evidence/ci/selftest.json >"$OUT/selftest.json" 2>/dev/null || true
"${ADB[@]}" shell run-as "$PKG" cat files/phonon-evidence/ci/bench.jsonl >"$OUT/bench.jsonl" 2>/dev/null || true
grep -F '[SelfTest]' "$OUT/logcat.txt" || true
st=0
check_log "$OUT/logcat.txt" "$OUT/logcat-crash.txt" "$PAGE" "$REQUIRE" "$PKG" | tee "$OUT/check.txt" || st=1
exit $st
