#!/usr/bin/env bash
# Host tests for the Phonon iOS integration that do not need a Mac (docs/phonon/DESIGN.md WP5):
#   * ios/phonon/PhononIosPolicy.cpp under ASan + UBSan (test/phonon-ios/policy_test.cpp);
#   * ios/phonon/fetch.rb and RNSpeech.podspec's Phonon branches (minitest).
# The Objective-C++ bridge itself is covered by example/ios/SpeechExampleTests/PhononTests.m
# (XCTest, macOS only: scripts/test-ios.sh).
#
# Env: CXX (default clang++ if found, else g++), PHONON_SANITIZE=0 to build without sanitizers,
#      PHONON_IOS_BUILD_DIR (default test/phonon-ios/build, git-ignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${PHONON_IOS_BUILD_DIR:-$ROOT/test/phonon-ios/build}"
if [[ -z "${CXX:-}" ]]; then
  if command -v clang++ >/dev/null 2>&1; then CXX=clang++; else CXX=g++; fi
fi
FLAGS=(-std=c++17 -O1 -g -Wall -Wextra -Werror)
if [[ "${PHONON_SANITIZE:-1}" == 1 ]]; then
  FLAGS+=(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all)
fi

mkdir -p "$BUILD"
echo "phonon-ios: $CXX ${FLAGS[*]}"
"$CXX" "${FLAGS[@]}" -I "$ROOT/ios/phonon" \
  "$ROOT/test/phonon-ios/policy_test.cpp" "$ROOT/ios/phonon/PhononIosPolicy.cpp" \
  -o "$BUILD/policy_test"
LEAKS=1
if [[ "$(uname -s)" == "Darwin" ]]; then LEAKS=0; fi
ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=$LEAKS:abort_on_error=1}" "$BUILD/policy_test"

ruby "$ROOT/test/phonon-ios/fetch_test.rb"
ruby "$ROOT/test/phonon-ios/podspec_test.rb"
echo "phonon-ios: all tests passed"
