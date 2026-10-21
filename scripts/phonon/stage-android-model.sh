#!/usr/bin/env bash
# Stage the example app's Android Phonon download (docs/phonon/DESIGN.md §5) on the host, for
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
# The pins are those of example/src/utils/PhononModelManager.ts (CHECKPOINT_31M via
# fetch-ci-model.sh, PHONON_CURATED_VOICES here); test-ci-scripts.sh fails if they drift apart.
#
# Usage: stage-android-model.sh <dir>        prints the staged folder (<dir>/31m-en)
#        stage-android-model.sh --pins       voice pins: "<name> <voiceId> <sha256>"
# Env:   PHONON_HF_BASE_URL (default https://huggingface.co)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VOICES_REPO="gradium/phonon-voices"
VOICES_REVISION="da6c9ec0d47be8df5c87c730a3aa97187f3229c3"
VOICES=(
  "Zoey NbpkqMVS3CJeq2j8 97c7f8c253413574406ab80dd23f49c3ebb2517163b00a9bf86b9c4cf43e7e23"
  "Juniper NIWIOv5vTi5eRMj8 444378eb06b7c492b86e8fc7d13e4db1a3c0cf3e68891a960bf6f0a41a13ef35"
  "Harper 4SZHfMpw-p46Ywgs 6b3da6e2d796a20c51af892c482bd6509fb88267a221aff83c870843dee2a123"
  "Easton LMDIYE0Oa377Qh6Z 45c582673cb20edb04ddcca2b5a8865ddfb0a82599efadb269021e87d20fbdd4"
  "Micah 40QrMVgAxFiUnP9f 0de1098d1051686a138d068e83ff09deb5053328bc74ec9541a1fdb90bfc24da"
  "Trevor 0zLApsZfVLLNaEGl dc1341c8937af5534e6bbcc5c0fc5e7c10312229b59061228074f93683fe2261"
  "Maeve 6PWnV0Nq4wu7RVBT 56494ee67d533ad227ff0dfd0b1c13ff5aa91f1ad6e596e66c2986ba3005e844"
  "Alfie X6NceqF285Gr04gb 4de75497fff3030168e8aa6dca23ffeb332b1bc8c25d0bf3507ceadac953ae9c"
)

[[ $# -eq 1 ]] || { awk 'NR > 1 { if (!/^#/) exit; print }' "$0" >&2; exit 2; }
if [[ "$1" == --pins ]]; then
  for v in "${VOICES[@]}"; do echo "$v"; done
  echo "revision $VOICES_REVISION"
  exit 0
fi

mkdir -p "$1"
ROOT_DIR="$(cd "$1" && pwd)"
DEST="$ROOT_DIR/31m-en"
BASE="${PHONON_HF_BASE_URL:-https://huggingface.co}"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Copied from the fetch-ci-model.sh cache, not linked: adb push does not follow symlinks.
ckpt="$("$HERE/fetch-ci-model.sh" "$ROOT_DIR/.cache" | tail -1)"
mkdir -p "$DEST/voices"
while read -r name want; do
  [[ -n "$name" && "$name" != revision ]] || continue
  if [[ ! -f "$DEST/$name" || "$(sha "$DEST/$name")" != "$want" ]]; then
    cp "$ckpt/$name" "$DEST/$name.part"
    mv "$DEST/$name.part" "$DEST/$name"
  fi
done < <("$HERE/fetch-ci-model.sh" --pins)

for entry in "${VOICES[@]}"; do
  read -r name id want <<<"$entry"
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
done
echo "$DEST"
