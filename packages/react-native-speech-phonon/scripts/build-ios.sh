#!/usr/bin/env bash
# Build libptts_ffi.a (Phonon's C interface) for iOS from a pinned xn-ptts checkout, with
# patches/xn-gemm-no-amx.patch compiling xn-gemm's Apple AMX kernels out (design §3.3, §4.1):
#
#   <out>/ios-arm64/libptts_ffi.a            aarch64-apple-ios
#   <out>/ios-arm64-simulator/libptts_ffi.a  aarch64-apple-ios-sim
#   <out>/BUILDINFO.json                     upstream pin and build provenance
#
# The dependency tree is upstream's Cargo.lock under --locked, vendored and patched outside the
# checkout, which is never written to. Upstream's release profile and rustc's default target CPU,
# as in upstream's own build; per-target flags so the checkout's target-cpu=native never applies.
# package-ios.sh --slices <out> turns the output into the release xcframework.
#
# Usage: build-ios.sh --upstream <xn-ptts checkout> [--out <dir>] [--vendor-cache <dir>]
# --vendor-cache keeps the vendored sources across runs, keyed on the Cargo.lock sha256 in
# <dir>/.complete; without it they are vendored into <out>.work.
# Env:   IPHONEOS_DEPLOYMENT_TARGET (default 18.0, as upstream's build).
#
# Needs: rustup, jq, git, patch; an Xcode iOS SDK for the build step.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LOCK="${PHONON_LOCK:-$ROOT/phonon.lock.json}"
PATCH_REL="scripts/patches/xn-gemm-no-amx.patch"
PATCH="$ROOT/$PATCH_REL"
TARGETS="aarch64-apple-ios aarch64-apple-ios-sim"

UPSTREAM=""
OUT="$ROOT/scripts/out/ios-build"
CACHE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --vendor-cache) CACHE="$2"; shift 2 ;;
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$UPSTREAM" ]] || { echo "--upstream <xn-ptts checkout> is required" >&2; exit 2; }
UPSTREAM="$(cd "$UPSTREAM" && pwd)"
mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
WORK="$OUT.work"

LOCK_COMMIT="$(jq -er '.upstream.commit' "$LOCK")"
LOCK_TAG="$(jq -er '.upstream.tag' "$LOCK")"
LOCK_REPO="$(jq -er '.upstream.repo' "$LOCK")"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"
if command -v sha256sum >/dev/null; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi
sha256() { "${SHA256[@]}" "$1" | cut -d' ' -f1; }
slice_of() { case "$1" in aarch64-apple-ios) echo ios-arm64 ;; aarch64-apple-ios-sim) echo ios-arm64-simulator ;; esac; }

# 1. The checkout must be the pinned commit, clean, with upstream's ptts.h.
HEAD_COMMIT="$(git -C "$UPSTREAM" rev-parse HEAD)"
if [[ "$HEAD_COMMIT" != "$LOCK_COMMIT" ]]; then
  echo "upstream checkout is at $HEAD_COMMIT, phonon.lock.json pins $LOCK_COMMIT" >&2
  exit 1
fi
if [[ -n "$(git -C "$UPSTREAM" status --porcelain --untracked-files=no)" ]]; then
  echo "upstream checkout has local changes; build from a clean checkout" >&2
  exit 1
fi
STATUS_BEFORE="$(git -C "$UPSTREAM" status --porcelain)"
if ! cmp -s "$UPSTREAM/ptts-ffi/include/ptts.h" "$ROOT/cpp/ptts.h"; then
  echo "cpp/ptts.h differs from upstream ptts-ffi/include/ptts.h at $HEAD_COMMIT" >&2
  exit 1
fi
LOCK_SHA="$(sha256 "$UPSTREAM/Cargo.lock")"

# 2. Vendored sources.
mkdir -p "$WORK"
rm -rf "$WORK/vendor"
if [[ -z "$CACHE" ]]; then
  (cd "$UPSTREAM" && cargo vendor --locked --versioned-dirs "$WORK/vendor" >/dev/null)
else
  mkdir -p "$(dirname "$CACHE")"
  CACHE="$(cd "$(dirname "$CACHE")" && pwd)/$(basename "$CACHE")"
  if [[ "$(cat "$CACHE/.complete" 2>/dev/null)" != "$LOCK_SHA" ]]; then
    if [[ -d "$CACHE" && ! -f "$CACHE/.complete" && -n "$(ls -A "$CACHE")" ]]; then
      echo "--vendor-cache $CACHE is not empty and has no .complete; not deleting it" >&2
      exit 1
    fi
    rm -rf "$CACHE"
    (cd "$UPSTREAM" && cargo vendor --locked --versioned-dirs "$CACHE" >/dev/null)
    echo "$LOCK_SHA" >"$CACHE/.complete"
  fi
  cp -al "$CACHE" "$WORK/vendor" 2>/dev/null || { rm -rf "$WORK/vendor"; cp -R "$CACHE" "$WORK/vendor"; }
  rm -f "$WORK/vendor/.complete"
