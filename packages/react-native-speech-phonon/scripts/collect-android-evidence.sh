#!/usr/bin/env bash
# Device evidence for the Phonon engine on one Android phone (docs/DESIGN.md §8.3-§8.5).
#
#   collect-android-evidence.sh <serial> <device-slug> <flavor> --apk <apk> [options]
#   collect-android-evidence.sh --selftest                # offline tests of the checks
#   collect-android-evidence.sh <serial> <slug> <flavor> --apk <apk> --dry-run   # print the plan
#
# <flavor> names the evidence folder and sets what is expected (§8.5):
#   addon              supported (or, with --scenario U1, missing-cpu-features)
#   core               not-compiled (F1): the example built without the add-on
#   addon-32bit        unsupported-abi (U2); a phone without 32-bit userspace refuses the
#                      install, which is recorded (exit 3, NOT-RUN)
#   forced-<reason>    U3 debug build with RNSpeech_phononForceReason=<reason>
#   negative-control   N1 debug build with RNSpeech_phononSkipHwcapGate=true: a SIGILL crash on
#                      create is the expected outcome (stored separately, never a product build)
#   anything else      (e.g. smoke) supported, like addon
#
# One run = install -> clear logcat -> device.json -> launch -> (model push) -> meminfo-before ->
# self-test deep link -> wait for `[SelfTest] SELFTEST_DONE` (--timeout, default 600 s), with
# `adb exec-out screencap` + a uiautomator dump at every `SCREENSHOT_READY` marker -> maps
# check (run-as /proc/<pid>/maps when debuggable, plus the app's own `[SelfTest] MAPS` line) ->
# meminfo-after -> pid-filtered logcat, crash buffer, new dropbox native crashes, §8.4 regex ->
# pull phonon-evidence/<runId>/ (external files dir, or run-as) -> check.txt.
#
# Scenarios (--scenario, comma-separated; §8.3 ids):
#   ALL (default)  the self-test's default run: S1-S10, S12 (one process, one deep link)
#   S1..S12        that scenario only (`scenarios=` on the deep link; S1 and the init always run)
#   S11            interruptions: the script presses HOME on `S11_BACKGROUND_REQUEST` and brings
#                  the app back; the reload half needs a debuggable flavor (release: NOT-RUN)
#   S13            sweep: threads x spin (--threads-list 2,3,4,6 --spin-list default,200), a
#                  fresh process each, S3 x --runs; writes threads.json
#   U1 U2 U3 F1    the unsupported flow (support probe, direct init code, libraryLoaded:false,
#                  libptts_ffi not mapped, OS-native speak, no Phonon UI, no Alert)
#
# Options:
#   --apk <file>          APK to install (required unless --no-install)
#   --model <m>           download   the app downloads the model itself (`download=1`)
#                         <dir>      a staged folder (stage-android-model.sh): pushed into the
#                                    app's external files dir, installed by the app (`modelFrom=`)
#                         none       nothing (default for unsupported flavors)
#                         Default for supported flavors: $PHONON_MODEL_DIR if set, else download.
#   --runs N --cycles N --threads N --spin N   self-test knobs (defaults: app defaults)
#   --threads-list L --spin-list L             S13 grid (default 2,3,4,6 and default,200)
#   --hold MS             how long the app stays on a tab after SCREENSHOT_READY (default 4000)
#   --out <dir>           default docs/evidence/android/<slug>/<flavor> (gitignored), or
#                         .../<flavor>/scenarios/<ids> for a scenario subset
#   --run-id <id>         default <flavor>-<ids>-<utc time>
#   --timeout S           per self-test run (default 600)
#   --abi <abi>           adb install --abi (e.g. armeabi-v7a for U2)
#   --fresh               uninstall first (clears an installed model)
#   --no-install          use the installed app
#   --keep-app            do not uninstall at the end (default: uninstall, the phone stays clean)
#   --emulator            thresholds recorded but exempt (auto-detected from ro.kernel.qemu)
#   --dry-run             print every adb command instead of running it (no phone needed)
#
# Exit: 0 every check passed, 1 a check failed, 2 usage, 3 NOT-RUN (install refused, no device).
# Needs: adb, jq, unzip, python3 (UI dump parsing), gzip.
set -euo pipefail
if ((BASH_VERSINFO[0] < 4)); then echo "needs bash >= 4" >&2; exit 2; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PKG=speech.example
ACTIVITY="$PKG/.MainActivity"
LOGCAT_REGEX='FATAL EXCEPTION|Fatal signal|SIGILL|SIGSEGV|SIGABRT|UnsatisfiedLinkError|tombstone|ANR in speech.example|E/RNSpeech|E/Phonon|E ReactNativeJS'
# The same tags in `-v threadtime` layout ("<pid> <tid> E RNSpeech: ...").
LOGCAT_REGEX_TT=' E RNSpeech *:| E Phonon *:'
# Thresholds (§8.3, physical devices).
TH_RTF=0.35 TH_FIRST_AUDIO=800 TH_STOP=150 TH_GAP=150

SERIAL="" SLUG="" FLAVOR="" APK="" MODEL="" SCENARIO="ALL"
RUNS="" CYCLES="" THREADS="" SPIN="" HOLD=4000 OUT="" RUN_ID="" TIMEOUT=600 ABI=""
THREADS_LIST="2,3,4,6" SPIN_LIST="default,200"
FRESH=0 INSTALL=1 KEEP_APP=0 EMULATOR=0 DRY=0

# Pure helpers, covered by --selftest.

# expected_reason <flavor> <scenario ids>: the support reason this run must report.
expected_reason() {
  local flavor="$1" ids=",${2^^},"
  case "$flavor" in
    core) echo not-compiled ;;
    addon-32bit) echo unsupported-abi ;;
    forced-*) echo "${flavor#forced-}" ;;
    negative-control) echo crash ;;
    *) if [[ "$ids" == *,U1,* ]]; then echo missing-cpu-features; else echo ok; fi ;;
  esac
}

# deep_link_scenarios <scenario ids>: the `scenarios=` value ("" = the app's default set).
deep_link_scenarios() {
  local id out=()
  for id in ${1//,/ }; do
    id="${id^^}"
    case "$id" in
      ALL | U1 | U2 | U3 | F1 | S13) ;;
      S[1-9] | S1[0-2]) out+=("s${id#S}") ;;
      *) echo "unknown scenario: $id" >&2; return 2 ;;
    esac
  done
  local IFS=,
  echo "${out[*]}"
}

# required_results <expected reason> <scenario ids>: `[SelfTest] <name>` lines that must PASS.
required_results() {
  local reason="$1" id out=()
  if [[ "$reason" != ok ]]; then
    [[ "$reason" == crash ]] && return 0
    echo "S1_support U_direct_init U_library_not_loaded U_os_native_speak U_ptts_not_mapped"
    return 0
  fi
  out+=(S1_support S2_init)
  for id in ${2//,/ }; do
    case "${id^^}" in
      ALL) out+=(S3_short_speak S4_long_speak S5_stream_clause S5_stream_sentence S6_stop
        S7_voice_switch S9_pause_resume S10_capture S8_init_release S12_peak_memory) ;;
      S3 | S13) out+=(S3_short_speak) ;;
      S4) out+=(S4_long_speak) ;;
      S5) out+=(S5_stream_clause S5_stream_sentence) ;;
      S6) out+=(S6_stop) ;;
      S7) out+=(S7_voice_switch) ;;
      S8) out+=(S8_init_release) ;;
      S9) out+=(S9_pause_resume) ;;
      S10) out+=(S10_capture) ;;
      S11) out+=(S11_background S11_reload) ;;
      S12) out+=(S12_peak_memory) ;;
    esac
  done
  echo "${out[*]}"
}

# build_url <runId> <scenarios> [k=v ...]: the self-test deep link.
build_url() {
  local url="speechexample://selftest/phonon?runId=$1" kv
  [[ -z "$2" ]] || url+="&scenarios=$2"
  shift 2
  for kv in "$@"; do [[ "$kv" == *= ]] || url+="&$kv"; done
  echo "$url"
}

indent() { local l; while IFS= read -r l; do printf '    %s\n' "$l"; done; }

