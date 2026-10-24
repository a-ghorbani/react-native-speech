#!/usr/bin/env bash
# Package the source-built iOS libraries (build-ios.sh output) into the xcframework we ship
# (design §3.3, §4.1):
#
#   * the iOS device and simulator arm64 slices, each prelinked into one object with `ld -r`,
#     exporting only the 8 ptts_* symbols of ptts.exp (the ~30k Rust and C symbols, some
#     unmangled, can no longer collide with the app's), with minos 15.1 so the app links without
#     ~316 "built for newer iOS" warnings (every call is behind @available(iOS 18) in RNSpeechPhonon);
#   * bitcode removed;
#   * an x86_64 simulator stub (ptts_stub.c) lipo'd into the simulator library, so Intel-Mac
#     simulator builds link without EXCLUDED_ARCHS (xcodebuild allows one library per
#     platform variant, hence ios-arm64_x86_64-simulator rather than a separate slice);
#   * no headers and no modulemap: the one ptts.h is cpp/ptts.h.
#
# Env: LLVM_OBJCOPY (only if bitcode survives bitcode_strip).
# Zip mtimes are the slices' BUILDINFO.json build.sourceDateEpoch (the upstream commit time).
# Usage: package-ios.sh --slices <build-ios.sh out> --notices <md> --licenses <dir with xn-ptts-LICENSE-*>
#        [--out-dir <dir>] [--work <dir>]
#
# Output: <out-dir>/<binaries.ios.asset> (PhononCore.xcframework/, licenses/,
# THIRD_PARTY_NOTICES.md, BUILDINFO.json), its line in <out-dir>/SHA256SUMS, and the unzipped
# <work>/PhononCore.xcframework for verify-ios-xcframework.sh. macOS with Xcode only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LOCK="${PHONON_LOCK:-$ROOT/phonon.lock.json}"
MINOS="${PHONON_IOS_MINOS:-15.1}"
SDK_VERSION="${PHONON_IOS_SDK_VERSION:-18.0}"

SLICES=""
NOTICES=""
LICENSES=""
OUT_DIR="$ROOT/scripts/out/dist"
WORK="$ROOT/scripts/out/ios"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slices) SLICES="$2"; shift 2 ;;
    --notices) NOTICES="$2"; shift 2 ;;
    --licenses) LICENSES="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$SLICES" ]] || { echo "--slices <build-ios.sh out> is required" >&2; exit 2; }
# Every release zip carries the license texts and notices (design §4.1).
[[ -f "$NOTICES" ]] || { echo "--notices <THIRD_PARTY_NOTICES.md> is required" >&2; exit 2; }
if [[ ! -d "$LICENSES" ]] || ! compgen -G "$LICENSES/xn-ptts-LICENSE-*" >/dev/null; then
  echo "--licenses <dir with xn-ptts-LICENSE-*> is required" >&2
  exit 2
fi
[[ "$(uname)" == Darwin ]] || { echo "package-ios.sh needs macOS with Xcode" >&2; exit 2; }

COMMIT="$(jq -er '.upstream.commit' "$LOCK")"
ASSET="$(jq -er '.binaries.ios.asset' "$LOCK")"
for f in ios-arm64/libptts_ffi.a ios-arm64-simulator/libptts_ffi.a BUILDINFO.json; do
  [[ -f "$SLICES/$f" ]] || { echo "$SLICES/$f missing: run build-ios.sh first" >&2; exit 1; }
done
built="$(jq -er '.upstream.commit' "$SLICES/BUILDINFO.json")"
if [[ "$built" != "$COMMIT" ]]; then
  echo "$SLICES was built from upstream $built, phonon.lock.json pins $COMMIT" >&2
  exit 1
fi
SRC="$(cd "$SLICES" && pwd)"

rm -rf "$WORK"
mkdir -p "$WORK/slices" "$OUT_DIR"
WORK="$(cd "$WORK" && pwd)"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# 1. Prelink one arm64 slice: <build-ios.sh slice id> <ld platform> -> <work>/slices/<name>.a
prelink() {
  local slice="$1" platform="$2" name="$3"
  local lib="$SRC/$slice/libptts_ffi.a" dir="$WORK/slices/$name"
  [[ -f "$lib" ]] || { echo "no $slice/libptts_ffi.a in $SRC" >&2; exit 1; }
  mkdir -p "$dir/members"
  # Extracted, not force-loaded, so the object list is explicit; ar -x would silently drop one of
  # two same-named members, hence the duplicate check.
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

# 2. x86_64 simulator stub.
xcrun --sdk iphonesimulator clang -target "x86_64-apple-ios$MINOS-simulator" \
  -O2 -fvisibility=hidden -I "$ROOT/cpp" -c "$HERE/ptts_stub.c" -o "$WORK/slices/stub-x86_64.o"
xcrun libtool -static -D -o "$WORK/slices/sim-x86_64.a" "$WORK/slices/stub-x86_64.o"
xcrun lipo -create "$WORK/slices/sim-arm64.a" "$WORK/slices/sim-x86_64.a" -output "$WORK/slices/sim.a"

# 3. The xcframework, libraries only (no -headers).
mkdir -p "$WORK/lib-device" "$WORK/lib-sim"
cp "$WORK/slices/device-arm64.a" "$WORK/lib-device/libptts_ffi.a"
cp "$WORK/slices/sim.a" "$WORK/lib-sim/libptts_ffi.a"
XCF="$WORK/PhononCore.xcframework"
xcodebuild -create-xcframework \
  -library "$WORK/lib-device/libptts_ffi.a" \
  -library "$WORK/lib-sim/libptts_ffi.a" \
  -output "$XCF" >/dev/null

# 4. Verify before zipping.
"$HERE/verify-ios-xcframework.sh" "$XCF"

# 5. Zip with licenses, notices and build info.
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
jq --arg minos "$MINOS" --arg sdk "$SDK_VERSION" --arg xcode "$(xcodebuild -version | tr '\n' ' ')" \
  --argjson libs "$sizes" \
  '{upstream: .upstream, build: .build, minos: $minos, sdkVersion: $sdk, exportedSymbols: 8,
    toolchain: {xcode: $xcode}, libs: $libs}' "$SLICES/BUILDINFO.json" >"$PKG/BUILDINFO.json"
cp "$PKG/BUILDINFO.json" "$OUT_DIR/BUILDINFO-ios.json"

EPOCH="$(jq -er '.build.sourceDateEpoch' "$SLICES/BUILDINFO.json")"
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
