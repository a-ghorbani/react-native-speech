#!/usr/bin/env bash
# Build libptts_ffi.so (Phonon's C interface) for Android from a pinned xn-ptts checkout, laid out
# as the phonon-android zip's tree:
#
#   <out>/jniLibs/<abi>/libptts_ffi.so
#   <out>/include/ptts.h
#   <out>/include/phonon_required_hwcaps.h
#   <out>/licenses/xn-ptts-LICENSE-{MIT,APACHE}
#   <out>/BUILDINFO.json
#
# This reimplements upstream's android/build.sh with the knobs we need pinned: the arm64 feature
# list (from phonon.lock.json, recorded in BUILDINFO.json and turned into the HWCAP gate header),
# path remapping and SOURCE_DATE_EPOCH for reproducibility, and an explicit target-cpu so the
# .cargo/config.toml target-cpu=native of the checkout never applies.
#
# Usage: build-android.sh --upstream <xn-ptts checkout> [--out <dir>] [--abis "arm64-v8a x86_64"]
#        [--allow-commit-mismatch]
# Env:   ARM64_FEATURES (default: phonon.lock.json arm64Features), ANDROID_NDK_HOME (or
#        ANDROID_NDK_ROOT / ANDROID_HOME/ndk/<NDK_VERSION>), NDK_VERSION (default 28.2.13676358),
#        ANDROID_PLATFORM (default 21, cargo-ndk's own default, written down).
#
# Needs: rustup with the aarch64/x86_64-linux-android targets, cargo-ndk, jq, git.
set -euo pipefail
if ((BASH_VERSINFO[0] < 4)); then
  echo "build-android.sh needs bash >= 4" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LOCK="${PHONON_LOCK:-$ROOT/phonon.lock.json}"

UPSTREAM=""
OUT="$ROOT/scripts/out/phonon/android"
ABIS="arm64-v8a x86_64"
ALLOW_MISMATCH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --abis) ABIS="$2"; shift 2 ;;
    --allow-commit-mismatch) ALLOW_MISMATCH=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$UPSTREAM" ]] || { echo "--upstream <xn-ptts checkout> is required" >&2; exit 2; }
UPSTREAM="$(cd "$UPSTREAM" && pwd)"

LOCK_COMMIT="$(jq -er '.upstream.commit' "$LOCK")"
LOCK_TAG="$(jq -er '.upstream.tag' "$LOCK")"
LOCK_REPO="$(jq -er '.upstream.repo' "$LOCK")"
LOCK_FEATURES="$(jq -er '.arm64Features' "$LOCK")"
ARM64_FEATURES="${ARM64_FEATURES-$LOCK_FEATURES}"
NDK_VERSION="${NDK_VERSION:-28.2.13676358}"
ANDROID_PLATFORM="${ANDROID_PLATFORM:-21}"

# 1. The checkout must be the pinned commit, and clean.
HEAD_COMMIT="$(git -C "$UPSTREAM" rev-parse HEAD)"
if [[ "$HEAD_COMMIT" != "$LOCK_COMMIT" ]]; then
  if [[ "$ALLOW_MISMATCH" == 1 ]]; then
    echo "warning: upstream is at $HEAD_COMMIT, lock pins $LOCK_COMMIT (--allow-commit-mismatch)" >&2
  else
    echo "upstream checkout is at $HEAD_COMMIT, phonon.lock.json pins $LOCK_COMMIT" >&2
    exit 1
  fi
fi
if [[ -n "$(git -C "$UPSTREAM" status --porcelain --untracked-files=no)" ]]; then
  echo "upstream checkout has local changes; build from a clean checkout" >&2
  exit 1
fi

# 2. The vendored header must be upstream's, byte for byte.
if ! cmp -s "$UPSTREAM/ptts-ffi/include/ptts.h" "$ROOT/cpp/phonon/ptts.h"; then
  echo "cpp/phonon/ptts.h differs from upstream ptts-ffi/include/ptts.h at $HEAD_COMMIT" >&2
  exit 1
fi

# 3. The feature list must be one the HWCAP gate can express.
# shellcheck source=arm64-features.sh
source "$HERE/arm64-features.sh"
phonon_parse_features "$ARM64_FEATURES" >/dev/null

if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  if [[ -n "${ANDROID_NDK_ROOT:-}" ]]; then
    ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
  else
    ANDROID_NDK_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}/ndk/$NDK_VERSION"
  fi
fi
[[ -d "$ANDROID_NDK_HOME" ]] || { echo "NDK not found at $ANDROID_NDK_HOME" >&2; exit 1; }
export ANDROID_NDK_HOME
NDK_REVISION="$(sed -n 's/^Pkg.Revision *= *//p' "$ANDROID_NDK_HOME/source.properties" | tr -d '\r')"
if [[ "$NDK_REVISION" != "$NDK_VERSION" ]]; then
  echo "warning: NDK at $ANDROID_NDK_HOME is $NDK_REVISION, expected $NDK_VERSION" >&2
fi

declare -A TRIPLE=([arm64-v8a]=aarch64-linux-android [x86_64]=x86_64-linux-android)
for abi in $ABIS; do
  [[ -n "${TRIPLE[$abi]+x}" ]] || { echo "unsupported ABI '$abi' (arm64-v8a, x86_64)" >&2; exit 2; }
done

WORK="$OUT.work"
TARGET_DIR="$WORK/target"
mkdir -p "$TARGET_DIR"

