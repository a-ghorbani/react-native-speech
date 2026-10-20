#!/usr/bin/env bash
# Repackage upstream's PhononCore.xcframework into the one we ship (design §3.3, §4.1):
#
#   * only the iOS device and simulator slices (upstream's macos-arm64 is dropped);
#   * each arm64 slice prelinked into one object with `ld -r`, exporting only the 8 ptts_*
#     symbols of ptts.exp (upstream's ~30k Rust and C symbols, some unmangled, can no longer
#     collide with the app's), with minos 15.1 so the app links without ~316 "built for newer
#     iOS" warnings (every call is behind @available(iOS 18) in RNSpeechPhonon);
#   * bitcode removed;
#   * an x86_64 simulator stub (ptts_stub.c) lipo'd into the simulator library, so Intel-Mac
#     simulator builds link without EXCLUDED_ARCHS (xcodebuild allows one library per
#     platform variant, hence ios-arm64_x86_64-simulator rather than a separate slice);
#   * no headers and no modulemap: the one ptts.h is cpp/phonon/ptts.h.
#
# Env: SOURCE_DATE_EPOCH (zip mtimes; the workflow passes the upstream commit time), LLVM_OBJCOPY (only if bitcode survives bitcode_strip).
# Usage: package-ios.sh --notices <md> --licenses <dir with xn-ptts-LICENSE-*>
#        [--upstream-zip <PhononCore.xcframework.zip>] [--out-dir <dir>] [--work <dir>]
# Without --upstream-zip, the zip is downloaded from the upstream release in phonon.lock.json.
# Either way its sha256 must match phonon.lock.json upstream.xcframework.sha256.
#
# Output: <out-dir>/<binaries.ios.asset> (PhononCore.xcframework/, licenses/,
# THIRD_PARTY_NOTICES.md, BUILDINFO.json), its line in <out-dir>/SHA256SUMS, and the unzipped
# <work>/PhononCore.xcframework for verify-ios-xcframework.sh. macOS with Xcode only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LOCK="${PHONON_LOCK:-$ROOT/phonon.lock.json}"
MINOS="${PHONON_IOS_MINOS:-15.1}"
SDK_VERSION="${PHONON_IOS_SDK_VERSION:-18.0}"

UPSTREAM_ZIP=""
NOTICES=""
LICENSES=""
OUT_DIR="$ROOT/scripts/out/phonon/dist"
WORK="$ROOT/scripts/out/phonon/ios"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream-zip) UPSTREAM_ZIP="$2"; shift 2 ;;
    --notices) NOTICES="$2"; shift 2 ;;
    --licenses) LICENSES="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
# Every release zip carries the license texts and notices (design §4.1).
[[ -f "$NOTICES" ]] || { echo "--notices <THIRD_PARTY_NOTICES.md> is required" >&2; exit 2; }
if [[ ! -d "$LICENSES" ]] || ! compgen -G "$LICENSES/xn-ptts-LICENSE-*" >/dev/null; then
  echo "--licenses <dir with xn-ptts-LICENSE-*> is required" >&2
  exit 2
fi
[[ "$(uname)" == Darwin ]] || { echo "package-ios.sh needs macOS with Xcode" >&2; exit 2; }

REPO="$(jq -er '.upstream.repo' "$LOCK")"
TAG="$(jq -er '.upstream.tag' "$LOCK")"
COMMIT="$(jq -er '.upstream.commit' "$LOCK")"
UP_ASSET="$(jq -er '.upstream.xcframework.asset' "$LOCK")"
UP_SHA="$(jq -er '.upstream.xcframework.sha256' "$LOCK")"
ASSET="$(jq -er '.binaries.ios.asset' "$LOCK")"