fi

# 3. The patch, with zero fuzz, and the patched files' checksums. Files that change are replaced,
# never written through a hard link into the cache.
PATCHED="$(sed -n 's|^+++ b/||p' "$PATCH" | cut -f1)"
for f in $PATCHED; do
  crate="${f%%/*}"
  if [[ ! -d "$WORK/vendor/$crate" ]]; then
    echo "patch targets $crate, not in the vendored sources (xn-gemm version changed?)" >&2
    exit 1
  fi
  for g in "$WORK/vendor/$f" "$WORK/vendor/$crate/.cargo-checksum.json"; do
    cp -p "$g" "$g.new" && mv "$g.new" "$g"
  done
done
patch -d "$WORK/vendor" -p1 -F0 -N --dry-run -i "$PATCH" >/dev/null
patch -d "$WORK/vendor" -p1 -F0 -N -i "$PATCH"
for f in $PATCHED; do
  sums="$WORK/vendor/${f%%/*}/.cargo-checksum.json"
  jq -c --arg f "${f#*/}" --arg s "$(sha256 "$WORK/vendor/$f")" '.files[$f] = $s' "$sums" >"$sums.new"
  mv "$sums.new" "$sums"
done

# 4. Flags. The per-target variables override the checkout's build.rustflags (target-cpu=native);
# RUSTFLAGS / CARGO_ENCODED_RUSTFLAGS would override both, so they are cleared.
REMAP="--remap-path-prefix=$UPSTREAM=/xn-ptts --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$WORK=/build"
REMAP_SHOWN="--remap-path-prefix=<upstream>=/xn-ptts --remap-path-prefix=<cargo-home>=/cargo --remap-path-prefix=<work>=/build"
export CARGO_TARGET_AARCH64_APPLE_IOS_RUSTFLAGS="$REMAP"
export CARGO_TARGET_AARCH64_APPLE_IOS_SIM_RUSTFLAGS="$REMAP"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
export CARGO_INCREMENTAL=0
export CARGO_TARGET_DIR="$WORK/target"
SOURCE_DATE_EPOCH="$(git -C "$UPSTREAM" log -1 --format=%ct HEAD)"
export SOURCE_DATE_EPOCH

for t in $TARGETS; do
  rustup target add "$t" >/dev/null
done

# 5. Build.
(
  cd "$UPSTREAM"
  for t in $TARGETS; do
    echo "==> cargo build --release --locked --offline -p ptts-ffi --target $t"
    cargo build --release --locked --offline -p ptts-ffi --target "$t" \
      --config "source.crates-io.replace-with='vendored-sources'" \
      --config "source.vendored-sources.directory='$WORK/vendor'"
  done
)
if [[ "$(git -C "$UPSTREAM" status --porcelain)" != "$STATUS_BEFORE" ]]; then
  echo "the build changed the upstream checkout:" >&2
  git -C "$UPSTREAM" status --porcelain >&2
  exit 1
fi

rm -rf "$OUT"
for t in $TARGETS; do
  src="$CARGO_TARGET_DIR/$t/release/libptts_ffi.a"
  [[ -f "$src" ]] || { echo "build produced no $src" >&2; exit 1; }
  mkdir -p "$OUT/$(slice_of "$t")"
  cp "$src" "$OUT/$(slice_of "$t")/libptts_ffi.a"
done

jq -n \
  --arg repo "$LOCK_REPO" --arg tag "$LOCK_TAG" --arg commit "$HEAD_COMMIT" \
  --arg rustc "$(rustc --version)" --arg dt "$IPHONEOS_DEPLOYMENT_TARGET" \
  --arg lockSha "$LOCK_SHA" --argjson epoch "$SOURCE_DATE_EPOCH" \
  --arg flags "$REMAP_SHOWN" \
  --arg patch "$PATCH_REL" --arg patchSha "$(sha256 "$PATCH")" \
  --arg targets "$TARGETS" \
  '{
    upstream: {repo: $repo, tag: $tag, commit: $commit},
    build: {
      from: "source", rustc: $rustc, targets: ($targets | split(" ")),
      deploymentTarget: $dt, cargoLockSha256: $lockSha, sourceDateEpoch: $epoch,
      rustflags: (($targets | split(" ")) | map({(.): $flags}) | add),
      patches: [{path: $patch, sha256: $patchSha}]
    }
  }' >"$OUT/BUILDINFO.json"

echo "==> staged $OUT"
for t in $TARGETS; do
  echo "    $(slice_of "$t"): $(wc -c <"$OUT/$(slice_of "$t")/libptts_ffi.a" | tr -d ' ') bytes"
done