# pid_log <threadtime log> <pid>: that process's lines.
pid_log() { awk -v p="$2" '$3 == p' "$1"; }

# logcat_matches <file>...: §8.4 regex hits (threadtime and brief layouts), "file: line".
logcat_matches() {
  local f
  for f in "$@"; do
    [[ -s "$f" ]] || continue
    grep -E -- "$LOGCAT_REGEX|$LOGCAT_REGEX_TT" "$f" | sed "s|^|$(basename "$f"): |" || true
  done
}

# dropbox_new <before> <after>: entry headers in <after> that are not in <before>.
dropbox_new() {
  local h
  grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]+ data_app_(native_)?crash' "$2" 2>/dev/null |
    while IFS= read -r h; do grep -Fxq -- "$h" "$1" 2>/dev/null || echo "$h"; done || true
}

# selftest_line <log> <name>: the last "[SelfTest] <name> PASS|FAIL ..." line, from "<name>".
selftest_line() {
  grep -E "\[SelfTest\] $2 (PASS|FAIL)( |$)" "$1" | tail -1 | sed 's/.*\[SelfTest\] //' || true
}

# check_results <logcat> <expected reason> <required names> [<selftest.json>] [exempt 0|1]
# prints PASS|FAIL|NOT-RUN lines; returns 1 if any FAIL.
check_results() {
  local log="$1" reason="$2" required="$3" json="${4:-}" exempt="${5:-0}" st=0 name line
  for name in $required; do
    line="$(selftest_line "$log" "$name")"
    if [[ "$line" == "$name PASS"* ]]; then
      echo "PASS $name: ${line#"$name PASS "}"
    elif [[ "$line" == "$name FAIL not-run:"* ]]; then
      echo "NOT-RUN $name: ${line#"$name FAIL not-run: "}"
    elif [[ -n "$line" ]]; then
      echo "FAIL $name: ${line#"$name FAIL "}"; st=1
    else
      echo "FAIL $name: no result logged"; st=1
    fi
  done

  line="$(selftest_line "$log" S1_support)"
  if [[ "$reason" == crash ]]; then
    :
  elif [[ "$reason" == ok ]]; then
    if [[ "$line" == *" supported=true reason=ok "* ]]; then echo "PASS support: ${line#S1_support PASS }"
    else echo "FAIL support: want supported=true reason=ok, got: ${line:-no S1_support line}"; st=1; fi
  else
    if [[ "$line" == *" supported=false reason=$reason "* ]]; then echo "PASS support: ${line#S1_support PASS }"
    else echo "FAIL support: want supported=false reason=$reason, got: ${line:-no S1_support line}"; st=1; fi
  fi

  if [[ "$reason" != crash ]]; then
    line="$(grep -E '\[SelfTest\] SELFTEST_DONE ' "$log" | tail -1 || true)"
    if [[ -n "$line" ]]; then echo "PASS done: ${line#*"[SelfTest] "}"; else echo "FAIL done: no SELFTEST_DONE"; st=1; fi
  fi

  # Thresholds from the self-test's own numbers (supported runs).
  if [[ "$reason" == ok && -n "$json" && -s "$json" ]]; then
    local tag=FAIL
    ((exempt)) && tag=EXEMPT
    threshold() { # <label> <jq expr giving a number or null> <op> <limit>
      local v
      v="$(jq -r "$2 // \"null\"" "$json" 2>/dev/null || echo null)"
      [[ "$v" == null ]] && return 0
      if awk -v v="$v" -v l="$4" -v op="$3" 'BEGIN { exit !((op == "<=") ? (v >= 0 && v <= l) : 0) }'; then
        echo "PASS threshold $1: $v $3 $4"
      else
        echo "$tag threshold $1: $v (limit $3 $4)"
        [[ "$tag" == FAIL ]] && st=1
      fi
      return 0
    }
    local r='.results[] | select(.name == '
    threshold "S3 rtf.median" "[$r\"S3_short_speak\") | .data.rtf.median][0]" "<=" "$TH_RTF"
    threshold "S3 firstAudio.median ms" "[$r\"S3_short_speak\") | .data.firstAudioMs.median][0]" "<=" "$TH_FIRST_AUDIO"
    threshold "S4 maxGapMs" "[$r\"S4_long_speak\") | .data.maxGapMs][0]" "<=" "$TH_GAP"
    threshold "S5 clause maxGapMs" "[$r\"S5_stream_clause\") | .data.maxGapMs][0]" "<=" "$TH_GAP"
    threshold "S5 sentence maxGapMs" "[$r\"S5_stream_sentence\") | .data.maxGapMs][0]" "<=" "$TH_GAP"
    threshold "S6 stop->onStopped ms" "[$r\"S6_stop\") | .data.stopToStoppedMs][0]" "<=" "$TH_STOP"
  fi
  return $st
}

# check_clean <expected reason> <pid log> <crash log> <dropbox-new> <full log>: §8.4.
check_clean() {
  local reason="$1" hits anr
  hits="$(logcat_matches "$2" "$3" "$4")"
  anr="$(grep -F "ANR in $PKG" "$5" 2>/dev/null | head -3 || true)"
  [[ -z "$anr" ]] || hits+=$'\n'"anr: $anr"
  hits="$(sed '/^$/d' <<<"$hits")"
  if [[ "$reason" == crash ]]; then
    if grep -q 'SIGILL' <<<"$hits"; then
      echo "PASS negative-control: SIGILL observed (the HWCAP gate is what prevents it)"
      return 0
    fi
    echo "FAIL negative-control: no SIGILL observed"
    [[ -z "$hits" ]] || indent <<<"$hits" | head -20
    return 1
  fi
  if [[ -z "$hits" ]]; then
    echo "PASS logcat-clean: no §8.4 match in the app's logcat, crash buffer or new dropbox entries"
    return 0
  fi
  echo "FAIL logcat-clean: $(wc -l <<<"$hits") match(es)"
  indent <<<"$hits" | head -20
  return 1
}

# check_maps <expected reason> <maps-check.txt>: libptts_ffi must not be mapped when unsupported.
check_maps() {
  local reason="$1" f="$2" n
  [[ "$reason" == crash ]] && return 0
  # Every reading (run-as and the app's own) must agree for an unsupported run; take the max.
  n="$(sed -n 's/^libptts_ffi_maps=\([0-9][0-9]*\).*/\1/p' "$f" | sort -n | tail -1)"
  if [[ -z "$n" ]]; then echo "FAIL maps: no maps reading (see maps-check.txt)"; return 1; fi
  if [[ "$reason" == ok ]]; then
    # Supported and initialized: the proof must see the library, or its zeros mean nothing.
    if ((n > 0)); then echo "PASS maps: libptts_ffi mapped ($n mapping(s)) after init: the check sees a loaded library"
    else echo "FAIL maps: libptts_ffi not found in the maps of an initialized engine (the check is blind)"; return 1; fi
  elif ((n == 0)); then
    echo "PASS maps: libptts_ffi not mapped (0 lines)"
  else
    echo "FAIL maps: libptts_ffi mapped $n line(s) on an unsupported run"; return 1
  fi
}

