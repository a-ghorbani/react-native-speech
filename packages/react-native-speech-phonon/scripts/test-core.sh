#!/usr/bin/env bash
# Build and run the Phonon C++ core host tests (test/core) with ASan + UBSan.
#
# Usage: scripts/test-core.sh [test-name-filter]
#
# Env:
#   CC / CXX               compilers (default: clang/clang++ if found, else gcc/g++)
#   PHONON_SANITIZE=0      build without sanitizers; =thread for ThreadSanitizer instead of
#                          ASan+UBSan (Linux runs it under `setarch -R`: TSan rejects high ASLR)
#   PHONON_CORE_BUILD_DIR  build directory (default: test/core/build, git-ignored)
#   PHONON_REAL_LIB        optional host libptts_ffi.so for the real_lib test, with
#   PHONON_MODEL_DIR       a checkpoint folder (e.g. phonon-31m-en). See test/core/README.md.
set -euo pipefail  # bash 3.2 (macOS) safe: empty arrays use ${a[@]+...}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/test/core"
BUILD="${PHONON_CORE_BUILD_DIR:-$SRC/build}"
SANITIZE="${PHONON_SANITIZE:-1}"

if [[ -z "${CC:-}" || -z "${CXX:-}" ]]; then
  if command -v clang >/dev/null 2>&1 && command -v clang++ >/dev/null 2>&1; then
    export CC=clang CXX=clang++
  else
    export CC=gcc CXX=g++
  fi
fi

GENERATOR=()
if command -v ninja >/dev/null 2>&1; then GENERATOR=(-G Ninja); fi

SAN=OFF
TSAN=OFF
RUN=()
case "$SANITIZE" in
  1) SAN=ON ;;
  thread)
    TSAN=ON
    if [[ "$(uname -s)" == "Linux" ]] && command -v setarch >/dev/null 2>&1; then
      RUN=(setarch "$(uname -m)" -R)
    fi
    ;;
esac
echo "phonon-core: $CXX, asan+ubsan $SAN, tsan $TSAN, build dir $BUILD"

# Reconfigure from scratch when the compiler or sanitizer setting changed.
STAMP="$BUILD/.config-stamp"
WANT="$CXX|$SAN|$TSAN"
if [[ -f "$STAMP" && "$(cat "$STAMP")" != "$WANT" ]]; then rm -rf "$BUILD"; fi

cmake -S "$SRC" -B "$BUILD" ${GENERATOR[@]+"${GENERATOR[@]}"} \
  -DPHONON_SANITIZE="$SAN" -DPHONON_TSAN="$TSAN" >/dev/null
echo "$WANT" > "$STAMP"
cmake --build "$BUILD" --parallel

# LeakSanitizer is Linux-only; on macOS detect_leaks=1 makes ASan refuse to start.
LEAKS=1
if [[ "$(uname -s)" == "Darwin" ]]; then LEAKS=0; fi
export ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=$LEAKS:abort_on_error=1:strict_string_checks=1}"
export UBSAN_OPTIONS="${UBSAN_OPTIONS:-print_stacktrace=1:halt_on_error=1}"
export TSAN_OPTIONS="${TSAN_OPTIONS:-halt_on_error=1}"

FILTER="${1:-}"
status=0
${RUN[@]+"${RUN[@]}"} "$BUILD/core_test" ${FILTER:+"$FILTER"} || status=1
if [[ -z "$FILTER" ]]; then
  ${RUN[@]+"${RUN[@]}"} "$BUILD/static_api_test" || status=1
fi

if [[ $status -ne 0 ]]; then
  echo "phonon-core: FAILED"
  exit 1
fi
echo "phonon-core: all tests passed"
