#!/usr/bin/env bash
# Flag-off size gate: merge-base vs head, three metrics (docs/phonon/DESIGN.md §3.2, §4.2).
#
#   native   lib/**/*.so set and sizes identical to the merge-base, no Phonon library; the
#            app's TurboModule codegen libraries (libappmodules.so, libreact_codegen_*.so) are
#            measured on their own ("codegen", --codegen-budget, default 8 KB): the phonon*
#            spec methods add JNI glue there with the flag off too
#   dex      the library's dex (apkanalyzer `dex packages`, package com.pocketpalai.speech)
#            grows by at most --dex-budget (default 8 KB)
#   js       the library's minified JS (--js-base-bytes / --js-head-bytes, measured with
#            js-bundle-size.sh) delta against --js-budget (default 40 KB): a warning, a failure
#            with --strict-js. Without them the APKs' JS bundle delta stands in (it includes the
#            example app's own JS); it is reported either way
# plus, with --flag-on, the flag-on APK's file / download size and Phonon libraries (report only).
#
# Usage: apk-size-report.sh --base <merge-base.apk> --head <head.apk> --out <apk-size.json>
#          [--flag-on <head-flag-on.apk>] [--base-ref <sha>] [--head-ref <sha>]
#          [--js-base-bytes N --js-head-bytes N]
#          [--dex-budget N] [--codegen-budget N] [--js-budget N] [--strict-js]
#        apk-size-report.sh --selftest
# All APKs should be release builds with the same build settings. Exits 1 if a gate failed.
#
# Tools: python3; apkanalyzer (APKANALYZER, else $ANDROID_HOME/cmdline-tools/latest/bin, else
# PATH). Without it the dex gate falls back to the total dex delta and download sizes are left
# out.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

