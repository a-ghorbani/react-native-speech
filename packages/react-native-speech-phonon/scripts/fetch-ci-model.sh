#!/usr/bin/env bash
# Download the phonon-31m-en checkpoint for the CI emulator jobs (docs/DESIGN.md §4.2),
# into <dir>/phonon-31m-en, each file checked against its sha256. Files already there with the
# right hash are kept, so a restored actions/cache costs no download.
#
# Pins: example/src/utils/phononPins.json (.checkpoint), shared with the app's PhononModelManager.
#
# Usage: fetch-ci-model.sh <dir>     prints the checkpoint folder
# Env:   PHONON_HF_BASE_URL (default https://huggingface.co)
#        PHONON_PINS (default the example's phononPins.json; the self-tests point it at fixtures)
set -euo pipefail

[[ $# -eq 1 ]] || { awk 'NR > 1 { if (!/^#/) exit; print }' "$0" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
PINS="${PHONON_PINS:-$HERE/../../../example/src/utils/phononPins.json}"
REPO="$(jq -er .checkpoint.repo "$PINS")"
REVISION="$(jq -er .checkpoint.revision "$PINS")"
FILES="$(jq -er '.checkpoint.files[] | "\(.path) \(.sha256)"' "$PINS")"
DEST="$1/phonon-31m-en"
BASE="${PHONON_HF_BASE_URL:-https://huggingface.co}"
mkdir -p "$DEST"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

while read -r name want; do
  if [[ -f "$DEST/$name" && "$(sha "$DEST/$name")" == "$want" ]]; then
    echo "cached  $name" >&2
    continue
  fi
  echo "fetch   $name" >&2
  curl -fsSL --retry 3 --retry-delay 5 -o "$DEST/$name.part" "$BASE/$REPO/resolve/$REVISION/$name"
  have="$(sha "$DEST/$name.part")"
  if [[ "$have" != "$want" ]]; then
    rm -f "$DEST/$name.part"
    echo "sha256 mismatch for $name: $have, expected $want" >&2
    exit 1
  fi
  mv "$DEST/$name.part" "$DEST/$name"
done <<<"$FILES"
echo "$DEST"