# abi_dialog_ok <ui xml>: centre of OK on Android's own DeprecatedAbiDialog (package="android",
# shown to 32-bit apps on 64-bit-first releases), else nothing. Other system dialogs (ANR) never match.
abi_dialog_ok() {
  python3 -I - "$1" <<'EOF'
import re, sys
nodes = re.findall(r"<node [^>]*>", open(sys.argv[1], encoding="utf-8", errors="replace").read())
sysn = [n for n in nodes if ' package="android"' in n]
msg = re.compile(r"isn.{1,6}t compatible with (the latest version of )?Android|(32|64)-bit", re.I)
if any('resource-id="android:id/alertTitle"' in n for n in sysn) and any(
        'resource-id="android:id/message"' in n and msg.search(n) for n in sysn):
    for n in sysn:
        b = re.search(r' bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if 'resource-id="android:id/button1"' in n and b:
            x1, y1, x2, y2 = map(int, b.groups())
            print((x1 + x2) // 2, (y1 + y2) // 2)
            break
EOF
}

# check_ui <expected reason> <ui dir>: no app Alert; Phonon UI only when supported.
check_ui() {
  local reason="$1" dir="$2" f name st=0 alert phonon
  [[ "$reason" == crash ]] && return 0
  shopt -s nullglob
  local files=("$dir"/ui-*.xml)
  shopt -u nullglob
  if ((${#files[@]} == 0)); then echo "NOT-RUN ui: no UI dump captured"; return 0; fi
  for f in "${files[@]}"; do
    name="$(basename "$f" .xml)"
    if [[ -n "$(abi_dialog_ok "$f")" ]]; then echo "NOT-RUN ui $name: system DeprecatedAbiDialog covers the app"; continue; fi
    alert="$(grep -o '<node [^>]*resource-id="android:id/alertTitle"[^>]*' "$f" | grep -o 'text="[^"]*"' | head -1 || true)"
    [[ -n "$alert" ]] || alert="$(grep -q 'resource-id="android:id/alertTitle"' "$f" && echo alertTitle || true)"
    phonon="$(grep -o -i 'text="[^"]*phonon[^"]*"' "$f" | sort -u | tr '\n' ' ' || true)"
    if [[ -n "$alert" ]]; then echo "FAIL ui $name: Alert dialog on screen ($alert)"; st=1; fi
    if [[ "$reason" == ok ]]; then
      if [[ "$name" == ui-demo && -z "$phonon" ]]; then echo "FAIL ui $name: no Phonon UI text"; st=1
      else echo "PASS ui $name: ${phonon:-no Phonon text (not required on this tab)}"; fi
    else
      if [[ -n "$phonon" ]]; then echo "FAIL ui $name: Phonon UI visible: $phonon"; st=1
      else echo "PASS ui $name: no Phonon UI, no Alert"; fi
    fi
  done
  return $st
}

# check_apk_libs <expected reason> <apk>: F1 has no Phonon libs; addon has both.
check_apk_libs() {
  local reason="$1" apk="$2" libs
  [[ -f "$apk" ]] || { echo "NOT-RUN apk-libs: no APK"; return 0; }
  libs="$(unzip -l "$apk" | awk '{print $4}' | grep -E '^lib/.*/(libptts_ffi|librnspeech_phonon)\.so$' | sort | tr '\n' ' ' || true)"
  if [[ "$reason" == not-compiled ]]; then
    if [[ -z "$libs" ]]; then echo "PASS apk-libs: no Phonon libraries in the APK"
    else echo "FAIL apk-libs: Phonon libraries in a core-only APK: $libs"; return 1; fi
  else
    echo "PASS apk-libs: ${libs:-none} (informational)"
  fi
}

# maps_proof <maps> <apk>: "libptts_ffi_maps=<n> method=<...> <detail>". An uncompressed lib is
# mmapped from base.apk, so count base.apk mappings whose offset lies inside
# lib/<abi>/libptts_ffi.so's stored data, plus any mapping named libptts_ffi (extracted install).
maps_proof() {
  python3 -I - "$1" "$2" <<'EOF'
import re, struct, sys, zipfile
maps_path, apk = sys.argv[1], sys.argv[2]
ranges = []
try:
    with zipfile.ZipFile(apk) as z, open(apk, "rb") as f:
        for info in z.infolist():
            if re.fullmatch(r"lib/[^/]+/libptts_ffi\.so", info.filename):
                f.seek(info.header_offset)
                h = f.read(30)
                n, e = struct.unpack("<HH", h[26:30])
                start = info.header_offset + 30 + n + e
                ranges.append((info.filename.split("/")[1], start, start + info.compress_size, info.compress_type))
except (OSError, zipfile.BadZipFile) as err:
    print(f"libptts_ffi_maps=? method=none apk unreadable: {err}")
    sys.exit(0)
by_name = by_offset = 0
for line in open(maps_path, encoding="utf-8", errors="replace"):
    parts = line.split()
    if len(parts) < 6:
        continue
    path = parts[5]
    if "libptts_ffi" in path:
        by_name += 1
    elif path.endswith(".apk"):
        off = int(parts[2], 16)
        if any(s <= off < e for _, s, e, _ in ranges):
            by_offset += 1
desc = ",".join(f"{abi}:[{s:#x},{e:#x}){'' if t == 0 else ' COMPRESSED'}" for abi, s, e, t in ranges) or "none (not in the APK)"
method = "apk-offset+name" if ranges else "name"
print(f"libptts_ffi_maps={by_name + by_offset} method={method} by_name={by_name} by_apk_offset={by_offset} ranges={desc}")
EOF
}

# summarize_status <check.txt>: overall PASS / FAIL / NOT-RUN.
summarize_status() {
  if grep -q '^FAIL ' "$1"; then echo FAIL
  elif grep -q '^NOT-RUN ' "$1"; then echo NOT-RUN
  else echo PASS; fi
}

# install_reason <install log>: the adb install failure reason (INSTALL_* code, or the adb
# client's "ABI <abi> not supported on this device"), else the log's last line.
install_reason() {
  grep -o -E 'INSTALL_[A-Z_]*[^]]*|ABI [^ ]+ not supported on this device' "$1" | head -1 || tail -1 "$1"
}

# ui_tap_center <ui.xml> <text regex>: "x y" of the first node whose text matches.
ui_tap_center() {
  python3 -I - "$1" "$2" <<'EOF'
import re, sys
xml = open(sys.argv[1], encoding="utf-8", errors="replace").read()
for node in re.findall(r"<node [^>]*>", xml):
    t = re.search(r' text="([^"]*)"', node)
    b = re.search(r' bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
    if t and b and re.fullmatch(sys.argv[2], t.group(1), re.I):
        x1, y1, x2, y2 = map(int, b.groups())
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
EOF
}

# --selftest: the checks above on fixtures (no phone).
selftest() {
  local d st=0
  d="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$d'" RETURN
  t() { # <want pass|fail> <what> <cmd...>
    local want="$1" what="$2" rc=0 out
    shift 2
    out="$("$@" 2>&1)" || rc=$?
    if { [[ "$want" == pass ]] && ((rc == 0)); } || { [[ "$want" == fail ]] && ((rc != 0)); }; then
      echo "selftest ok: $what"
    else
      echo "selftest FAILED: $what (exit $rc)"; indent <<<"$out"; st=1
    fi
  }
  eq() { # <what> <got> <want>
    if [[ "$2" == "$3" ]]; then echo "selftest ok: $1"; else echo "selftest FAILED: $1: got '$2', want '$3'"; st=1; fi
  }

  eq "addon expects ok" "$(expected_reason addon ALL)" ok
  eq "U1 on addon expects missing-cpu-features" "$(expected_reason addon U1)" missing-cpu-features
  eq "core expects not-compiled" "$(expected_reason core F1)" not-compiled
  eq "32-bit expects unsupported-abi" "$(expected_reason addon-32bit U2)" unsupported-abi
  eq "forced reason" "$(expected_reason forced-symbols-missing U3)" symbols-missing
  eq "negative control" "$(expected_reason negative-control ALL)" crash
  eq "deep-link scenarios" "$(deep_link_scenarios S1,s3,S6,S11,S12)" "s1,s3,s6,s11,s12"
  eq "ALL / U* / S13 add no scenarios" "$(deep_link_scenarios ALL,U1,F1,S13)" ""
  t fail "unknown scenario rejected" deep_link_scenarios S99
  eq "required S5" "$(required_results ok S5)" "S1_support S2_init S5_stream_clause S5_stream_sentence"
  eq "required unsupported" "$(required_results not-compiled F1)" \
    "S1_support U_direct_init U_library_not_loaded U_os_native_speak U_ptts_not_mapped"
  eq "url" "$(build_url r1 s3 runs=5 threads= spin=200)" \
    "speechexample://selftest/phonon?runId=r1&scenarios=s3&runs=5&spin=200"

  local tt='10-21 10:00:00.000  4242  4260 I ReactNativeJS:'
  cat >"$d/ok.txt" <<EOF
$tt [SelfTest] START phonon runId=r1 dir=/data/user/0/speech.example/files/phonon-evidence/r1
$tt [SelfTest] S1_support PASS supported=true reason=ok abi=arm64-v8a pageSize=4096
$tt [SelfTest] S2_init PASS initMs=900 loadMs=300 compiled=false threads=4 unit=cpu voices=9 default="default"
$tt [SelfTest] S3_short_speak PASS runs=5 firstAudio.median=420 p90=500 rtf.median=0.2
$tt [SelfTest] S11_background PASS backgroundMs=3100 speak=resolved chunks=4 next=true
$tt [SelfTest] S11_reload FAIL not-run: DevSettings.reload() did not reload within 8000 ms (release builds have no reload; run s11 on a debug flavor)
$tt [SelfTest] MAPS libptts_ffi=6 librnspeech_phonon=5
$tt [SelfTest] SELFTEST_DONE passed=4 failed=1 dir=/x external=/storage/emulated/0/Android/data/speech.example/files/phonon-evidence/r1
10-21 10:00:00.000  999  999 E AndroidRuntime: FATAL EXCEPTION: main
EOF
  t pass "supported run passes" check_results "$d/ok.txt" ok "S1_support S2_init S3_short_speak"
  eq "release reload is NOT-RUN, not FAIL" \
    "$(check_results "$d/ok.txt" ok "S11_reload" | head -1 | cut -d' ' -f1)" NOT-RUN
  t fail "missing result fails" check_results "$d/ok.txt" ok "S1_support S6_stop"
  t fail "supported run checked as unsupported fails" check_results "$d/ok.txt" not-compiled "S1_support"
  sed 's/supported=true reason=ok/supported=false reason=symbols-missing/' "$d/ok.txt" >"$d/u3.txt"
  t pass "forced reason matches" check_results "$d/u3.txt" symbols-missing "S1_support"
  t fail "forced reason mismatch" check_results "$d/u3.txt" low-memory "S1_support"
  grep -v SELFTEST_DONE "$d/ok.txt" >"$d/nodone.txt"
  t fail "no SELFTEST_DONE fails" check_results "$d/nodone.txt" ok "S1_support"

  jq -n '{results: [
    {name: "S3_short_speak", data: {rtf: {median: 0.21}, firstAudioMs: {median: 640}}},
    {name: "S6_stop", data: {stopToStoppedMs: 40}},
    {name: "S4_long_speak", data: {maxGapMs: 90}}]}' >"$d/good.json"
  jq '.results[1].data.stopToStoppedMs = 210' "$d/good.json" >"$d/slow.json"
  jq '.results[1].data.stopToStoppedMs = -1' "$d/good.json" >"$d/nostop.json"
  t pass "thresholds within limits" check_results "$d/ok.txt" ok "S1_support" "$d/good.json"
  t fail "S6 over 150 ms fails" check_results "$d/ok.txt" ok "S1_support" "$d/slow.json"
  t fail "S6 without onStopped fails" check_results "$d/ok.txt" ok "S1_support" "$d/nostop.json"
  t pass "emulator thresholds exempt" check_results "$d/ok.txt" ok "S1_support" "$d/slow.json" 1

  pid_log "$d/ok.txt" 4242 >"$d/pid.txt"
  : >"$d/empty.txt"
  t pass "other process's FATAL EXCEPTION is filtered by pid" \
    check_clean ok "$d/pid.txt" "$d/empty.txt" "$d/empty.txt" "$d/ok.txt"
  { cat "$d/pid.txt"; echo "10-21 10:00:01.000  4242  4290 F libc    : Fatal signal 4 (SIGILL), code 1 (ILL_ILLOPC) in tid 4290 (phonon-synth), pid 4242 (speech.example)"; } >"$d/sigill.txt"
  t fail "SIGILL is not clean" check_clean ok "$d/sigill.txt" "$d/empty.txt" "$d/empty.txt" "$d/ok.txt"
  t pass "negative control wants the SIGILL" check_clean crash "$d/sigill.txt" "$d/empty.txt" "$d/empty.txt" "$d/ok.txt"
  t fail "negative control without SIGILL fails" check_clean crash "$d/pid.txt" "$d/empty.txt" "$d/empty.txt" "$d/ok.txt"
  echo "10-21 10:00:01.000  4242  4260 E ReactNativeJS: boom" >"$d/jserr.txt"
  t fail "E ReactNativeJS is not clean" check_clean ok "$d/jserr.txt" "$d/empty.txt" "$d/empty.txt" "$d/ok.txt"
  echo "10-21 10:00:01.000  4242  4260 E RNSpeech: x" >"$d/rnerr.txt"
  t fail "E RNSpeech (threadtime) is not clean" check_clean ok "$d/rnerr.txt" "$d/empty.txt" "$d/empty.txt" "$d/ok.txt"
  echo "10-21 10:00:01.000  4242  4260 I Phonon  : unsupported: missing-cpu-features (missing asimddp)" >"$d/info.txt"
  t pass "I/Phonon unsupported is info-level" check_clean missing-cpu-features "$d/info.txt" "$d/empty.txt" "$d/empty.txt" "$d/ok.txt"
  echo "10-21 10:00:01.000  1500  1530 E ActivityManager: ANR in speech.example (speech.example/.MainActivity)" >"$d/anr.txt"
  t fail "ANR in the full log is not clean" check_clean ok "$d/pid.txt" "$d/empty.txt" "$d/empty.txt" "$d/anr.txt"

  printf '%s\n' "========================================" "2026-10-20 09:00:00 data_app_native_crash (text, 100 bytes)" >"$d/db-before.txt"
  { cat "$d/db-before.txt"; echo "2026-10-21 10:00:02 data_app_native_crash (text, 4000 bytes)"; } >"$d/db-after.txt"
  eq "dropbox: only the new entry" "$(dropbox_new "$d/db-before.txt" "$d/db-after.txt")" \
    "2026-10-21 10:00:02 data_app_native_crash (text, 4000 bytes)"
  eq "dropbox: nothing new" "$(dropbox_new "$d/db-before.txt" "$d/db-before.txt")" ""

  echo "libptts_ffi_maps=0 source=app" >"$d/maps0.txt"
  echo "libptts_ffi_maps=3 source=run-as" >"$d/maps3.txt"
  t pass "unsupported: not mapped" check_maps missing-cpu-features "$d/maps0.txt"
  t fail "unsupported: mapped" check_maps not-compiled "$d/maps3.txt"
  t pass "supported: mapped after init" check_maps ok "$d/maps3.txt"
  t fail "supported: not mapped after init means a blind check" check_maps ok "$d/maps0.txt"
  t fail "no maps reading" check_maps ok "$d/empty.txt"

  mkdir -p "$d/ui"
  echo '<hierarchy><node text="PHONON" bounds="[0,0][10,10]" /><node text="Kitten" bounds="[0,0][1,1]"/></hierarchy>' >"$d/ui/ui-demo.xml"
  t pass "supported demo shows Phonon" check_ui ok "$d/ui"
  t fail "unsupported demo must not show Phonon" check_ui not-compiled "$d/ui"
  echo '<hierarchy><node text="Kitten Model Required" resource-id="android:id/alertTitle" bounds="[0,0][9,9]"/><node text="Later" bounds="[100,200][300,260]"/></hierarchy>' >"$d/ui/ui-demo.xml"
  t fail "an Alert fails" check_ui not-compiled "$d/ui"
  eq "tap center of Later" "$(ui_tap_center "$d/ui/ui-demo.xml" 'later')" "200 230"

  # Android's DeprecatedAbiDialog (s23, U2): every node package="android"; tap OK, not an app Alert.
  local abi='<hierarchy><node text="SpeechExample" resource-id="android:id/alertTitle" package="android" bounds="[102,1680][978,1750]"/><node text="This app isn'"'"'t compatible with the latest version of Android. Check for an update or contact the app'"'"'s developer." resource-id="android:id/message" package="android" bounds="[102,1786][978,1980]"/><node text="OK" resource-id="android:id/button1" package="android" bounds="[102,2004][978,2112]"/></hierarchy>'
  mkdir -p "$d/abi"
  echo "$abi" >"$d/abi/ui-demo.xml"
  eq "DeprecatedAbiDialog: tap OK" "$(abi_dialog_ok "$d/abi/ui-demo.xml")" "540 2058"
  t pass "DeprecatedAbiDialog is not an app Alert" check_ui unsupported-abi "$d/abi"
  eq "DeprecatedAbiDialog: the hidden screen is NOT-RUN" "$(check_ui unsupported-abi "$d/abi" | cut -d' ' -f1)" NOT-RUN
  echo '<hierarchy><node text="SpeechExample isn'"'"'t responding" resource-id="android:id/alertTitle" package="android" bounds="[0,0][9,9]"/><node text="Close app" resource-id="android:id/aerr_close" package="android" bounds="[0,10][9,19]"/></hierarchy>' >"$d/abi/ui-demo.xml"
  eq "ANR dialog is not dismissed" "$(abi_dialog_ok "$d/abi/ui-demo.xml")" ""
  t fail "ANR dialog still fails" check_ui unsupported-abi "$d/abi"

  # maps_proof on a synthetic APK: one stored lib/arm64-v8a/libptts_ffi.so.
  python3 -I - "$d/m.apk" <<'EOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_STORED) as z:
    z.writestr("AndroidManifest.xml", b"x" * 100)
    z.writestr("lib/arm64-v8a/libptts_ffi.so", b"\x7fELF" + b"\0" * 0x8000)
EOF
  local lo
  lo="$(python3 -I -c 'import sys, zipfile, struct
z = zipfile.ZipFile(sys.argv[1]); i = z.getinfo("lib/arm64-v8a/libptts_ffi.so")
f = open(sys.argv[1], "rb"); f.seek(i.header_offset); h = f.read(30)
print(hex(i.header_offset + 30 + sum(struct.unpack("<HH", h[26:30]))))' "$d/m.apk")"
  printf '%s\n' "7000-8000 r--p ${lo#0x} fd:01 7 /data/app/~~x/speech.example-y/base.apk" \
    "7f00-7f10 r-xp 0 fd:01 7 /data/app/~~x/speech.example-y/base.apk" >"$d/maps-apk.txt"
  printf '%s\n' "7f00-7f10 r-xp 0 fd:01 7 /data/app/~~x/speech.example-y/base.apk" >"$d/maps-none.txt"
  printf '%s\n' "7000-8000 r-xp 0 fd:01 9 /data/app/x/lib/arm64/libptts_ffi.so" >"$d/maps-named.txt"
  eq "maps: base.apk mapping at the library's offset counts" \
    "$(maps_proof "$d/maps-apk.txt" "$d/m.apk" | cut -d' ' -f1)" libptts_ffi_maps=1
  eq "maps: other base.apk mappings do not" "$(maps_proof "$d/maps-none.txt" "$d/m.apk" | cut -d' ' -f1)" libptts_ffi_maps=0
  eq "maps: an extracted library counts by name" "$(maps_proof "$d/maps-named.txt" "$d/m.apk" | cut -d' ' -f1)" libptts_ffi_maps=1
  : >"$d/empty.apk"
  eq "maps: no APK library, name only" "$(maps_proof "$d/maps-none.txt" "$d/fake-noexist.apk" | cut -d' ' -f1)" "libptts_ffi_maps=?"

  # HyperOS "Install via USB?" prompt (com.miui.securitycenter): tap Install, not Deny.
  echo '<hierarchy><node text="Install this app via USB?" package="com.miui.securitycenter" bounds="[0,0][9,9]"/><node text="Install" package="com.miui.securitycenter" bounds="[100,2300][588,2454]"/><node text="Deny (5)" bounds="[600,2300][1000,2454]"/></hierarchy>' >"$d/inst.xml"
  eq "install prompt: Install button" "$(ui_tap_center "$d/inst.xml" '(install|continue installation)')" "344 2377"

  # Play Protect "Send app for a security check?" (com.android.vending): tap Don't send.
  echo '<hierarchy><node text="Send app for a security check?" package="com.android.vending" bounds="[0,0][9,9]"/><node text="Google Play Protect" package="com.android.vending" bounds="[0,10][9,19]"/><node text="Always send" package="com.android.vending" bounds="[0,20][9,29]"/><node text="Send" package="com.android.vending" bounds="[100,2000][300,2100]"/><node text="Don'"'"'t send" package="com.android.vending" bounds="[400,2000][700,2100]"/></hierarchy>' >"$d/pp.xml"
  eq "Play Protect prompt: Don't send" "$(ui_tap_center "$d/pp.xml" "don(.|&apos;)t send")" "550 2050"

  printf 'Performing Streamed Install\nadb: failed to install x.apk: Failure [INSTALL_FAILED_NO_MATCHING_ABIS: no native libs]\n' >"$d/inst1.txt"
  eq "install reason: INSTALL_ code" "$(install_reason "$d/inst1.txt")" "INSTALL_FAILED_NO_MATCHING_ABIS: no native libs"
  printf 'java.lang.IllegalArgumentException: ABI armeabi-v7a not supported on this device\n\tat x\n' >"$d/inst2.txt"
  eq "install reason: adb ABI check" "$(install_reason "$d/inst2.txt")" "ABI armeabi-v7a not supported on this device"
  printf 'adb: device offline\n' >"$d/inst3.txt"
  eq "install reason: last line" "$(install_reason "$d/inst3.txt")" "adb: device offline"

  printf 'PASS a: x\nNOT-RUN b: y\n' >"$d/c1.txt"; eq "status NOT-RUN" "$(summarize_status "$d/c1.txt")" NOT-RUN
  printf 'PASS a: x\nFAIL b: y\n' >"$d/c2.txt"; eq "status FAIL" "$(summarize_status "$d/c2.txt")" FAIL
  printf 'PASS a: x\n' >"$d/c3.txt"; eq "status PASS" "$(summarize_status "$d/c3.txt")" PASS

  # The whole flow in --dry-run (no adb is ever run).
  : >"$d/fake.apk"
  t pass "dry run S1" "$0" SERIAL0 slug addon --apk "$d/fake.apk" --scenario S1 --out "$d/out" --dry-run
  t pass "dry run S13 sweep" "$0" SERIAL0 slug addon --apk "$d/fake.apk" --scenario S13 \
    --threads-list 2,4 --spin-list default,200 --out "$d/out13" --dry-run
  t pass "dry run U3" "$0" SERIAL0 slug forced-low-memory --apk "$d/fake.apk" --out "$d/outu3" --dry-run
  t fail "bad scenario is a usage error" "$0" SERIAL0 slug addon --apk "$d/fake.apk" --scenario S99 --dry-run
  return $st
}

exec 3>&2 # the dry-run trace survives the callers' redirections
A() { # adb for this serial; --dry-run prints instead
  if ((DRY)); then echo "+ adb -s $SERIAL $*" >&3; return 0; fi
  adb -s "$SERIAL" "$@"
}
sh1() { A shell "$@" | tr -d '\r'; } # one-line shell output
log() { echo "[collect $(date -u +%H:%M:%S)] $*" >&2; }

LIVE_PID=""
STAYON_PREV=""
cleanup() {
  [[ -z "$LIVE_PID" ]] || kill "$LIVE_PID" 2>/dev/null || true
  LIVE_PID=""
  if ((!DRY)) && [[ -n "$SERIAL" ]] && adb -s "$SERIAL" get-state >/dev/null 2>&1; then
    A shell rm -f /data/local/tmp/wp9-ui.xml >/dev/null 2>&1 || true
    if [[ -n "$STAYON_PREV" ]]; then
      A shell settings put global stay_on_while_plugged_in "$STAYON_PREV" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

device_json() { # <out file>
  local f="$1" features
  if ((DRY)); then A shell getprop; A shell getconf PAGE_SIZE; A shell cat /proc/cpuinfo; echo '{}' >"$f"; return; fi
  features="$(A shell cat /proc/cpuinfo | tr -d '\r' | sed -n 's/^Features[[:space:]]*:[[:space:]]*//p' | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/ $//')"
  p() { sh1 getprop "$1"; }
  jq -n \
    --arg serial "$SERIAL" --arg slug "$SLUG" --arg flavor "$FLAVOR" \
    --arg model "$(p ro.product.model)" --arg manufacturer "$(p ro.product.manufacturer)" \
    --arg brand "$(p ro.product.brand)" --arg device "$(p ro.product.device)" \
    --arg socManufacturer "$(p ro.soc.manufacturer)" --arg socModel "$(p ro.soc.model)" \
    --arg board "$(p ro.board.platform)" --arg hardware "$(p ro.hardware)" \
    --arg release "$(p ro.build.version.release)" --arg sdk "$(p ro.build.version.sdk)" \
    --arg fingerprint "$(p ro.build.fingerprint)" --arg abilist "$(p ro.product.cpu.abilist)" \
    --arg abilist32 "$(p ro.product.cpu.abilist32)" --arg abilist64 "$(p ro.product.cpu.abilist64)" \
    --arg nativeBridge "$(p ro.dalvik.vm.native.bridge)" --arg qemu "$(p ro.kernel.qemu)" \
    --arg pageSize "$(sh1 getconf PAGE_SIZE)" --arg clkTck "$(sh1 getconf CLK_TCK)" \
    --arg memTotal "$(sh1 cat /proc/meminfo | sed -n 's/^MemTotal:[[:space:]]*//p')" \
    --arg cpuFeatures "$features" \
    --arg commit "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)" \
    --arg dirty "$(git -C "$ROOT" status --porcelain 2>/dev/null | grep -qv '^??' && echo true || echo false)" \
    --arg apk "$(basename "${APK:-}")" --arg apkSha256 "${APK_SHA:-}" \
    --arg collectedAt "$(date -u +%FT%TZ)" \
    '{serial: $serial, slug: $slug, flavor: $flavor, model: $model, manufacturer: $manufacturer,
      brand: $brand, device: $device, soc: {manufacturer: $socManufacturer, model: $socModel,
      board: $board, hardware: $hardware}, release: $release, sdk: $sdk, fingerprint: $fingerprint,
      abilist: $abilist, abilist32: $abilist32, abilist64: $abilist64, nativeBridge: $nativeBridge,
      emulator: ($qemu == "1"), pageSize: ($pageSize | tonumber? // $pageSize),
      clkTck: ($clkTck | tonumber? // $clkTck), memTotal: $memTotal,
      cpuFeatures: ($cpuFeatures | split(" ")), commit: $commit, worktreeDirty: ($dirty == "true"),
      apk: $apk, apkSha256: $apkSha256, collectedAt: $collectedAt}' >"$f"
}

ui_dump() { # <out xml>
  ((DRY)) && { A shell uiautomator dump /data/local/tmp/wp9-ui.xml; return 0; }
  rm -f "$1" # never act on a stale dump
  if A shell uiautomator dump /data/local/tmp/wp9-ui.xml >/dev/null 2>&1; then
    A exec-out cat /data/local/tmp/wp9-ui.xml >"$1" 2>/dev/null || true
    A shell rm -f /data/local/tmp/wp9-ui.xml >/dev/null 2>&1 || true
  fi
  [[ -s "$1" ]]
}

# dismiss_abi_dialog <ui xml>: tap OK on the system DeprecatedAbiDialog if it is in the dump.
dismiss_abi_dialog() {
  local xy
  xy="$(abi_dialog_ok "$1")"
  [[ -n "$xy" ]] || return 1
  log "dismissing the system DeprecatedAbiDialog (tap $xy)"
  # shellcheck disable=SC2086
  A shell input tap $xy
  sleep 1
}

# A fresh install's "Kitten Model Required" prompt would hide the screen: tap "Later".
dismiss_kitten_prompt() {
  local xml="$TMP/ui-start.xml" xy
  ((DRY)) && return 0
  for _ in 1 2 3 4 5; do
    ui_dump "$xml" || { sleep 2; continue; }
    dismiss_abi_dialog "$xml" && continue
    if grep -q 'Kitten Model Required' "$xml"; then
      xy="$(ui_tap_center "$xml" 'later')"
      if [[ -n "$xy" ]]; then
        log "dismissing the Kitten model prompt (tap $xy)"
        # shellcheck disable=SC2086
        A shell input tap $xy
        sleep 1
        return 0
      fi
    fi
    sleep 2
  done
}

# install_apk <log> <adb install args...>: adb install, tapping Install on an OEM "Install via
# USB?" prompt (HyperOS) without ticking "Remember my choice".
install_apk() {
  local logf="$1" ipid xml="$TMP/ui-install.xml" xy rc=0
  shift
  if ((DRY)); then A "$@"; return 0; fi
  A shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  A shell wm dismiss-keyguard >/dev/null 2>&1 || true
  A "$@" >"$logf" 2>&1 &
  ipid=$!
  local deadline=$((SECONDS + 300))
  while kill -0 "$ipid" 2>/dev/null && ((SECONDS < deadline)); do
    sleep 2
    kill -0 "$ipid" 2>/dev/null || break
    if ui_dump "$xml" && grep -Eq 'package="(com\.miui\.securitycenter|com\.(google\.)?android\.packageinstaller)"' "$xml" &&
      grep -Eqi 'text="[^"]*(via USB|install)[^"]*\?"' "$xml"; then
      xy="$(ui_tap_center "$xml" '(install|continue installation)')"
      if [[ -n "$xy" ]]; then
        log "confirming the install prompt (tap $xy)"
        # shellcheck disable=SC2086
        A shell input tap $xy
        sleep 3
      fi
    elif grep -q 'package="com.android.vending"' "$xml" && grep -q 'Play Protect' "$xml"; then
      # Play Protect "Send app for a security check?": "Don't send", "Always send" unticked.
      xy="$(ui_tap_center "$xml" "don(.|&apos;)t send")"
      if [[ -n "$xy" ]]; then
        log "dismissing the Play Protect scan prompt (tap $xy)"
        # shellcheck disable=SC2086
        A shell input tap $xy
        sleep 3
      fi
    fi
  done
  wait "$ipid" || rc=$?
  return $rc
}

app_pid() { ((DRY)) && { echo 0; return; }; { sh1 pidof "$PKG" || true; } | awk '{print $1}'; } # pidof exits 1 once the app is gone (N1)
debuggable() { ((DRY)) && return 1; A shell run-as "$PKG" true >/dev/null 2>&1; }

push_model() { # <host dir> -> prints the device folder
  local src="$1" dest="/sdcard/Android/data/$PKG/files/phonon-push/31m-en" want have
  want="$(cd "$src" && find . -type f | sort | xargs -I{} stat -c '%s {}' {} | md5sum | cut -c1-12)"
  have="$( ((DRY)) || A shell "cd $dest 2>/dev/null && find . -type f | sort | xargs -I{} stat -c '%s {}' {}" 2>/dev/null | tr -d '\r' | md5sum | cut -c1-12)"
  if [[ "$want" == "$have" ]]; then
    log "model already pushed to $dest"
  else
    log "pushing model $src -> $dest"
    A shell mkdir -p "$dest" >/dev/null
    A push "$src/." "$dest/" >&2
  fi
  echo "$dest"
}

# run_once <runId> <url> <out dir>: one self-test process, evidence into <out dir>.
run_once() {
  local run_id="$1" url="$2" out="$3" pid line name deadline done_line="" dead=0
  mkdir -p "$out/screenshots" "$out/ui"
  log "run $run_id -> $out"
  log "deep link: $url"
  echo "$url" >"$out/url.txt"

  A logcat -c >/dev/null 2>&1 || true
  A logcat -b crash -c >/dev/null 2>&1 || true
  A shell dumpsys dropbox data_app_native_crash >"$TMP/db-before.txt" 2>/dev/null || true
  A shell dumpsys dropbox data_app_crash >>"$TMP/db-before.txt" 2>/dev/null || true

  # Fresh process, launcher first: meminfo-before is the idle app, then the deep link.
  A shell am force-stop "$PKG"
  A shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  A shell wm dismiss-keyguard >/dev/null 2>&1 || true
  : >"$TMP/live.txt"
  if ((!DRY)); then
    adb -s "$SERIAL" logcat -v threadtime -b main,system,crash >"$TMP/live.txt" 2>/dev/null &
    LIVE_PID=$!
  fi
  A shell am start -W -n "$ACTIVITY" >"$out/am-start.txt" 2>&1 || true
  ((DRY)) || sleep 4
  dismiss_kitten_prompt
  if [[ -n "${MODEL_DIR_HOST:-}" && -z "${MODEL_DEVICE:-}" ]]; then
    MODEL_DEVICE="$(push_model "$MODEL_DIR_HOST")"
    url+="&modelFrom=$MODEL_DEVICE"
    echo "$url" >"$out/url.txt"
  fi
  pid="$(app_pid)"
  A shell dumpsys meminfo "$PKG" >"$out/meminfo-before.txt" 2>&1 || true

  A shell "am start -W -a android.intent.action.VIEW -d '$url' $PKG" >>"$out/am-start.txt" 2>&1 || true
  if ((DRY)); then
    log "dry run: would wait for SELFTEST_DONE (timeout ${TIMEOUT}s), screencap at SCREENSHOT_READY"
    A exec-out screencap -p
    A shell run-as "$PKG" cat "/proc/<pid>/maps"
    A pull "/sdcard/Android/data/$PKG/files/phonon-evidence/$run_id"
    return 0
  fi

  deadline=$((SECONDS + TIMEOUT))
  exec {fd}< <(tail -n +1 -F "$TMP/live.txt" 2>/dev/null)
  while ((SECONDS < deadline)); do
    if ! IFS= read -r -t 5 -u "$fd" line; then
      if [[ -z "$(app_pid)" ]]; then
        sleep 3
        if [[ -z "$(app_pid)" ]]; then dead=1; log "app process is gone"; break; fi
      fi
      continue
    fi
    [[ "$line" == *"[SelfTest]"* ]] || continue
    echo "${line#*"[SelfTest] "}" >>"$out/selftest-lines.txt"
    case "$line" in
      *"SCREENSHOT_READY name="*)
        name="$(sed -n 's/.*SCREENSHOT_READY name=\([a-z]*\).*/\1/p' <<<"$line")"
        if ui_dump "$out/ui/ui-$name.xml" && dismiss_abi_dialog "$out/ui/ui-$name.xml"; then
          ui_dump "$out/ui/ui-$name.xml" || true
        fi
        A exec-out screencap -p >"$out/screenshots/$name.png" 2>/dev/null || true
        log "screenshot $name"
        ;;
      *"S11_BACKGROUND_REQUEST"*)
        log "S11: HOME, wait 3 s, bring the app back"
        A shell input keyevent KEYCODE_HOME
        sleep 3
        A shell "am start -a android.intent.action.VIEW -d '$url' $PKG" >/dev/null 2>&1 || true
        ;;
      *"S11_RELOAD_REQUEST"*) log "S11: reload requested (pid $pid)" ;;
      *"SELFTEST_DONE"*) done_line="$line"; break ;;
    esac
  done
  exec {fd}<&-
  [[ -n "$done_line" ]] || ((dead)) || log "no SELFTEST_DONE within ${TIMEOUT}s"
  sleep 2

  # Process maps + memory while the app is still up.
  local now_pid
  now_pid="$(app_pid)"
  if [[ -n "$now_pid" ]] && debuggable; then
    A shell run-as "$PKG" cat "/proc/$now_pid/maps" 2>/dev/null | tr -d '\r' >"$out/maps-runas.txt" || true
  fi
  A shell dumpsys meminfo "$PKG" >"$out/meminfo-after.txt" 2>&1 || true

  kill "$LIVE_PID" 2>/dev/null || true
  LIVE_PID=""
  A logcat -d -b crash -v threadtime >"$out/logcat-crash.txt" 2>/dev/null || true
  A shell dumpsys dropbox data_app_native_crash >"$TMP/db-after.txt" 2>/dev/null || true
  A shell dumpsys dropbox data_app_crash >>"$TMP/db-after.txt" 2>/dev/null || true
  dropbox_new "$TMP/db-before.txt" "$TMP/db-after.txt" >"$out/dropbox-new.txt"
  if [[ -s "$out/dropbox-new.txt" ]]; then
    A shell dumpsys dropbox --print data_app_native_crash >"$out/dropbox-native-crash.txt" 2>/dev/null || true
    # The new entries' text is what the regex checks.
    cat "$out/dropbox-native-crash.txt" >>"$out/dropbox-new.txt"
  fi
  pid_log "$TMP/live.txt" "$pid" >"$out/logcat.txt"
  if [[ -n "$now_pid" && "$now_pid" != "$pid" ]]; then pid_log "$TMP/live.txt" "$now_pid" >>"$out/logcat.txt"; fi
  gzip -c "$TMP/live.txt" >"$out/logcat-full.txt.gz"

  local ext
  ext="$(sed -n 's/.* external=\(.*\)$/\1/p' <<<"$done_line")"
  mkdir -p "$out/phonon-evidence"
  if A shell ls "/sdcard/Android/data/$PKG/files/phonon-evidence/$run_id" >/dev/null 2>&1; then
    A pull "/sdcard/Android/data/$PKG/files/phonon-evidence/$run_id" "$out/phonon-evidence/" >/dev/null 2>&1 || true
  elif debuggable; then
    A exec-out run-as "$PKG" tar -C files/phonon-evidence -cf - "$run_id" 2>/dev/null | tar -x -C "$out/phonon-evidence" 2>/dev/null || true
  fi
  [[ -n "$ext" ]] || ext="(none)"
  local ev="$out/phonon-evidence/$run_id"

  # maps-check.txt: run-as maps when debuggable, else the app's own maps.txt (U1 process proof).
  local apk_ref="${APK:-}"
  if [[ ! -f "$apk_ref" ]]; then
    apk_ref="$TMP/installed.apk"
    A pull "$(sh1 pm path "$PKG" | sed -n 's/^package://p' | head -1)" "$apk_ref" >/dev/null 2>&1 || true
  fi
  {
    if [[ -s "$out/maps-runas.txt" ]]; then
      echo "$(maps_proof "$out/maps-runas.txt" "$apk_ref") source=run-as pid=$now_pid"
    fi
    if [[ -s "$ev/maps.txt" ]]; then
      echo "$(maps_proof "$ev/maps.txt" "$apk_ref") source=app(/proc/self/maps at SELFTEST_DONE)"
    fi
    [[ -s "$out/maps-runas.txt" || -s "$ev/maps.txt" ]] ||
      echo "no maps reading (pid=${now_pid:-none}, process gone or /proc unreadable)"
    grep -F '[SelfTest] MAPS' "$TMP/live.txt" | tail -1 | sed 's/.*\[SelfTest\] /app-log: /' || true
    echo "pid_at_launch=$pid pid_at_end=${now_pid:-none} external=$ext"
  } >"$out/maps-check.txt"
  for f in selftest.json bench.jsonl sample.wav maps.txt; do [[ -f "$ev/$f" ]] && cp "$ev/$f" "$out/$f"; done
  if [[ -f "$out/selftest.json" ]]; then
    jq '{runId, platform, osVersion, device, support, load, maps, passed, failed,
         results: (.results | map({key: .name, value: {pass, detail, data}}) | from_entries)}' \
      "$out/selftest.json" >"$out/metrics.json" 2>/dev/null || true
  fi
  return 0
}

# checks <out dir> <expected reason> <required names>: check.txt, returns 1 on FAIL.
checks() {
  local out="$1" reason="$2" required="$3" exempt=$EMULATOR
  [[ "$(jq -r '.emulator // false' "$OUTROOT/device.json" 2>/dev/null)" == true ]] && exempt=1
  {
    echo "# $(date -u +%FT%TZ) serial=$SERIAL slug=$SLUG flavor=$FLAVOR scenario=$SCENARIO expect=$reason"
    echo "# apk=$(basename "${APK:-installed}") sha256=${APK_SHA:-} commit=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"
    check_results "$out/logcat.txt" "$reason" "$required" "$out/selftest.json" "$exempt" || true
    check_clean "$reason" "$out/logcat.txt" "$out/logcat-crash.txt" "$out/dropbox-new.txt" <(gzip -dc "$out/logcat-full.txt.gz") || true
    check_maps "$reason" "$out/maps-check.txt" || true
    check_ui "$reason" "$out/ui" || true
    check_apk_libs "$reason" "${APK:-}" || true
  } >"$out/check.txt"
  # logcat-check.txt (§8.5): the §8.4 part alone.
  {
    echo "# §8.4 regex: $LOGCAT_REGEX (+ threadtime:$LOGCAT_REGEX_TT)"
    echo "# sources: logcat.txt (pid-filtered), logcat-crash.txt, dropbox-new.txt; ANR in the full log"
    grep -E '^(PASS|FAIL) (logcat-clean|negative-control)' "$out/check.txt" || true
    logcat_matches "$out/logcat.txt" "$out/logcat-crash.txt" "$out/dropbox-new.txt"
  } >"$out/logcat-check.txt"
  local status
  status="$(summarize_status "$out/check.txt")"
  echo "RESULT $status" >>"$out/check.txt"
  sed 's/^/  /' "$out/check.txt" >&2
  [[ "$status" != FAIL ]]
}

if [[ "${1:-}" == --selftest ]]; then selftest; exit $?; fi
if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0; fi
if [[ $# -lt 3 ]]; then awk 'NR > 1 { if (!/^#/) exit; print }' "$0" >&2; exit 2; fi
SERIAL="$1" SLUG="$2" FLAVOR="$3"
shift 3
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk) APK="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --scenario | --scenarios) SCENARIO="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --cycles) CYCLES="$2"; shift 2 ;;
    --threads) THREADS="$2"; shift 2 ;;
    --spin) SPIN="$2"; shift 2 ;;
    --threads-list) THREADS_LIST="$2"; shift 2 ;;
    --spin-list) SPIN_LIST="$2"; shift 2 ;;
    --hold) HOLD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --abi) ABI="$2"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --no-install) INSTALL=0; shift ;;
    --keep-app) KEEP_APP=1; shift ;;
    --emulator) EMULATOR=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+$ && "$FLAVOR" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad slug/flavor" >&2; exit 2; }
