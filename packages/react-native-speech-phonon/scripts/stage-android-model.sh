#!/usr/bin/env bash
# Stage the example app's Android Phonon download (docs/DESIGN.md §5) on the host, for
# device-lab runs without on-device internet: <dir>/31m-en/ gets exactly the files the app's
# PhononModelManager downloads (the phonon-31m-en checkpoint plus the 8 curated voices saved as
# voices/<Name>.safetensors), each checked against its sha256. Files already there with the
# right hash are kept.
#
# collect-android-evidence.sh --model <dir>/31m-en pushes this folder into the app's external
# files dir and passes `modelFrom=` on the self-test deep link; the app then installs it with
# PhononModelManager.installFromDirectory (same per-file checks, voices.jsonl, install marker and
# atomic swap as an in-app download).
#
# Pins: example/src/utils/phononPins.json (.checkpoint via fetch-ci-model.sh, .voices here).
#
# Usage: stage-android-model.sh <dir>        prints the staged folder (<dir>/31m-en)
# Env:   PHONON_HF_BASE_URL (default https://huggingface.co)
#        PHONON_PINS (default the example's phononPins.json)
set -euo pipefail

[[ $# -eq 1 ]] || { awk 'NR > 1 { if (!/^#/) exit; print }' "$0" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
export PHONON_PINS="${PHONON_PINS:-$HERE/../../../example/src/utils/phononPins.json}"
CKPT_FILES="$(jq -er '.checkpoint.files[] | "\(.path) \(.sha256)"' "$PHONON_PINS")"
VOICES_REPO="$(jq -er .voices.repo "$PHONON_PINS")"
VOICES_REVISION="$(jq -er .voices.revision "$PHONON_PINS")"
VOICES="$(jq -er '.voices.curated[] | "\(.name) \(.voiceId) \(.sha256)"' "$PHONON_PINS")"

mkdir -p "$1"
ROOT_DIR="$(cd "$1" && pwd)"
DEST="$ROOT_DIR/31m-en"
BASE="${PHONON_HF_BASE_URL:-https://huggingface.co}"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Copied from the fetch-ci-model.sh cache, not linked: adb push does not follow symlinks.
ckpt="$("$HERE/fetch-ci-model.sh" "$ROOT_DIR/.cache" | tail -1)"
mkdir -p "$DEST/voices"
while read -r name want; do
  if [[ ! -f "$DEST/$name" || "$(sha "$DEST/$name")" != "$want" ]]; then
    cp "$ckpt/$name" "$DEST/$name.part"
    mv "$DEST/$name.part" "$DEST/$name"
  fi
done <<<"$CKPT_FILES"

while read -r name id want; do
  out="$DEST/voices/$name.safetensors"
  if [[ -f "$out" && "$(sha "$out")" == "$want" ]]; then
    echo "cached  voices/$name.safetensors" >&2
    continue
  fi
  echo "fetch   voices/$name.safetensors ($id)" >&2
  curl -fsSL --retry 3 --retry-delay 5 -o "$out.part" \
    "$BASE/$VOICES_REPO/resolve/$VOICES_REVISION/voices/$id.safetensors"
  have="$(sha "$out.part")"
  if [[ "$have" != "$want" ]]; then
    rm -f "$out.part"
    echo "sha256 mismatch for voices/$name.safetensors: $have, expected $want" >&2
    exit 1
  fi
  mv "$out.part" "$out"
done <<<"$VOICES"
echo "$DEST"
