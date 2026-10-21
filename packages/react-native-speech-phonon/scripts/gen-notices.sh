#!/usr/bin/env bash
# Generate the third-party notices for the Phonon binaries with cargo-about, from the pinned
# xn-ptts checkout, for the crates that end up in the given targets' libptts_ffi.
#
# Usage: gen-notices.sh --upstream <xn-ptts checkout> --out <NOTICES.md>
#        [--target <triple>]...   (default: every target in about.toml)
#        [--online]   (default is --offline: only the crate sources cargo already fetched are read,
#                      which keeps the output deterministic; run `cargo fetch --locked` first)
# Needs cargo-about 0.9.x (`cargo install cargo-about --locked --features cli`), or CARGO_ABOUT
# pointing at the binary. Fails if any crate is under a license about.toml does not accept.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
UPSTREAM=""
OUT=""
TARGETS=()
OFFLINE=(--offline)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --target) TARGETS+=(--target "$2"); shift 2 ;;
    --online) OFFLINE=(); shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$UPSTREAM" && -n "$OUT" ]] || { echo "usage: $0 --upstream <dir> --out <file> [--target T]..." >&2; exit 2; }

if [[ -n "${CARGO_ABOUT:-}" ]]; then
  ABOUT=("$CARGO_ABOUT" about)
else
  ABOUT=(cargo about)
fi

TAG="$(jq -er '.upstream.tag' "${PHONON_LOCK:-$ROOT/phonon.lock.json}")"
COMMIT="$(git -C "$UPSTREAM" rev-parse HEAD)"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

"${ABOUT[@]}" generate --locked ${OFFLINE[@]+"${OFFLINE[@]}"} \
  -c "$HERE/about.toml" -m "$UPSTREAM/ptts-ffi/Cargo.toml" "${TARGETS[@]}" \
  -o "$tmp" "$HERE/about.hbs"

mkdir -p "$(dirname "$OUT")"
# Upstream's path never leaks into the notices: crates in the workspace are named by repo.
sed -e "s|@UPSTREAM@|\`$TAG\` (\`$COMMIT\`)|" -e "s|$UPSTREAM|xn-ptts|g" "$tmp" >"$OUT"
echo "wrote $OUT"