SCENARIO="${SCENARIO^^}"
DL_SCENARIOS="$(deep_link_scenarios "$SCENARIO")" || exit 2
REASON="$(expected_reason "$FLAVOR" "$SCENARIO")"
REQUIRED="$(required_results "$REASON" "$SCENARIO")"
if ((INSTALL)); then [[ -f "$APK" ]] || { echo "--apk <file> is required" >&2; exit 2; }; fi
for tool in jq unzip gzip python3; do command -v "$tool" >/dev/null || { echo "needs $tool" >&2; exit 2; }; done
((DRY)) || command -v adb >/dev/null || { echo "needs adb" >&2; exit 2; }
APK_SHA="$([[ -f "${APK:-}" ]] && sha256sum "$APK" | cut -d' ' -f1 || true)"

ids_tag="$(tr ',' '-' <<<"$SCENARIO")"
if [[ -z "$OUT" ]]; then
  OUT="$ROOT/docs/evidence/android/$SLUG/$FLAVOR"
  [[ "$SCENARIO" == ALL || "$SCENARIO" =~ ^(U1|U2|U3|F1)$ ]] || OUT+="/scenarios/$ids_tag"
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
OUTROOT="$OUT"
RUN_ID="${RUN_ID:-$FLAVOR-$ids_tag-$(date -u +%Y%m%dT%H%M%S)}"
TMP="$(mktemp -d)"
trap 'cleanup; rm -rf "$TMP"' EXIT