find_apkanalyzer() {
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" p
  if [[ -n "${APKANALYZER+x}" ]]; then echo "$APKANALYZER"; return; fi
  for p in "$sdk/cmdline-tools/latest/bin/apkanalyzer" "$sdk"/cmdline-tools/*/bin/apkanalyzer; do
    [[ -n "$sdk" && -x "$p" ]] && { echo "$p"; return; }
  done
  command -v apkanalyzer || true
}

# --- selftest ---------------------------------------------------------------------------------
# Synthetic APKs and a stand-in apkanalyzer (it reads the package size from <apk>.pkg): the
# gate must pass on identical builds and on small growth, and fail on an injected .so, a
# changed .so, a Phonon library, +10 KB of library dex and an over-budget codegen library.
selftest() {
  local dir st=0
  dir="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: $dir is local
  trap "rm -rf '$dir'" RETURN
  cat >"$dir/apkanalyzer" <<'EOF'
#!/usr/bin/env bash
apk="${!#}"
case "$1 $2" in
  "dex packages") echo "P d 10 10 999 com.pocketpalai"; echo "P d 10 10 $(cat "$apk.pkg") com.pocketpalai.speech" ;;
  "apk download-size") echo $(( $(wc -c <"$apk") / 2 )) ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$dir/apkanalyzer"

  # mkapk <name> <library-package dex bytes> <total dex bytes> <js bytes|-> <path>=<size>...
  mkapk() {
    local name="$1" pkg="$2"
    shift 2
    echo "$pkg" >"$dir/$name.apk.pkg"
    python3 - "$dir/$name.apk" "$@" <<'EOF'
import sys, zipfile
out, dex, js, libs = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4:]
with zipfile.ZipFile(out, "w") as z:
    z.writestr("classes.dex", b"d" * dex)
    if js != "-":
        z.writestr("assets/index.android.bundle", b"j" * int(js))
    for spec in libs:
        path, size = spec.split("=")
        z.writestr(zipfile.ZipInfo(path), b"\0" * int(size))
EOF
  }
  local libs=(lib/arm64-v8a/libreactnative.so=5000 lib/arm64-v8a/libnative_dict.so=300
    lib/arm64-v8a/libappmodules.so=2000)
  mkapk base 20000 900000 500000 "${libs[@]}"
  mkapk same 20000 900000 500000 "${libs[@]}"
  mkapk small 27000 908000 530000 "${libs[@]/libappmodules.so=2000/libappmodules.so=8000}"
  mkapk dummy 20000 900000 500000 "${libs[@]}" lib/arm64-v8a/libdummy.so=100
  mkapk changed 20000 900000 500000 "${libs[@]/libnative_dict.so=300/libnative_dict.so=316}"
  mkapk phonon 20000 900000 500000 "${libs[@]}" lib/arm64-v8a/libptts_ffi.so=7000000
  mkapk dex10k 30240 910240 500000 "${libs[@]}"
  mkapk codegen 20000 900000 500000 "${libs[@]/libappmodules.so=2000/libappmodules.so=12000}"
  mkapk js50k 20000 900000 551200 "${libs[@]}"
  mkapk nojs 20000 900000 - "${libs[@]}"
  mkapk on 22000 950000 500000 "${libs[@]}" lib/arm64-v8a/libptts_ffi.so=7000 lib/arm64-v8a/librnspeech_phonon.so=70

  # expect <pass|fail> <metric that must fail or -> <description> <head> [args...]
  # (writes $dir/<head>.json; the contents checks below read the last one per head)
  expect() {
    local want="$1" metric="$2" what="$3" head="$4" out rc=0
    shift 4
    out="$(APKANALYZER="$dir/apkanalyzer" "$0" --base "$dir/base.apk" --head "$dir/$head.apk" \
      --out "$dir/$head.json" "$@" 2>&1)" || rc=$?
    if [[ "$want" == pass && $rc -eq 0 ]] ||
      [[ "$want" == fail && $rc -eq 1 && "$out" == *"FAIL $metric:"* ]]; then
      echo "selftest ok: $what"
    else
      echo "selftest FAILED: $what (exit $rc, wanted $want${metric:+ on $metric})"
      printf '    %s\n' "${out//$'\n'/$'\n'    }"
      st=1
    fi
  }
  expect pass - "identical builds" same
  expect pass - "growth within every budget" small
  expect fail native "injected dummy .so" dummy
  expect fail native "a library changed size" changed
  expect fail native "libptts_ffi.so in a flag-off APK" phonon
  expect fail dex "+10 KB of library dex" dex10k
  expect fail codegen "codegen library over budget" codegen
  expect fail js "JS over budget with --strict-js" js50k --strict-js
  expect pass - "JS over budget only warns" js50k
  expect pass - "JS bundle missing is not measured" nojs
  expect fail js "library JS over budget with --strict-js" same --js-base-bytes 100000 --js-head-bytes 150000 --strict-js
  expect pass - "library JS within budget (app JS over it)" js50k --js-base-bytes 100000 --js-head-bytes 120000 --strict-js
  expect pass - "flag-on report" same --flag-on "$dir/on.apk" --base-ref aaa --head-ref bbb

  if jq -e '.result == "pass" and .mergeBase == "aaa" and .flagOff.native.identical
      and .flagOff.dex.delta == 0 and .flagOff.js.delta == 0
      and (.flagOn.phononLibs | map(.path) | sort) == ["lib/arm64-v8a/libptts_ffi.so", "lib/arm64-v8a/librnspeech_phonon.so"]
      and .flagOn.downloadSizeDelta != null and .flagOn.fileSizeDelta > 0' "$dir/same.json" >/dev/null &&
    jq -e '.flagOff.dex.delta == 7000 and .flagOff.dex.totalDelta == 8000 and .flagOff.codegen.delta == 6000
      and .flagOff.js.delta == 30000 and (.warnings | length) == 0' "$dir/small.json" >/dev/null &&
    jq -e '.flagOff.native.added == ["lib/arm64-v8a/libdummy.so"] and .result == "fail"' "$dir/dummy.json" >/dev/null &&
    jq -e '.flagOff.js.measured == "library bundle" and .flagOff.js.delta == 20000
      and .flagOff.js.appJsDelta == 51200 and .result == "pass"' "$dir/js50k.json" >/dev/null &&
    jq -e '.flagOff.js.delta == null and .flagOff.js.pass == null' "$dir/nojs.json" >/dev/null; then
    echo "selftest ok: apk-size.json contents"
  else
    echo "selftest FAILED: apk-size.json contents"; st=1
  fi

  # No apkanalyzer: gate on the total dex delta (here +10240) and warn.
  local out rc=0
  out="$(APKANALYZER="" "$0" --base "$dir/base.apk" --head "$dir/dex10k.apk" --out "$dir/noaa.json" 2>&1)" || rc=$?
  if [[ $rc -eq 1 && "$out" == *"FAIL dex: total dex"* && "$out" == *"WARN dex: apkanalyzer not available"* ]]; then
    echo "selftest ok: total-dex fallback without apkanalyzer"
  else
    echo "selftest FAILED: total-dex fallback (exit $rc)"; printf '    %s\n' "${out//$'\n'/$'\n'    }"; st=1
  fi
  return $st
}

if [[ "${1:-}" == --selftest ]]; then selftest; exit $?; fi
if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then sed -n '2,24p' "$0"; exit 0; fi
exec python3 "$HERE/apk_size_report.py" --apkanalyzer "$(find_apkanalyzer)" "$@"
