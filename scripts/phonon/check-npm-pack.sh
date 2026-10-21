#!/usr/bin/env bash
# Check what the npm package ships of Phonon (docs/phonon/DESIGN.md §3, §4.2).
#
#   required   phonon.lock.json, android/phonon.gradle, ios/phonon/fetch.rb, cpp/phonon/ptts.h,
#              android/proguard-rules.pro, RNSpeech.podspec, lib/module/index.js
#   forbidden  test/ (host tests), cpp/phonon/tests, android/src/*Test/ (JVM tests), scripts/,
#              docs/, example/, build output (build/, .cxx/), any libptts_ffi* binary and any
#              PhononCore.xcframework (binaries are fetched at build time, never packed)
#   size       the tarball is under --max-kb (default 2048)
#
# Usage: check-npm-pack.sh [--tarball <pkg.tgz>] [--max-kb N] [--list <out.txt>]
#        check-npm-pack.sh --selftest
# Without --tarball it runs `npm pack` in the repo root into a temp dir. That runs the
# `prepare` script (bob build) exactly as `npm publish` would: npm 10 runs it even with
# --ignore-scripts, and the check should see the lib/ a release ships. --list writes the
# tarball's file list. Prints one PASS/FAIL line per check, exits non-zero if any failed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

REQUIRED=(phonon.lock.json android/phonon.gradle ios/phonon/fetch.rb cpp/phonon/ptts.h
  android/proguard-rules.pro RNSpeech.podspec lib/module/index.js package.json)
# Extended regexes over the path inside the package (without the leading package/).
FORBIDDEN=('^test/' '^cpp/phonon/tests(/|$)' '^android/src/[A-Za-z]*[Tt]est/' '^scripts/'
  '^docs/' '^example/' '(^|/)build/' '(^|/)\.cxx/' 'libptts_ffi' 'PhononCore\.xcframework')

FAILED=0
pass() { echo "PASS $1: $2"; }
fail() { echo "FAIL $1: $2"; FAILED=1; }

check() {
  local tgz="$1" max_kb="$2" list="$3" files f re hits size
  files="$(tar -tzf "$tgz" | sed -n 's#^package/##p' | grep -v '/$' | LC_ALL=C sort)"
  [[ -n "$files" ]] || { fail contents "$tgz has no package/ entries"; return; }
  if [[ -n "$list" ]]; then
    mkdir -p "$(dirname "$list")"
    echo "$files" >"$list"
  fi
  local missing=""
  for f in "${REQUIRED[@]}"; do
    grep -qxF "$f" <<<"$files" || missing+=" $f"
  done
  if [[ -n "$missing" ]]; then fail required "missing:$missing"; else pass required "${#REQUIRED[@]} files present"; fi

  local bad=""
  for re in "${FORBIDDEN[@]}"; do
    hits="$(grep -E "$re" <<<"$files" | head -3 | paste -sd' ' - || true)"
    [[ -z "$hits" ]] || bad+=" [$re: $hits]"
  done
  if [[ -n "$bad" ]]; then fail forbidden "packed:$bad"; else pass forbidden "no tests, scripts, docs, build output or Phonon binaries"; fi

  size="$(wc -c <"$tgz" | tr -d ' ')"
  if ((size > max_kb * 1024)); then
    fail size "tarball $size bytes > ${max_kb} KB"
  else
    pass size "tarball $size bytes <= ${max_kb} KB ($(wc -l <<<"$files" | tr -d ' ') files)"
  fi
}

selftest() {
  local dir st=0
  dir="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: $dir is local
  trap "rm -rf '$dir'" RETURN
  # mktgz <name> <extra file>...: a package with every required file plus the extras.
  mktgz() {
    local name="$1" f
    shift
    rm -rf "$dir/pkg"
    for f in "${REQUIRED[@]}" src/index.tsx "$@"; do
      mkdir -p "$dir/pkg/package/$(dirname "$f")"
      echo x >"$dir/pkg/package/$f"
    done
    tar -czf "$dir/$name.tgz" -C "$dir/pkg" package
  }
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
  mktgz good android/src/phononStub/java/x/PhononBridge.kt cpp/phonon/PhononCore.cpp
  expect pass - "good package" --tarball "$dir/good.tgz"
  local case
  for case in test/phonon-core/core_test.cpp cpp/phonon/tests/x.cpp android/src/test/java/x/T.kt \
    android/src/phononTest/java/x/T.kt scripts/phonon/verify-apk.sh docs/phonon/DESIGN.md \
    example/App.tsx android/build/x.txt android/.cxx/x.txt \
    android/src/main/jniLibs/arm64-v8a/libptts_ffi.so \
    ios/phonon/PhononCore.xcframework/Info.plist; do
    mktgz bad "$case"
    expect fail forbidden "$case rejected" --tarball "$dir/bad.tgz"
  done
  rm -rf "$dir/pkg"
  mkdir -p "$dir/pkg/package"
  echo x >"$dir/pkg/package/package.json"
  tar -czf "$dir/missing.tgz" -C "$dir/pkg" package
  expect fail required "required files missing" --tarball "$dir/missing.tgz"
  mktgz big
  head -c 300000 /dev/urandom >"$dir/pkg/package/src/blob.bin"
  tar -czf "$dir/big.tgz" -C "$dir/pkg" package
  expect fail size "tarball over --max-kb" --tarball "$dir/big.tgz" --max-kb 100
  expect pass - "tarball under --max-kb" --tarball "$dir/good.tgz" --max-kb 100 --list "$dir/list.txt"
  if grep -qx 'phonon.lock.json' "$dir/list.txt"; then echo "selftest ok: --list"; else echo "selftest FAILED: --list"; st=1; fi
  return $st
}

TARBALL="" MAX_KB=2048 LIST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tarball) TARBALL="$2"; shift 2 ;;
    --max-kb) MAX_KB="$2"; shift 2 ;;
    --list) LIST="$2"; shift 2 ;;
    --selftest) selftest; exit $? ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TARBALL" ]]; then
  OUT="$(mktemp -d)"
  trap 'rm -rf "$OUT"' EXIT
  (cd "$ROOT" && npm pack --pack-destination "$OUT" >"$OUT/npm-pack.log" 2>&1) || {
    tail -40 "$OUT/npm-pack.log" >&2
    echo "npm pack failed" >&2
    exit 2
  }
  TARBALL="$(find "$OUT" -maxdepth 1 -name '*.tgz' | head -1)"
  [[ -n "$TARBALL" ]] || { echo "npm pack produced no tarball" >&2; exit 2; }
fi
echo "== $TARBALL"
check "$TARBALL" "$MAX_KB" "$LIST"
exit "$FAILED"