MODEL_DIR_HOST="" MODEL_DEVICE="" model_kv=()
if [[ -z "$MODEL" ]]; then
  if [[ "$REASON" == ok || "$REASON" == crash ]]; then MODEL="${PHONON_MODEL_DIR:-download}"; else MODEL=none; fi
fi
case "$MODEL" in
  download) model_kv=(download=1) ;;
  none) ;;
  *) [[ -f "$MODEL/model.q8.gguf" && -f "$MODEL/config.json" ]] || { echo "--model $MODEL: not a staged model folder (stage-android-model.sh)" >&2; exit 2; }
     MODEL_DIR_HOST="$(cd "$MODEL" && pwd)" ;;
esac

{
  echo "serial=$SERIAL slug=$SLUG flavor=$FLAVOR scenario=$SCENARIO expect=$REASON"
  echo "apk=${APK:-installed} sha256=$APK_SHA"
  echo "model=$MODEL required=$REQUIRED out=$OUT runId=$RUN_ID"
} | tee "$OUT/collect.txt" >&2

if ((!DRY)); then
  state="$(adb -s "$SERIAL" get-state 2>/dev/null || true)"
  [[ "$state" == device ]] || { echo "NOT-RUN device $SERIAL: state '${state:-absent}'" | tee "$OUT/check.txt"; exit 3; }
  STAYON_PREV="$(sh1 settings get global stay_on_while_plugged_in || true)"
  A shell svc power stayon true >/dev/null 2>&1 || true
