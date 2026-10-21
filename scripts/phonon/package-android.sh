#!/usr/bin/env bash
# Zip a staged Android build (build-android.sh output) into the release asset named in
# phonon.lock.json, deterministically: sorted entries, fixed mtimes (SOURCE_DATE_EPOCH from
# BUILDINFO.json), 0644 permissions, no extra fields.
#
#   jniLibs/<abi>/libptts_ffi.so
#   include/{ptts.h,phonon_required_hwcaps.h}
#   licenses/xn-ptts-LICENSE-{MIT,APACHE}
#   THIRD_PARTY_NOTICES.md
#   BUILDINFO.json
#
# Usage: package-android.sh --stage <dir> --notices <THIRD_PARTY_NOTICES.md> [--out-dir <dir>]
# Prints the zip path; the zip's sha256 goes into <out-dir>/SHA256SUMS (replacing its line).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STAGE=""
NOTICES=""
OUT_DIR="$ROOT/scripts/out/phonon/dist"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    --notices) NOTICES="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -d "$STAGE" && -f "$NOTICES" ]] || { echo "usage: $0 --stage <dir> --notices <file> [--out-dir <dir>]" >&2; exit 2; }
for f in BUILDINFO.json include/ptts.h include/phonon_required_hwcaps.h; do
  [[ -f "$STAGE/$f" ]] || { echo "$STAGE/$f missing: run build-android.sh first" >&2; exit 1; }
done

ASSET="$(jq -er '.binaries.android.asset' "${PHONON_LOCK:-$ROOT/phonon.lock.json}")"
EPOCH="$(jq -er '.sourceDateEpoch' "$STAGE/BUILDINFO.json")"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

tree="$(mktemp -d)"
trap 'rm -rf "$tree"' EXIT
cp -R "$STAGE/jniLibs" "$STAGE/include" "$STAGE/licenses" "$STAGE/BUILDINFO.json" "$tree/"
cp "$NOTICES" "$tree/THIRD_PARTY_NOTICES.md"
find "$tree" -type d -exec chmod 0755 {} +
find "$tree" -type f -exec chmod 0644 {} +
# touch -t reads local time, hence TZ=UTC on both sides.
if date --version >/dev/null 2>&1; then
  STAMP="$(TZ=UTC date -d "@$EPOCH" +%Y%m%d%H%M.%S)"
else
  STAMP="$(TZ=UTC date -r "$EPOCH" +%Y%m%d%H%M.%S)"
fi
find "$tree" -exec env TZ=UTC touch -h -t "$STAMP" {} +

rm -f "$OUT_DIR/$ASSET"
(
  cd "$tree"
  # -X: no uid/gid or extended timestamps; -D: no directory entries; DOS times are local, so TZ.
  find . -type f | sed 's|^\./||' | LC_ALL=C sort | TZ=UTC zip -X -D -q -9 "$OUT_DIR/$ASSET" -@
)

sums="$OUT_DIR/SHA256SUMS"
touch "$sums"
if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
line="$(cd "$OUT_DIR" && "${sum[@]}" "$ASSET")"
{ grep -v "  $ASSET\$" "$sums" || true; echo "$line"; } | LC_ALL=C sort -k2 >"$sums.tmp"
mv "$sums.tmp" "$sums"
cp "$STAGE/BUILDINFO.json" "$OUT_DIR/BUILDINFO-android.json"
echo "$OUT_DIR/$ASSET"
