#!/usr/bin/env bash
# Refuse an add-on release whose phonon.lock.json pins an iOS zip with Apple AMX or undecodable
# instructions (App Store ITMS-90755; design §4.3): download binaries.ios.asset of
# binaries.release, check its sha256 against the lock, and run verify-ios-xcframework.sh
# --amx-only on every slice.
#
# Usage: check-pinned-ios.sh [--zip <local copy of the asset>]
# Env:   LLVM_OBJDUMP (else the NDK's or PATH's llvm-objdump), PHONON_LOCK,
#        PHONON_RELEASE_BASE_URL (default https://github.com/$GITHUB_REPOSITORY/releases/download,
#        GITHUB_REPOSITORY defaulting to a-ghorbani/react-native-speech).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LOCK="${PHONON_LOCK:-$ROOT/phonon.lock.json}"
ZIP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip) ZIP="$2"; shift 2 ;;
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

RELEASE="$(jq -er '.binaries.release' "$LOCK")"
ASSET="$(jq -er '.binaries.ios.asset' "$LOCK")"
WANT="$(jq -er '.binaries.ios.sha256' "$LOCK")"
[[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || { echo "$LOCK pins no iOS sha256 ($WANT)" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [[ -z "$ZIP" ]]; then
  ZIP="$tmp/$ASSET"
  base="${PHONON_RELEASE_BASE_URL:-https://github.com/${GITHUB_REPOSITORY:-a-ghorbani/react-native-speech}/releases/download}"
  url="$base/$RELEASE/$ASSET"
  curl -fsSL --retry 3 -o "$ZIP" "$url" || { echo "could not download $url" >&2; exit 1; }
fi
if command -v sha256sum >/dev/null; then SUM=(sha256sum); else SUM=(shasum -a 256); fi
have="$("${SUM[@]}" "$ZIP" | cut -d' ' -f1)"
[[ "$have" == "$WANT" ]] || { echo "$ASSET: sha256 $have, $LOCK pins $WANT" >&2; exit 1; }

unzip -q "$ZIP" -d "$tmp/x"
[[ -d "$tmp/x/PhononCore.xcframework" ]] || { echo "$ASSET has no PhononCore.xcframework" >&2; exit 1; }
"$HERE/verify-ios-xcframework.sh" --amx-only "$tmp/x/PhononCore.xcframework"
echo "$RELEASE/$ASSET: no AMX or undecodable instructions"
