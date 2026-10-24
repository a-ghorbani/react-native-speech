#!/usr/bin/env bash
# Carry the current release's Android zip forward, byte for byte, under a new release's name: the
# Android output of an iOS-only binaries run (design §4.1).
#
# Usage: carry-android.sh --lock <phonon.lock.json before renaming> --release <phonon-bin-v...-rN>
#        --from <dir> --out-dir <dir>
# <dir> holds the lock's binaries.android.asset and that release's BUILDINFO-android.json (the
# workflow downloads them). Checked before anything is written: the zip's sha256 is the lock's
# binaries.android.sha256, the zip was built from the lock's upstream.commit, and the
# BUILDINFO-android.json is the zip's own BUILDINFO.json.
#
# Output: <out-dir>/<new android asset>, <out-dir>/BUILDINFO-android.json, <out-dir>/SHA256SUMS.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOCK=""
RELEASE=""
FROM=""
OUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lock) LOCK="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ ! -f "$LOCK" || -z "$RELEASE" || ! -d "$FROM" || -z "$OUT_DIR" ]]; then
  echo "usage: $0 --lock <file> --release <name> --from <dir> --out-dir <dir>" >&2
  exit 2
fi
if command -v sha256sum >/dev/null; then SUM=(sha256sum); else SUM=(shasum -a 256); fi

PREV_ASSET="$(jq -er '.binaries.android.asset' "$LOCK")"
WANT="$(jq -er '.binaries.android.sha256' "$LOCK")"
COMMIT="$(jq -er '.upstream.commit' "$LOCK")"
ZIP="$FROM/$PREV_ASSET"
INFO="$FROM/BUILDINFO-android.json"

[[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || { echo "$LOCK pins no Android sha256 ($WANT)" >&2; exit 1; }
[[ -f "$ZIP" && -f "$INFO" ]] || { echo "$FROM needs $PREV_ASSET and BUILDINFO-android.json" >&2; exit 1; }
have="$("${SUM[@]}" "$ZIP" | cut -d' ' -f1)"
[[ "$have" == "$WANT" ]] || { echo "$PREV_ASSET: sha256 $have, $LOCK pins $WANT" >&2; exit 1; }
built="$(unzip -p "$ZIP" BUILDINFO.json | jq -er '.upstream.commit')"
[[ "$built" == "$COMMIT" ]] || { echo "$PREV_ASSET was built from upstream $built, $LOCK pins $COMMIT" >&2; exit 1; }
if ! cmp -s <(unzip -p "$ZIP" BUILDINFO.json) "$INFO"; then
  echo "$INFO is not the BUILDINFO.json inside $PREV_ASSET" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cp "$LOCK" "$tmp"
"$HERE/update-lock.sh" --lock "$tmp" --release "$RELEASE"
ASSET="$(jq -er '.binaries.android.asset' "$tmp")"

mkdir -p "$OUT_DIR"
cp "$ZIP" "$OUT_DIR/$ASSET"
cp "$INFO" "$OUT_DIR/BUILDINFO-android.json"
(cd "$OUT_DIR" && "${SUM[@]}" "$ASSET") >"$OUT_DIR/SHA256SUMS"
echo "$OUT_DIR/$ASSET"
