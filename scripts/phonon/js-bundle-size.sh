#!/usr/bin/env bash
# Minified size of the JS a consumer bundles for the library (docs/phonon/DESIGN.md §4.2, the
# "js" metric of apk-size-report.sh): Metro bundles a one-line entry that imports the package,
# through the example app's Metro config, so React Native's own code is the same on both sides
# of a merge-base / head comparison and the example app's code is left out.
#
# Usage: js-bundle-size.sh [--root <repo checkout>] [--config <metro.config.js>] [--out <bundle>]
# Prints the bundle's size in bytes. --root defaults to this checkout (a merge-base worktree
# passes its own). The temporary entry file is removed again.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONFIG=""
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

pkg="$(jq -er .name "$ROOT/package.json")"
tmp="$(mktemp -d)"
entry="$ROOT/example/phonon-size-entry.js"
trap 'rm -rf "$tmp" "$entry"' EXIT
OUT="${OUT:-$tmp/size.bundle}"
# Every export, so no bundler can tree-shake away what the package ships.
printf "import * as lib from '%s';\nglobalThis.__phononSizeProbe = lib;\n" "$pkg" >"$entry"
args=(bundle --platform android --dev false --minify true --entry-file phonon-size-entry.js
  --bundle-output "$OUT" --assets-dest "$tmp/assets")
[[ -z "$CONFIG" ]] || args+=(--config "$CONFIG")
(cd "$ROOT/example" && npx react-native "${args[@]}" >"$tmp/metro.log" 2>&1) || {
  tail -30 "$tmp/metro.log" >&2
  echo "metro bundle failed" >&2
  exit 2
}
wc -c <"$OUT" | tr -d ' '
