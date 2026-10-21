#!/usr/bin/env bash
# Download the phonon-31m-en checkpoint for the CI emulator jobs (docs/phonon/DESIGN.md §4.2),
# into <dir>/phonon-31m-en, each file checked against its sha256. Files already there with the
# right hash are kept, so a restored actions/cache costs no download.
#
# The pins are those of example/src/utils/PhononModelManager.ts (CHECKPOINT_31M);
# test-ci-scripts.sh fails if the two drift apart.
#
# Usage: fetch-ci-model.sh <dir>     prints the checkpoint folder
# Env:   PHONON_HF_BASE_URL (default https://huggingface.co)
set -euo pipefail

REPO="gradium/phonon-31m-en"
REVISION="52433c46975bfa13144c56204c9f4ee1c5b148aa"
FILES=(
  "config.json 7062ea376e6b158543c8abec8e5af67df171c49ad70eb7e2a0fb25c16f265e06"
  "tokenizer.json 691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936"
  "model.q8.gguf a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae"
  "default-voice.safetensors f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18"
)

[[ $# -eq 1 ]] || { sed -n '2,11p' "$0" >&2; exit 2; }
if [[ "$1" == --pins ]]; then
  for f in "${FILES[@]}"; do echo "$f"; done
  echo "revision $REVISION"
  exit 0
fi
DEST="$1/phonon-31m-en"
BASE="${PHONON_HF_BASE_URL:-https://huggingface.co}"
mkdir -p "$DEST"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

for entry in "${FILES[@]}"; do
  name="${entry% *}" want="${entry#* }"
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
done
echo "$DEST"
