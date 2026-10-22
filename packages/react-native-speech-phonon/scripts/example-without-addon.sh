#!/usr/bin/env bash
# Turns the example into an app that installs only the core: drops the add-on from
# example/package.json, so autolinking leaves it out (its JS then reports not-compiled).
# CI uses this for the core-only checks. Undo: git checkout example/package.json.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/../../.." && pwd)/example/package.json"
out="$(jq 'del(.dependencies["@pocketpalai/react-native-speech-phonon"])' "$PKG")"
printf '%s\n' "$out" >"$PKG"