# 4. Flags. The per-target variables take precedence over the checkout's build.rustflags
# (target-cpu=native); RUSTFLAGS / CARGO_ENCODED_RUSTFLAGS would take precedence over both, so
# they are cleared. Stripping keeps the exported ptts_* functions. max-page-size=16384 for
# Android 15's 16 KB pages.
REMAP="--remap-path-prefix=$UPSTREAM=/xn-ptts --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$WORK=/build"
COMMON="-C strip=symbols -C link-arg=-Wl,-z,max-page-size=16384 $REMAP"
ARM64_RUSTFLAGS="$COMMON -C target-cpu=generic${ARM64_FEATURES:+ -C target-feature=$ARM64_FEATURES}"
X86_64_RUSTFLAGS="$COMMON -C target-cpu=x86-64"
# BUILDINFO.json records the flags with the machine-specific paths named, not spelled out.
REMAP_SHOWN="--remap-path-prefix=<upstream>=/xn-ptts --remap-path-prefix=<cargo-home>=/cargo --remap-path-prefix=<work>=/build"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="$ARM64_RUSTFLAGS"
export CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS="$X86_64_RUSTFLAGS"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
export CARGO_INCREMENTAL=0
export CARGO_TARGET_DIR="$TARGET_DIR"
SOURCE_DATE_EPOCH="$(git -C "$UPSTREAM" log -1 --format=%ct HEAD)"
export SOURCE_DATE_EPOCH
# GNU and BSD (macOS) spellings of "this epoch as a touch -t stamp" and of sha256.
if date --version >/dev/null 2>&1; then
  STAMP="$(TZ=UTC date -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S)"
else
  STAMP="$(TZ=UTC date -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S)"
fi
if command -v sha256sum >/dev/null; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi

for abi in $ABIS; do
  rustup target add "${TRIPLE[$abi]}" >/dev/null
done

# 5. Build. cargo-ndk only sets up the NDK linker and env; the library is taken from the target
# dir (cargo-ndk's -o copy skips files that look newer, which could leave stale flags in place).
(
  cd "$UPSTREAM"
  for abi in $ABIS; do
    echo "==> cargo ndk -t $abi build --release -p ptts-ffi"
    cargo ndk -t "$abi" --platform "$ANDROID_PLATFORM" build --release --locked -p ptts-ffi
  done
)

rm -rf "$OUT"
mkdir -p "$OUT/include" "$OUT/licenses"
libs_json="{}"
for abi in $ABIS; do
  src="$TARGET_DIR/${TRIPLE[$abi]}/release/libptts_ffi.so"
  [[ -f "$src" ]] || { echo "build produced no $src" >&2; exit 1; }
  mkdir -p "$OUT/jniLibs/$abi"
  cp "$src" "$OUT/jniLibs/$abi/libptts_ffi.so"
  env TZ=UTC touch -t "$STAMP" "$OUT/jniLibs/$abi/libptts_ffi.so"
  size="$(wc -c <"$OUT/jniLibs/$abi/libptts_ffi.so" | tr -d ' ')"
  sha="$("${SHA256[@]}" "$OUT/jniLibs/$abi/libptts_ffi.so" | cut -d' ' -f1)"
  libs_json="$(jq -c --arg abi "$abi" --argjson size "$size" --arg sha "$sha" \
    '. + {($abi): {size: $size, sha256: $sha}}' <<<"$libs_json")"
done

cp "$UPSTREAM/ptts-ffi/include/ptts.h" "$OUT/include/ptts.h"
"$HERE/gen-hwcaps-header.sh" "$ARM64_FEATURES" "$OUT/include/phonon_required_hwcaps.h"
cp "$UPSTREAM/LICENSE-MIT" "$OUT/licenses/xn-ptts-LICENSE-MIT"
cp "$UPSTREAM/LICENSE-APACHE" "$OUT/licenses/xn-ptts-LICENSE-APACHE"

jq -n \
  --arg repo "$LOCK_REPO" --arg tag "$LOCK_TAG" --arg commit "$HEAD_COMMIT" \
  --arg features "$ARM64_FEATURES" \
  --arg rustc "$(rustc --version)" --arg cargoNdk "$(cargo ndk --version 2>/dev/null | head -1)" \
  --arg ndk "$NDK_REVISION" --arg platform "$ANDROID_PLATFORM" \
  --argjson epoch "$SOURCE_DATE_EPOCH" \
  --arg arm64Flags "${ARM64_RUSTFLAGS/"$REMAP"/$REMAP_SHOWN}" \
  --arg x86Flags "${X86_64_RUSTFLAGS/"$REMAP"/$REMAP_SHOWN}" \
  --argjson libs "$libs_json" \
  '{
    upstream: {repo: $repo, tag: $tag, commit: $commit},
    arm64Features: $features,
    toolchain: {rustc: $rustc, cargoNdk: $cargoNdk, ndk: $ndk, androidPlatform: ($platform | tonumber)},
    sourceDateEpoch: $epoch,
    rustflags: {"aarch64-linux-android": $arm64Flags, "x86_64-linux-android": $x86Flags},
    libs: $libs
  }' >"$OUT/BUILDINFO.json"

echo "==> staged $OUT"
for abi in $ABIS; do
  echo "    $abi: $(jq -r --arg a "$abi" '.libs[$a] | "\(.size) bytes  sha256 \(.sha256)"' "$OUT/BUILDINFO.json")"
done
