#!/usr/bin/env bash
# Write the release's sha256s into phonon.lock.json (the publish job's lock PR, or a developer
# trying the download path against locally built zips).
#
# Usage: update-lock.sh [--sums <SHA256SUMS>] [--release phonon-bin-v0.4.0-r1] [--lock <file>]
#        [--only android|ios]
# Without --sums only the release and asset names change (CI does this before packaging so the
# zips get the release's names).
# The asset names come from the lock (binaries.android.asset / binaries.ios.asset), or are
# derived from --release (phonon-bin-v<ver>-r<N> -> phonon-android-<ver>-r<N>.zip,
# phonon-ios-<ver>-r<N>.xcframework.zip). Every asset updated must have a line in SHA256SUMS.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LOCK="${PHONON_LOCK:-$ROOT/phonon.lock.json}"
SUMS=""
RELEASE=""
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sums) SUMS="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --lock) LOCK="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$SUMS" || -f "$SUMS" ]] || { echo "$SUMS does not exist" >&2; exit 2; }
[[ -n "$SUMS" || -n "$RELEASE" ]] || { echo "usage: $0 [--sums <SHA256SUMS>] [--release <tag>] [--lock <file>] [--only android|ios]" >&2; exit 2; }
case "$ONLY" in ""|android|ios) ;; *) echo "--only takes android or ios" >&2; exit 2 ;; esac

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cp "$LOCK" "$tmp"

if [[ -n "$RELEASE" ]]; then
  if [[ ! "$RELEASE" =~ ^phonon-bin-v([0-9]+\.[0-9]+\.[0-9]+)-(r[0-9]+)$ ]]; then
    echo "release '$RELEASE' is not phonon-bin-v<x.y.z>-r<N>" >&2
    exit 1
  fi
  ver="${BASH_REMATCH[1]}" rev="${BASH_REMATCH[2]}"
  if [[ "v$ver" != "$(jq -r '.upstream.tag' "$tmp")" ]]; then
    echo "release $RELEASE does not match upstream tag $(jq -r '.upstream.tag' "$tmp")" >&2
    exit 1
  fi
  jq --arg r "$RELEASE" --arg a "phonon-android-$ver-$rev.zip" --arg i "phonon-ios-$ver-$rev.xcframework.zip" \
    '.binaries.release = $r | .binaries.android.asset = $a | .binaries.ios.asset = $i' "$tmp" >"$tmp.new"
  mv "$tmp.new" "$tmp"
fi

for platform in android ios; do
  [[ -n "$SUMS" ]] || break
  [[ -z "$ONLY" || "$ONLY" == "$platform" ]] || continue
  asset="$(jq -er --arg p "$platform" '.binaries[$p].asset' "$tmp")"
  sha="$(awk -v a="$asset" '{ f = $2; sub(/^\*/, "", f) } f == a { print $1 }' "$SUMS")"
  if [[ ! "$sha" =~ ^[0-9a-f]{64}$ ]]; then
    echo "no sha256 for $asset in $SUMS" >&2
    exit 1
  fi
  jq --arg p "$platform" --arg s "$sha" '.binaries[$p].sha256 = $s' "$tmp" >"$tmp.new"
  mv "$tmp.new" "$tmp"
  echo "$platform: $asset $sha"
done
cp "$tmp" "$LOCK"