rm -rf "$WORK"
mkdir -p "$WORK/upstream" "$WORK/slices" "$OUT_DIR"
WORK="$(cd "$WORK" && pwd)"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# 1. Upstream framework, pinned by sha256.
if [[ -z "$UPSTREAM_ZIP" ]]; then
  UPSTREAM_ZIP="$WORK/$UP_ASSET"
  curl -fsSL --retry 3 -o "$UPSTREAM_ZIP" "https://github.com/$REPO/releases/download/$TAG/$UP_ASSET"
fi
have="$(shasum -a 256 "$UPSTREAM_ZIP" | cut -d' ' -f1)"
if [[ "$have" != "$UP_SHA" ]]; then
  echo "$UPSTREAM_ZIP: sha256 $have, phonon.lock.json pins $UP_SHA" >&2
  exit 1
fi
ditto -x -k "$UPSTREAM_ZIP" "$WORK/upstream"
SRC="$WORK/upstream/PhononCore.xcframework"
[[ -d "$SRC" ]] || { echo "zip has no PhononCore.xcframework at its root" >&2; exit 1; }

# 2. Prelink one arm64 slice: <upstream slice id> <ld platform> -> <work>/slices/<name>.a
prelink() {
  local slice="$1" platform="$2" name="$3"
  local lib="$SRC/$slice/libptts_ffi.a" dir="$WORK/slices/$name"
  [[ -f "$lib" ]] || { echo "upstream has no $slice/libptts_ffi.a" >&2; exit 1; }
  mkdir -p "$dir/members"
  # Members are extracted rather than force-loaded so the object list is explicit; ar would
  # silently keep only one of two same-named members, so duplicates are an error.
  local dups
  dups="$(xcrun ar -t "$lib" | grep -v '^__\.SYMDEF' | sort | uniq -d)"
  [[ -z "$dups" ]] || { echo "$lib has duplicate member names: $dups" >&2; exit 1; }
  (cd "$dir/members" && xcrun ar -x "$lib" && rm -f __.SYMDEF*)
  # Rust embeds bitcode in its objects; strip it before linking where bitcode_strip accepts the
  # object, and check the prelinked object below either way.
  local o
  for o in "$dir"/members/*.o; do
    if xcrun otool -l "$o" | grep -q 'sectname __bitcode'; then
      if xcrun bitcode_strip -r "$o" -o "$o.nobc" 2>/dev/null; then mv "$o.nobc" "$o"; else rm -f "$o.nobc"; fi
    fi
  done
  find "$dir/members" -name '*.o' | LC_ALL=C sort >"$dir/members.txt"
  xcrun ld -r -arch arm64 -platform_version "$platform" "$MINOS" "$SDK_VERSION" \
    -exported_symbols_list "$HERE/ptts.exp" -filelist "$dir/members.txt" -o "$dir/ptts.o"
  if xcrun otool -l "$dir/ptts.o" | grep -Eq 'segname __LLVM|sectname __bitcode'; then
    # ld -r carried the bitcode over (bitcode_strip refused the members): drop the sections.
    local objcopy="${LLVM_OBJCOPY:-}"
    if [[ -z "$objcopy" ]]; then
      for objcopy in "$(xcrun --find llvm-objcopy 2>/dev/null || true)" \
        /opt/homebrew/opt/llvm/bin/llvm-objcopy /opt/homebrew/opt/llvm@*/bin/llvm-objcopy \
        /usr/local/opt/llvm/bin/llvm-objcopy ""; do
        [[ -n "$objcopy" && -x "$objcopy" ]] && break
      done
    fi
    [[ -n "$objcopy" ]] || { echo "ptts.o still has bitcode and no llvm-objcopy was found (set LLVM_OBJCOPY)" >&2; exit 1; }
    "$objcopy" --remove-section=__LLVM,__bitcode --remove-section=__LLVM,__cmdline \
      --remove-section=__LLVM,__asm "$dir/ptts.o" "$dir/ptts.nobc.o"
    mv "$dir/ptts.nobc.o" "$dir/ptts.o"
  fi
  xcrun libtool -static -D -o "$WORK/slices/$name.a" "$dir/ptts.o"
}
prelink ios-arm64 ios device-arm64
prelink ios-arm64-simulator ios-simulator sim-arm64

