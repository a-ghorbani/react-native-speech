#!/usr/bin/env bash
# Check what the add-on's npm package ships (docs/DESIGN.md §3, §4.2), or with --core that the
# core package ships no Phonon at all.
#
# Add-on:
#   required   phonon.lock.json, android/{build,phonon}.gradle, the shim's CMakeLists.txt,
#              ios/fetch.rb, cpp/ptts.h, android/proguard-rules.pro, RNSpeechPhonon.podspec,
#              react-native.config.js, docs/THIRD_PARTY_NOTICES.md, lib/module/index.js
#   forbidden  test/ (host tests), cpp/tests, android/src/*Test/ (JVM tests), scripts/,
#              docs/ other than the notices, example/, build output (build/, .cxx/), any
#              libptts_ffi* binary and any PhononCore.xcframework (binaries are fetched at build
#              time, never packed)
#   size       the tarball is under --max-kb (default 2048)
# Core (--core):
#   phonon     no packed path and no packed code (src/, lib/, jest/, android/, ios/, cpp/,
#              podspecs, react-native.config.js) mentions Phonon (case-insensitive); the
#              README may point at the add-on
#
# Usage: check-npm-pack.sh [--core] [--root <package dir>] [--tarball <pkg.tgz>] [--max-kb N]
#                          [--list <out.txt>]
#        check-npm-pack.sh --selftest
# Without --tarball it runs `npm pack` in --root (default: this package) into a temp dir. That
# runs the `prepare` script (bob build) exactly as `npm publish` would: npm 10 runs it even with
# --ignore-scripts, and the check should see the lib/ a release ships. --list writes the
# tarball's file list. Prints one PASS/FAIL line per check, exits non-zero if any failed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

REQUIRED=(phonon.lock.json android/build.gradle android/phonon.gradle
  android/src/main/cpp/CMakeLists.txt ios/fetch.rb cpp/ptts.h android/proguard-rules.pro
  RNSpeechPhonon.podspec react-native.config.js docs/THIRD_PARTY_NOTICES.md lib/module/index.js
  package.json)
# Extended regexes over the path inside the package (without the leading package/).
FORBIDDEN=('^test/' '^cpp/tests(/|$)' '^android/src/[A-Za-z]*[Tt]est/' '^scripts/'
  '^docs/' '^example/' '(^|/)build/' '(^|/)\.cxx/' 'libptts_ffi' 'PhononCore\.xcframework')
ALLOWED=(docs/THIRD_PARTY_NOTICES.md)
CORE_REQUIRED=(package.json lib/module/index.js RNSpeech.podspec android/build.gradle)

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

  local bad="" checked
  checked="$(grep -vxF -f <(printf '%s\n' "${ALLOWED[@]}") <<<"$files" || true)"
  for re in "${FORBIDDEN[@]}"; do
    hits="$(grep -E "$re" <<<"$checked" | head -3 | paste -sd' ' - || true)"
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

# check_core <pkg.tgz> <list>: the core package carries no Phonon file and no Phonon code.
check_core() {
  local tgz="$1" list="$2" files f missing="" dir hits
  files="$(tar -tzf "$tgz" | sed -n 's#^package/##p' | grep -v '/$' | LC_ALL=C sort)"
  [[ -n "$files" ]] || { fail contents "$tgz has no package/ entries"; return; }
  if [[ -n "$list" ]]; then
    mkdir -p "$(dirname "$list")"
    echo "$files" >"$list"
  fi
  for f in "${CORE_REQUIRED[@]}"; do
    grep -qxF "$f" <<<"$files" || missing+=" $f"
  done
  if [[ -n "$missing" ]]; then fail required "missing:$missing"; else pass required "${#CORE_REQUIRED[@]} files present"; fi
  dir="$(mktemp -d)"
  tar -xzf "$tgz" -C "$dir"
  hits="$( (grep -i phonon <<<"$files" || true
    grep -lis phonon "$dir/package"/*.podspec "$dir/package/react-native.config.js" 2>/dev/null || true
    for d in src lib jest android ios cpp; do
      [[ ! -d "$dir/package/$d" ]] || grep -rlis phonon "$dir/package/$d" || true
    done) | sed "s#^$dir/package/##" |
    LC_ALL=C sort -u | head -5 | paste -sd' ' -)"
  rm -rf "$dir"
  if [[ -n "$hits" ]]; then fail phonon "core package has Phonon code: $hits"; else pass phonon "no Phonon code in $(wc -l <<<"$files" | tr -d ' ') files"; fi
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
  mktgz good android/src/main/java/x/PhononBridge.kt cpp/PhononCore.cpp
  expect pass - "good package" --tarball "$dir/good.tgz"
  rm -rf "$dir/pkg"
  for f in "${CORE_REQUIRED[@]}" src/index.tsx; do
    mkdir -p "$dir/pkg/package/$(dirname "$f")"
    echo x >"$dir/pkg/package/$f"
  done
  tar -czf "$dir/core.tgz" -C "$dir/pkg" package
  echo "see the Phonon add-on" >"$dir/pkg/package/README.md"
  tar -czf "$dir/core.tgz" -C "$dir/pkg" package
  expect pass - "core without Phonon code" --core --tarball "$dir/core.tgz"
  echo "// see PhononEngine" >"$dir/pkg/package/src/index.tsx"
  tar -czf "$dir/core-text.tgz" -C "$dir/pkg" package
  expect fail phonon "core mentioning Phonon rejected" --core --tarball "$dir/core-text.tgz"
  echo x >"$dir/pkg/package/src/index.tsx"
  mkdir -p "$dir/pkg/package/cpp/phonon" && echo x >"$dir/pkg/package/cpp/phonon/x.cpp"
  tar -czf "$dir/core-path.tgz" -C "$dir/pkg" package
  expect fail phonon "core with a Phonon path rejected" --core --tarball "$dir/core-path.tgz"
  local case
  for case in test/core/core_test.cpp cpp/tests/x.cpp android/src/test/java/x/T.kt \
    android/src/phononTest/java/x/T.kt scripts/verify-apk.sh docs/DESIGN.md \
    example/App.tsx android/build/x.txt android/.cxx/x.txt \
    android/src/main/jniLibs/arm64-v8a/libptts_ffi.so \
    ios/PhononCore.xcframework/Info.plist; do
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

TARBALL="" MAX_KB=2048 LIST="" CORE=0 PACK_ROOT="$ROOT"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --core) CORE=1; shift ;;
    --root) PACK_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --tarball) TARBALL="$2"; shift 2 ;;
    --max-kb) MAX_KB="$2"; shift 2 ;;
    --list) LIST="$2"; shift 2 ;;
    --selftest) selftest; exit $? ;;
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TARBALL" ]]; then
  OUT="$(mktemp -d)"
  trap 'rm -rf "$OUT"' EXIT
  (cd "$PACK_ROOT" && npm pack --pack-destination "$OUT" >"$OUT/npm-pack.log" 2>&1) || {
    tail -40 "$OUT/npm-pack.log" >&2
    echo "npm pack failed" >&2
    exit 2
  }
  TARBALL="$(find "$OUT" -maxdepth 1 -name '*.tgz' | head -1)"
  [[ -n "$TARBALL" ]] || { echo "npm pack produced no tarball" >&2; exit 2; }
fi
echo "== $TARBALL"
if ((CORE)); then
  check_core "$TARBALL" "$LIST"
else
  check "$TARBALL" "$MAX_KB" "$LIST"
fi
exit "$FAILED"