fi

device_json "$OUT/device.json"

if ((INSTALL)); then
  ((FRESH)) && { A uninstall "$PKG" >/dev/null 2>&1 || true; }
  install_args=(install -r -t)
  [[ -z "$ABI" ]] || install_args+=(--abi "$ABI")
  if ! install_apk "$OUT/install.txt" "${install_args[@]}" "$APK"; then
    cat "$OUT/install.txt" >&2
    {
      echo "# $(date -u +%FT%TZ) serial=$SERIAL flavor=$FLAVOR apk=$(basename "$APK") sha256=$APK_SHA"
      echo "NOT-RUN install: $(install_reason "$OUT/install.txt")"
      echo "RESULT NOT-RUN"
    } >"$OUT/check.txt"
    cat "$OUT/check.txt" >&2
    exit 3
  fi
fi

common_kv=(hold="$HOLD")
[[ -z "$RUNS" ]] || common_kv+=(runs="$RUNS")
[[ -z "$CYCLES" ]] || common_kv+=(cycles="$CYCLES")

st=0
if [[ ",$SCENARIO," == *,S13,* ]]; then
  rows="$TMP/rows.jsonl"
  : >"$rows"
  for th in ${THREADS_LIST//,/ }; do
    for sp in ${SPIN_LIST//,/ }; do
      tag="t$th-s$sp"
      kv=("${common_kv[@]}" "${model_kv[@]}" threads="$th")
      [[ "$sp" == default ]] || kv+=(spin="$sp")
      [[ -n "$RUNS" ]] || kv+=(runs=5)
      rid="$RUN_ID-$tag"
      run_once "$rid" "$(build_url "$rid" s3 "${kv[@]}")" "$OUT/sweep/$tag"
      ((DRY)) && continue
      checks "$OUT/sweep/$tag" "$REASON" "$REQUIRED" || st=1
      jq -c --arg th "$th" --arg sp "$sp" '{threads: ($th | tonumber), spin: $sp,
          loadThreads: .load.numThreads,
          s3: (.results[] | select(.name == "S3_short_speak") | {pass, firstAudioMs: .data.firstAudioMs,
               ttfaMs: .data.ttfaMs, totalMs: .data.totalMs, rtf: .data.rtf, cpu: .data.cpu})}' \
        "$OUT/sweep/$tag/selftest.json" >>"$rows" 2>/dev/null || echo "{\"threads\":$th,\"spin\":\"$sp\",\"error\":\"no selftest.json\"}" >>"$rows"
    done
  done
  if ((!DRY)); then
    jq -s --slurpfile dev "$OUT/device.json" '{device: $dev[0].slug, commit: $dev[0].commit, runs: .}' "$rows" >"$OUT/threads.json"
    {
      echo "# S13 sweep $(date -u +%FT%TZ): per-combination checks in sweep/*/check.txt"
      for f in "$OUT"/sweep/*/check.txt; do echo "$(tail -1 "$f") $(basename "$(dirname "$f")")"; done
    } >"$OUT/sweep/check.txt"
  fi
else
  kv=("${common_kv[@]}" "${model_kv[@]}")
  [[ -z "$THREADS" ]] || kv+=(threads="$THREADS")
  [[ -z "$SPIN" ]] || kv+=(spin="$SPIN")
  run_once "$RUN_ID" "$(build_url "$RUN_ID" "$DL_SCENARIOS" "${kv[@]}")" "$OUT"
  ((DRY)) || checks "$OUT" "$REASON" "$REQUIRED" || st=1
fi

A shell am force-stop "$PKG" >/dev/null 2>&1 || true
if ((KEEP_APP)); then
  log "keeping $PKG installed (--keep-app)"
else
  A uninstall "$PKG" >/dev/null 2>&1 || true
fi
cleanup
((DRY)) && { log "dry run done"; exit 0; }
log "evidence: $OUT"
exit $st