# 3. x86_64 simulator stub.
xcrun --sdk iphonesimulator clang -target "x86_64-apple-ios$MINOS-simulator" \
  -O2 -fvisibility=hidden -I "$ROOT/cpp/phonon" -c "$HERE/ptts_stub.c" -o "$WORK/slices/stub-x86_64.o"
xcrun libtool -static -D -o "$WORK/slices/sim-x86_64.a" "$WORK/slices/stub-x86_64.o"
xcrun lipo -create "$WORK/slices/sim-arm64.a" "$WORK/slices/sim-x86_64.a" -output "$WORK/slices/sim.a"

# 4. The xcframework, libraries only (no -headers).
mkdir -p "$WORK/lib-device" "$WORK/lib-sim"
cp "$WORK/slices/device-arm64.a" "$WORK/lib-device/libptts_ffi.a"
cp "$WORK/slices/sim.a" "$WORK/lib-sim/libptts_ffi.a"
XCF="$WORK/PhononCore.xcframework"
xcodebuild -create-xcframework \
  -library "$WORK/lib-device/libptts_ffi.a" \
  -library "$WORK/lib-sim/libptts_ffi.a" \
  -output "$XCF" >/dev/null

# 5. Verify before zipping.
"$HERE/verify-ios-xcframework.sh" "$XCF"

# 6. Zip with licenses, notices and build info.
PKG="$WORK/pkg"
mkdir -p "$PKG/licenses"
cp -R "$XCF" "$PKG/"
cp "$LICENSES"/xn-ptts-LICENSE-* "$PKG/licenses/"
cp "$NOTICES" "$PKG/THIRD_PARTY_NOTICES.md"
sizes="{}"
for lib in "$XCF"/*/libptts_ffi.a; do
  id="$(basename "$(dirname "$lib")")"
  sizes="$(jq -c --arg id "$id" --argjson size "$(stat -f %z "$lib")" \
    --arg sha "$(shasum -a 256 "$lib" | cut -d' ' -f1)" '. + {($id): {size: $size, sha256: $sha}}' <<<"$sizes")"
done
jq -n --arg repo "$REPO" --arg tag "$TAG" --arg commit "$COMMIT" --arg upSha "$UP_SHA" \
  --arg minos "$MINOS" --arg sdk "$SDK_VERSION" --arg xcode "$(xcodebuild -version | tr '\n' ' ')" \
  --argjson libs "$sizes" \
  '{upstream: {repo: $repo, tag: $tag, commit: $commit, xcframeworkSha256: $upSha},
    minos: $minos, sdkVersion: $sdk, exportedSymbols: 8, toolchain: {xcode: $xcode}, libs: $libs}' \
  >"$PKG/BUILDINFO.json"
cp "$PKG/BUILDINFO.json" "$OUT_DIR/BUILDINFO-ios.json"

# Fixed mtimes (SOURCE_DATE_EPOCH: the workflow passes the upstream commit time, as
# build-android.sh uses), so the zip's metadata does not change from run to run.
EPOCH="${SOURCE_DATE_EPOCH:-315532800}"
STAMP="$(TZ=UTC date -r "$EPOCH" +%Y%m%d%H%M.%S)"
find "$PKG" -exec env TZ=UTC touch -h -t "$STAMP" {} +
rm -f "$OUT_DIR/$ASSET"
(cd "$PKG" && ditto -c -k --norsrc --noextattr --noqtn . "$OUT_DIR/$ASSET")

sums="$OUT_DIR/SHA256SUMS"
touch "$sums"
line="$(cd "$OUT_DIR" && shasum -a 256 "$ASSET")"
{ grep -v "  $ASSET\$" "$sums" || true; echo "$line"; } | LC_ALL=C sort -k2 >"$sums.tmp"
mv "$sums.tmp" "$sums"
echo "$OUT_DIR/$ASSET"
