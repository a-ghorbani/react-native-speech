#!/usr/bin/env bash
# Precompile upstream's Core ML bundle for the HF mirror (design §4.1 step 6, §5): every
# X.mlpackage becomes X.mlmodelc next to it (the layout ptts-coreml loads without compiling:
# driver.rs looks for <name>.mlmodelc first), and bundle.json is rewritten to list the compiled
# files, so the app downloads per file and checks each against its sha256, with no zip and no
# on-device compile.
#
# Usage: precompile-coreml.sh [--zip <phonon-31m-en-coreml.zip>] [--out-dir <dir>]
#        [--compiler "<cmd>"]   (default "xcrun coremlcompiler"; called as `<cmd> compile <pkg> <dir>`)
# Without --zip the bundle is downloaded from the upstream release in phonon.lock.json; either way
# its sha256 must match upstream.coreml.sha256.
#
# Output: <out-dir>/<bundle>/            the precompiled bundle, with its new bundle.json
#         <out-dir>/<bundle>.manifest.tsv  path<TAB>size<TAB>sha256, sorted, one line per file
# On Linux (no coremlcompiler) only --compiler with a stand-in works; that is what the tests use.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LOCK="${PHONON_LOCK:-$ROOT/phonon.lock.json}"

ZIP=""
OUT_DIR="$ROOT/scripts/out/phonon/coreml"
COMPILER="xcrun coremlcompiler"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip) ZIP="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --compiler) COMPILER="$2"; shift 2 ;;
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO="$(jq -er '.upstream.repo' "$LOCK")"
TAG="$(jq -er '.upstream.tag' "$LOCK")"
ASSET="$(jq -er '.upstream.coreml.asset' "$LOCK")"
SHA="$(jq -er '.upstream.coreml.sha256' "$LOCK")"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
WORK="$OUT_DIR/.work"
rm -rf "$WORK"
mkdir -p "$WORK/src"

if [[ -z "$ZIP" ]]; then
  ZIP="$WORK/$ASSET"
  curl -fsSL --retry 3 -o "$ZIP" "https://github.com/$REPO/releases/download/$TAG/$ASSET"
fi
have="$(sha256 "$ZIP")"
[[ "$have" == "$SHA" ]] || { echo "$ZIP: sha256 $have, phonon.lock.json pins $SHA" >&2; exit 1; }
if [[ "$(uname)" == Darwin ]]; then ditto -x -k "$ZIP" "$WORK/src"; else unzip -q "$ZIP" -d "$WORK/src"; fi

# The bundle is the one directory holding bundle.json (at the zip root or one level down).
# (No mapfile: this runs under macOS's bash 3.2 too.)
found="$(find "$WORK/src" -maxdepth 2 -name bundle.json -not -path '*/__MACOSX/*')"
count="$(grep -c . <<<"$found" || true)"
[[ "$count" == 1 ]] || { echo "expected one bundle.json in $ASSET, found $count" >&2; exit 1; }
SRC="$(dirname "$found")"
NAME="$(basename "$SRC")"
[[ "$SRC" != "$WORK/src" ]] || NAME="${ASSET%.zip}"

DEST="$OUT_DIR/$NAME"
rm -rf "$DEST" "$OUT_DIR/$NAME.manifest.tsv"
cp -R "$SRC" "$WORK/bundle"

shopt -s nullglob
packages=("$WORK/bundle"/*.mlpackage)
[[ ${#packages[@]} -gt 0 ]] || { echo "no .mlpackage in the bundle" >&2; exit 1; }
for pkg in "${packages[@]}"; do
  base="$(basename "$pkg" .mlpackage)"
  echo "==> compile $base.mlpackage"
  # shellcheck disable=SC2086
  $COMPILER compile "$pkg" "$WORK/bundle" >/dev/null
  [[ -d "$WORK/bundle/$base.mlmodelc" ]] || { echo "compiler wrote no $base.mlmodelc" >&2; exit 1; }
  rm -rf "$pkg"
done

COMPILER_VERSION="$($COMPILER version 2>/dev/null | head -1 || true)"
XCODE_VERSION="$( (xcodebuild -version 2>/dev/null || true) | tr '\n' ' ' | sed 's/ *$//')"
python3 -I "$HERE/bundle_manifest.py" "$WORK/bundle" "$OUT_DIR/$NAME.manifest.tsv" \
  --source "$ASSET" --source-sha256 "$SHA" --compiler "${COMPILER_VERSION:-unknown}" --xcode "${XCODE_VERSION:-}"

mv "$WORK/bundle" "$DEST"
rm -rf "$WORK"
echo "==> $DEST ($(du -sh "$DEST" | cut -f1)), manifest $OUT_DIR/$NAME.manifest.tsv"
