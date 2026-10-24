#!/usr/bin/env bash
# Verify the packaged PhononCore.xcframework (package-ios.sh output) before release
# (design §3.3, §4.1):
#
#   layout     exactly two libraries: ios-arm64 [arm64] and ios-arm64_x86_64-simulator
#              [arm64, x86_64]; no HeadersPath, no headers, no modulemap anywhere
#   archs      each library holds exactly the architectures its Info.plist entry lists
#   prelinked  each architecture is one object (the ld -r prelink), not Rust's ~700 members
#   exports    the defined external symbols of every architecture are exactly ptts.exp
#   objc       no undefined _OBJC_CLASS_$ references (nothing that needs iOS 18 at load time)
#   undefined  on macOS, each slice links as a dylib against the iOS SDK at minos; elsewhere every
#              other undefined symbol matches ios-undefined-allow.txt (SDK C symbols only:
#              no Rust symbol left unresolved by the prelink)
#   bitcode    no __LLVM segment / __bitcode section
#   minos      every LC_BUILD_VERSION is minos 15.1 on the right platform (ios / iossimulator)
#   amx        llvm-objdump -d finds no <unknown> word and, on arm64 (--mattr=+all), no Apple AMX
#              word ((w & 0xfffffc00) == 0x00201000), which App Store review rejects (ITMS-90755)
#
# Usage: verify-ios-xcframework.sh <PhononCore.xcframework>
#        verify-ios-xcframework.sh --amx-only <PhononCore.xcframework>   # needs python3 and
#                                                 # llvm-objdump only (the add-on release guard)
#        verify-ios-xcframework.sh --selftest   # builds dummy xcframeworks that must pass / fail
#
# Runs on macOS (xcrun nm / otool / ar) and on Linux with LLVM tools (llvm-nm,
# llvm-objdump --macho, llvm-ar from $ANDROID_NDK_HOME or PATH), so the checks themselves can be
# exercised off a Mac. Needs python3 for Info.plist.
# Env: LLVM_OBJDUMP (the amx disassembler; default: llvm-objdump from the NDK or PATH, never
#      xcrun's).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MINOS="${PHONON_IOS_MINOS:-15.1}"

find_llvm() {
  local name="$1" ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}" p
  if [[ -n "$ndk" ]]; then
    for p in "$ndk"/toolchains/llvm/prebuilt/*/bin/"$name"; do
      [[ -x "$p" ]] && { echo "$p"; return; }
    done
  fi
  command -v "$name" || true
}

if [[ "$(uname)" == Darwin ]]; then
  NM=(xcrun nm)
  AR=(xcrun ar -t)
  LOADCMDS=(xcrun otool -l)
elif [[ "${1:-}" != --amx-only ]]; then
  NM=("$(find_llvm llvm-nm)")
  LOADCMDS=("$(find_llvm llvm-objdump)" --macho --private-headers)
  AR=("$(find_llvm llvm-ar)" t)
  for t in "${AR[0]}" "${NM[0]}" "${LOADCMDS[0]}"; do
    [[ -n "$t" ]] || { echo "need llvm-ar, llvm-nm and llvm-objdump (set ANDROID_NDK_HOME)" >&2; exit 2; }
  done
fi

# machotool archs <file> | thin <file> <arch> <out> | create <out> <in>...
# lipo's three jobs in Python: llvm-lipo 19 crashes on thin archives, and one code path keeps
# macOS and Linux checks identical.
machotool() {
  python3 -I - "$@" <<'EOF'
import struct, sys
CPU = {0x0100000C: "arm64", 0x01000007: "x86_64"}
NAME = {v: k for k, v in CPU.items()}
def fat_entries(data):
    if data[:4] != b"\xca\xfe\xba\xbe":
        return None
    n = struct.unpack(">I", data[4:8])[0]
    return [struct.unpack(">5I", data[8 + 20 * i:28 + 20 * i]) for i in range(n)]
def thin_arch(data):
    if data[:8] == b"!<arch>\n":
        off = 8
        while off + 60 <= len(data):
            name = data[off:off + 16].decode().strip()
            size = int(data[off + 48:off + 58].decode().strip())
            body = off + 60
            if name.startswith("#1/"):  # BSD long name stored in the body
                n = int(name[3:])
                name, body, size = data[body:body + n].rstrip(b"\0").decode(), body + n, size - n
            if not name.startswith("__.SYMDEF") and data[body:body + 4] == b"\xcf\xfa\xed\xfe":
                return CPU.get(struct.unpack("<I", data[body + 4:body + 8])[0], "unknown")
            off = body + size + ((body + size) & 1)
        return "unknown"
    if data[:4] == b"\xcf\xfa\xed\xfe":
        return CPU.get(struct.unpack("<I", data[4:8])[0], "unknown")
    return "unknown"
cmd, path = sys.argv[1], sys.argv[2]
if cmd == "create":
    blobs = [open(p, "rb").read() for p in sys.argv[3:]]
    hdr = struct.pack(">II", 0xCAFEBABE, len(blobs))
    off, body, entries = 0x4000, b"", []
    for b in blobs:
        entries.append(struct.pack(">5I", NAME[thin_arch(b)], 0, off + len(body), len(b), 14))
        body += b + b"\0" * ((-len(b)) % 0x4000)
    out = hdr + b"".join(entries)
    open(path, "wb").write(out + b"\0" * (0x4000 - len(out)) + body)
    sys.exit(0)
data = open(path, "rb").read()
fat = fat_entries(data)
if cmd == "archs":
    print(" ".join(CPU.get(e[0], "unknown") for e in fat) if fat else thin_arch(data))
elif cmd == "thin":
    want, out = sys.argv[3], sys.argv[4]
    if not fat:
        if thin_arch(data) != want: sys.exit("no %s in %s" % (want, path))
        open(out, "wb").write(data); sys.exit(0)
    for e in fat:
        if CPU.get(e[0]) == want:
            open(out, "wb").write(data[e[2]:e[2] + e[3]]); sys.exit(0)
    sys.exit("no %s in %s" % (want, path))
EOF
}

OBJDUMP="${LLVM_OBJDUMP:-$(find_llvm llvm-objdump)}"

FAILED=0
pass() { echo "PASS $1: $2"; }
fail() { echo "FAIL $1: $2"; FAILED=1; }

# plist_libs <xcframework>: one line per library: id|path|platform|variant|archs(,)|headers
plist_libs() {
  python3 -I - "$1/Info.plist" <<'EOF'
import plistlib, sys
with open(sys.argv[1], "rb") as f:
    p = plistlib.load(f)
for lib in p.get("AvailableLibraries", []):
    print("|".join([
        lib.get("LibraryIdentifier", ""),
        lib.get("LibraryPath", ""),
        lib.get("SupportedPlatform", ""),
        lib.get("SupportedPlatformVariant", ""),
        ",".join(sorted(lib.get("SupportedArchitectures", []))),
        lib.get("HeadersPath", ""),
    ]))
EOF
}

# check_amx <label> <arch> <thin archive> <tmp dir>
check_amx() {
  local label="$1" arch="$2" thin="$3" tmp="$4" sections text counts n amx unk syms ok=1
  [[ -n "$OBJDUMP" ]] || { fail amx "$label: no llvm-objdump (set LLVM_OBJDUMP)"; return; }
  case "$arch" in
    arm64) "$OBJDUMP" -d --mattr=+all "$thin" >"$tmp/amx.dis" 2>/dev/null || ok=0 ;;
    x86_64) "$OBJDUMP" -d "$thin" >"$tmp/amx.dis" 2>/dev/null || ok=0 ;;
    *) fail amx "$label: unknown architecture"; return ;;
  esac
  if ((!ok)) || ! sections="$("$OBJDUMP" --section-headers "$thin" 2>/dev/null)"; then
    fail amx "$label: $OBJDUMP failed"
    return
  fi
  text="$(awk '$2 == "__text" && $3 ~ /[1-9a-f]/ { n++ } END { print n + 0 }' <<<"$sections")"
  counts="$(awk -v arm64="$([[ "$arch" == arm64 ]] && echo 1)" '
    /^[0-9a-f]+ <.*>:$/ { sym = substr($0, index($0, "<") + 1); sym = substr(sym, 1, length(sym) - 2); next }
    arm64 && /^ *[0-9a-f]+: [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] +\t/ {
      n++; bad = 0
      if ($2 ~ /^00201[0-3]/) { amx++; bad = 1 }
      if ($0 ~ /\t<unknown>/) { unk++; bad = 1 }
    }
    !arm64 && /^ *[0-9a-f]+: [0-9a-f][0-9a-f] / {
      n++; bad = 0
      if ($0 ~ /\t<unknown>/) { unk++; bad = 1 }
    }
    bad && !(sym in seen) && nsyms < 5 { seen[sym] = 1; syms = syms (nsyms++ ? " " : "") sym; bad = 0 }
    END { print n + 0, amx + 0, unk + 0, syms }' "$tmp/amx.dis")"
  rm -f "$tmp/amx.dis"
  read -r n amx unk syms <<<"$counts"
  if ((text > 0 && n == 0)); then
    fail amx "$label: __text is not empty but 0 instructions parsed"
  elif ((amx > 0 || unk > 0)); then
    fail amx "$label: $amx AMX words, $unk <unknown>; first: $syms"
  else
    pass amx "$label: $n instructions, 0 AMX, 0 unknown"
  fi
}

# verify_amx <xcframework>: only the amx check, on every architecture of every library.
verify_amx() {
  local xcf="${1%/}" tmp id path arch archs checked=0
  echo "== $xcf (amx only, $OBJDUMP)"
  [[ -f "$xcf/Info.plist" ]] || { fail amx "no Info.plist"; return; }
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  while IFS='|' read -r id path _; do
    [[ -n "$id" ]] || continue
    [[ -f "$xcf/$id/$path" ]] || { fail amx "$id: $path missing"; continue; }
    archs="$(machotool archs "$xcf/$id/$path")"
    for arch in $archs; do
      machotool thin "$xcf/$id/$path" "$arch" "$tmp/$id-$arch.a"
      check_amx "$id/$arch" "$arch" "$tmp/$id-$arch.a" "$tmp"
      checked=$((checked + 1))
    done
  done <<<"$(plist_libs "$xcf")"
  ((checked > 0)) || fail amx "no library architectures in $xcf"
}

verify() {
  local xcf="${1%/}" id path platform variant archs lib have want arch
  local tmp exports extra missing members objc undefs unknown lc bad
  echo "== $xcf"
  [[ -f "$xcf/Info.plist" ]] || { fail layout "no Info.plist"; return; }
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  local libs ids
  libs="$(plist_libs "$xcf")"
  ids="$(cut -d'|' -f1 <<<"$libs" | LC_ALL=C sort | tr '\n' ' ')"
  if [[ "$ids" != "ios-arm64 ios-arm64_x86_64-simulator " ]]; then
    fail layout "libraries are [${ids% }], want [ios-arm64 ios-arm64_x86_64-simulator]"
  else
    pass layout "ios-arm64, ios-arm64_x86_64-simulator"
  fi
  if cut -d'|' -f6 <<<"$libs" | grep -q .; then fail layout "HeadersPath set in Info.plist"; fi
  local hdrs
  hdrs="$(find "$xcf" \( -name '*.h' -o -name 'module.modulemap' -o -name Headers -o -name Modules \) -print | sed "s|^$xcf/||" | tr '\n' ' ')"
  [[ -z "${hdrs// /}" ]] || fail layout "headers/modules present: ${hdrs% }"

  while IFS='|' read -r id path platform variant archs _; do
    [[ -n "$id" ]] || continue
    lib="$xcf/$id/$path"
    echo "-- $id ($platform${variant:+ $variant}: $archs)"
    [[ -f "$lib" ]] || { fail archs "$id: $lib missing"; continue; }
    case "$id" in
      ios-arm64) want="arm64"; [[ "$platform" == ios && -z "$variant" ]] || fail layout "$id: platform $platform/$variant" ;;
      ios-arm64_x86_64-simulator) want="arm64,x86_64"; [[ "$platform" == ios && "$variant" == simulator ]] || fail layout "$id: platform $platform/$variant" ;;
      *) want="$archs" ;;
    esac
    have="$(machotool archs "$lib" | tr ' ' '\n' | grep . | LC_ALL=C sort | paste -sd, -)"
    if [[ "$have" == "$want" && "$archs" == "$want" ]]; then
      pass archs "$id: $have"
    else
      fail archs "$id: binary has [$have], Info.plist lists [$archs], want [$want]"
    fi

    for arch in ${have//,/ }; do
      # One architecture's archive, so every tool sees a thin file.
      machotool thin "$lib" "$arch" "$tmp/$id-$arch.a"
      local thin="$tmp/$id-$arch.a"

      members="$("${AR[@]}" "$thin" | grep -v '^__\.SYMDEF' | grep -c . || true)"
      if [[ "$members" == 1 ]]; then pass prelinked "$id/$arch: 1 object"; else fail prelinked "$id/$arch: $members objects"; fi

      # A failing nm still prints what it read; the failure itself is reported too.
      exports="$("${NM[@]}" -gUj "$thin" 2>"$tmp/nm.err")" || fail exports "$id/$arch: nm failed: $(tr '\n' ' ' <"$tmp/nm.err" | cut -c1-120)"
      exports="$(grep -v ':$' <<<"$exports" | grep . | LC_ALL=C sort -u || true)"
      extra="$(LC_ALL=C comm -13 <(LC_ALL=C sort "$HERE/ptts.exp") <(echo "$exports") | awk 'NR<=5' | tr '\n' ' ')"
      missing="$(LC_ALL=C comm -23 <(LC_ALL=C sort "$HERE/ptts.exp") <(echo "$exports") | tr '\n' ' ')"
      if [[ -n "${extra// /}" || -n "${missing// /}" ]]; then
        fail exports "$id/$arch: $(echo "$exports" | grep -c .) symbols; extra: [${extra% }] missing: [${missing% }]"
      else
        pass exports "$id/$arch: 8 ptts_* symbols"
      fi

      # A pass needs nm to have read the whole archive: a failing nm is a failure here too.
      if undefs="$("${NM[@]}" -uj "$thin" 2>"$tmp/nm.err")"; then
        undefs="$(grep -v ':$' <<<"$undefs" | grep . | LC_ALL=C sort -u || true)"
        objc="$(grep -c '^_OBJC_CLASS_\$' <<<"$undefs" || true)"
        if ((objc > 0)); then fail objc "$id/$arch: $objc _OBJC_CLASS_\$ references"; else pass objc "$id/$arch: none"; fi
        if [[ "$(uname)" == Darwin ]]; then
          # The linker is the authority: every undefined symbol must resolve in the SDK at $MINOS.
          sim=""; sdk=iphoneos
          [[ "$id" == *simulator ]] && { sim="-simulator"; sdk=iphonesimulator; }
          if xcrun --sdk "$sdk" clang -target "$arch-apple-ios$MINOS$sim" -dynamiclib -o "$tmp/link.dylib" \
            -Wl,-all_load "$thin" -framework CoreML -framework CoreVideo -framework Accelerate \
            -framework Foundation -lc++ 2>"$tmp/ld.err"; then
            pass undefined "$id/$arch: $(grep -c . <<<"$undefs" || true) symbols, all resolved by the iOS $MINOS SDK"
          else
            unresolved="$(grep -o '"[^"]*", referenced' "$tmp/ld.err" | cut -d'"' -f2 | awk 'NR<=8' | tr '\n' ' ' || true)"
            fail undefined "$id/$arch: link against the iOS $MINOS SDK failed: ${unresolved:-$(tr '\n' ' ' <"$tmp/ld.err" | cut -c1-200)}"
          fi
        else
          unknown="$(grep -v '^_OBJC_CLASS_\$' <<<"$undefs" | grep -vE -f <(grep -E '^\^' "$HERE/ios-undefined-allow.txt") || true)"
          if [[ -n "$unknown" ]]; then
            fail undefined "$id/$arch: $(grep -c . <<<"$unknown") not in ios-undefined-allow.txt: $(awk 'NR<=8' <<<"$unknown" | tr '\n' ' ')"
          else
            pass undefined "$id/$arch: $(grep -c . <<<"$undefs" || true) symbols, all in ios-undefined-allow.txt"
          fi
        fi
      else
        fail objc "$id/$arch: nm -u failed: $(tr '\n' ' ' <"$tmp/nm.err" | cut -c1-120)"
        fail undefined "$id/$arch: nm -u failed"
      fi

      lc="$("${LOADCMDS[@]}" "$thin" 2>/dev/null)" || fail minos "$id/$arch: could not read load commands"
      if grep -Eq 'segname __LLVM|sectname __bitcode' <<<"$lc"; then
        fail bitcode "$id/$arch: __LLVM/__bitcode present"
      else
        pass bitcode "$id/$arch: none"
      fi

      # minos per LC_BUILD_VERSION, with its platform (otool prints numbers or names).
      bad="$(awk -v want="$MINOS" -v sim="$variant" '
        /cmd LC_BUILD_VERSION/ { inb = 1; n++; next }
        /cmd LC_VERSION_MIN/ { print "legacy " $2; next }
        inb && $1 == "platform" { plat = tolower($2) }
        inb && $1 == "minos" {
          ok_plat = (sim == "simulator") ? (plat == "7" || plat == "iossimulator") : (plat == "2" || plat == "ios")
          if ($2 != want || !ok_plat) print "platform=" plat " minos=" $2
          inb = 0
        }
        END { if (n == 0) print "no LC_BUILD_VERSION" }' <<<"$lc" | LC_ALL=C sort | uniq -c | awk 'NR<=5' | tr -s ' ' | tr '\n' ';')"
      if [[ -n "$bad" ]]; then fail minos "$id/$arch: $bad"; else pass minos "$id/$arch: $MINOS"; fi

      check_amx "$id/$arch" "$arch" "$thin" "$tmp"
    done
  done <<<"$libs"
}

# Self-test: dummy xcframeworks from ptts_stub.c (xcrun clang, or SDK-less LLVM clang), one that
# passes and negatives that each fail exactly the check they target.
selftest() {
  local dir clang ar out expect_out st=0
  dir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$dir'" RETURN
  if [[ "$(uname)" == Darwin ]]; then
    clang=(xcrun clang) ar=(xcrun libtool -static -o)
  else
    clang=("$(find_llvm clang)") ar=("$(find_llvm llvm-ar)" rcs --format=darwin)
    [[ -n "${clang[0]}" && -n "${ar[0]}" ]] || { echo "selftest needs clang and llvm-ar (ANDROID_NDK_HOME)" >&2; exit 2; }
  fi
  cat >"$dir/extra.c" <<'EOF'
#ifdef WITH_EXTRA_EXPORT
__attribute__((visibility("default"))) int phonon_selftest_extra(void) { return 1; }
#endif
#ifdef WITH_RUST_REF
extern int _RNvCs1234_7missing4func(void);
__attribute__((visibility("hidden"))) int phonon_selftest_rust(void) { return _RNvCs1234_7missing4func(); }
#endif
#ifdef WITH_OBJC_REF
extern char OBJC_CLASS_$_MLModel;
__attribute__((visibility("hidden"))) void *phonon_selftest_ref(void) { return &OBJC_CLASS_$_MLModel; }
#endif
__attribute__((visibility("hidden"))) int phonon_selftest_hidden(void) { return 0; }
EOF
  # objs <prefix> <target triple> [clang args]: the objects one architecture's archive holds.
  # The good dummy has one (the shape the ld -r prelink gives); a negative that needs another
  # exported or referenced symbol adds a second.
  objs() {
    local prefix="$1" triple="$2"; shift 2
    local cflags=(-target "$triple" -ffreestanding -O1 -fvisibility=hidden -I "$ROOT/cpp" -c)
    "${clang[@]}" "${cflags[@]}" -o "$prefix.stub.o" "$HERE/ptts_stub.c" "$@"
    echo "$prefix.stub.o"
    if [[ " $* " == *" -DWITH_"* ]]; then
      "${clang[@]}" "${cflags[@]}" -o "$prefix.extra.o" "$dir/extra.c" "$@"
      echo "$prefix.extra.o"
    fi
  }
  # make <name> <device minos> <sim minos> [clang args]: prints the xcframework path.
  make() {
    local name="$1" dmin="$2" smin="$3"; shift 3
    local w="$dir/$name.work" x="$dir/$name/PhononCore.xcframework"
    mkdir -p "$w" "$x/ios-arm64" "$x/ios-arm64_x86_64-simulator"
    # shellcheck disable=SC2046
    "${ar[@]}" "$x/ios-arm64/libptts_ffi.a" $(objs "$w/dev" "arm64-apple-ios$dmin" "$@")
    # shellcheck disable=SC2046
    "${ar[@]}" "$w/sim-arm64.a" $(objs "$w/sim-arm64" "arm64-apple-ios$smin-simulator" "$@")
    # shellcheck disable=SC2046
    "${ar[@]}" "$w/sim-x86_64.a" $(objs "$w/sim-x86_64" "x86_64-apple-ios$smin-simulator" "$@")
    machotool create "$x/ios-arm64_x86_64-simulator/libptts_ffi.a" "$w/sim-arm64.a" "$w/sim-x86_64.a"
    python3 -I - "$x/Info.plist" <<'EOF'
import plistlib, sys
libs = [
    {"BinaryPath": "libptts_ffi.a", "LibraryIdentifier": "ios-arm64", "LibraryPath": "libptts_ffi.a",
     "SupportedArchitectures": ["arm64"], "SupportedPlatform": "ios"},
    {"BinaryPath": "libptts_ffi.a", "LibraryIdentifier": "ios-arm64_x86_64-simulator",
     "LibraryPath": "libptts_ffi.a", "SupportedArchitectures": ["arm64", "x86_64"],
     "SupportedPlatform": "ios", "SupportedPlatformVariant": "simulator"},
]
with open(sys.argv[1], "wb") as f:
    plistlib.dump({"AvailableLibraries": libs, "CFBundlePackageType": "XFWK",
                   "XCFrameworkFormatVersion": "1.0"}, f)
EOF
    echo "$x"
  }
  # expect <xcframework> <pass | check> <name> [--amx-only]: sets expect_out to the output.
  expect() {
    local x="$1" want="$2" name="$3" rc out
    out="$("$0" ${4:+"$4"} "$x" 2>&1)" && rc=0 || rc=$?
    expect_out="$out"
    if [[ "$want" == pass ]]; then
      if ((rc == 0)); then echo "selftest ok: $name passes"; else echo "selftest BROKEN: $name should pass"; echo "$out"; st=1; fi
      return
    fi
    if ((rc != 0)) && grep -q "^FAIL $want:" <<<"$out" && ! grep '^FAIL' <<<"$out" | grep -qv "^FAIL $want:"; then
      echo "selftest ok: $name fails '$want' only"
    else
      echo "selftest BROKEN: $name should fail '$want' and nothing else (rc=$rc)"; echo "$out"; st=1
    fi
  }
  cat >"$dir/amx.h" <<'EOF'
#ifdef __aarch64__
static __attribute__((used)) void phonon_selftest_amx(void) { __asm__(".inst 0x00201000"); }
#endif
EOF
  cat >"$dir/unknown.h" <<'EOF'
#ifdef __aarch64__
static __attribute__((used)) void phonon_selftest_unknown(void) { __asm__(".inst 0x00200c00"); }
#else
static __attribute__((used)) void phonon_selftest_unknown(void) { __asm__(".byte 0x06"); }
#endif
EOF
  local x
  x="$(make good "$MINOS" "$MINOS")"; expect "$x" pass good
  if ! grep -Eq '^PASS amx: ios-arm64/arm64: [1-9][0-9]* instructions' <<<"$expect_out"; then
    echo "selftest BROKEN: good dummy parsed no instructions"; echo "$expect_out"; st=1
  fi
  expect "$x" pass "good (--amx-only)" --amx-only
  x="$(make amx "$MINOS" "$MINOS" -include "$dir/amx.h")"; expect "$x" amx "AMX word"
  if ! grep -Eq '^FAIL amx: ios-arm64/arm64: [1-9][0-9]* AMX words' <<<"$expect_out"; then
    echo "selftest BROKEN: the planted AMX word was not counted"; echo "$expect_out"; st=1
  fi
  expect "$x" amx "AMX word (--amx-only)" --amx-only
  local amx_x="$x" sim="ios-arm64_x86_64-simulator/libptts_ffi.a"
  x="$(make simonly "$MINOS" "$MINOS")"
  machotool thin "$amx_x/$sim" arm64 "$dir/amx-sim-arm64.a"
  machotool thin "$x/$sim" x86_64 "$dir/sim-x86_64.a"
  machotool create "$x/$sim" "$dir/sim-x86_64.a" "$dir/amx-sim-arm64.a"
  expect "$x" amx "AMX word in the second architecture only" --amx-only
  if ! grep -q '^FAIL amx: ios-arm64_x86_64-simulator/arm64: [1-9]' <<<"$expect_out" \
    || ! grep -q '^PASS amx: ios-arm64/arm64' <<<"$expect_out"; then
    echo "selftest BROKEN: not every architecture of a fat library was checked"; echo "$expect_out"; st=1
  fi
  x="$(make good2 "$MINOS" "$MINOS")"
  printf '#!/bin/sh\n"%s" "$@" | tr "\\t" " "\n' "$OBJDUMP" >"$dir/objdump-notab"
  chmod +x "$dir/objdump-notab"
  out="$(LLVM_OBJDUMP="$dir/objdump-notab" "$0" --amx-only "$x" 2>&1 || true)"
  if grep -q '^FAIL amx: ios-arm64/arm64: __text is not empty but 0 instructions parsed' <<<"$out"; then
    echo "selftest ok: unparseable disassembly fails 'amx'"
  else
    echo "selftest BROKEN: unparseable disassembly passed"; echo "$out"; st=1
  fi
  rm "$x/ios-arm64/libptts_ffi.a"
  expect "$x" amx "listed library missing" --amx-only
  x="$(make unknown "$MINOS" "$MINOS" -include "$dir/unknown.h")"; expect "$x" amx "undecodable word"
  if ! grep -Eq '^FAIL amx: ios-arm64/arm64: 0 AMX words, [1-9][0-9]* <unknown>' <<<"$expect_out" \
    || ! grep -Eq '^FAIL amx: ios-arm64_x86_64-simulator/x86_64: 0 AMX words, [1-9][0-9]* <unknown>' <<<"$expect_out"; then
    echo "selftest BROKEN: the planted undecodable words were not counted on arm64 and x86_64"; echo "$expect_out"; st=1
  fi
  x="$(make minos16 16.0 "$MINOS")"; expect "$x" minos "device minos 16.0"
  x="$(make extra "$MINOS" "$MINOS" -DWITH_EXTRA_EXPORT)"
  # Two members per arch: both 'prelinked' and 'exports' must fail, so check each separately.
  out="$("$0" "$x" 2>&1 || true)"
  if grep -q '^FAIL exports:' <<<"$out" && grep -q '^FAIL prelinked:' <<<"$out"; then
    echo "selftest ok: extra export fails 'exports' and 'prelinked'"
  else
    echo "selftest BROKEN: extra export not caught"; echo "$out"; st=1
  fi
  x="$(make objc "$MINOS" "$MINOS" -DWITH_OBJC_REF)"
  out="$("$0" "$x" 2>&1 || true)"
  if grep -q '^FAIL objc:' <<<"$out"; then echo "selftest ok: OBJC_CLASS ref fails 'objc'"; else echo "selftest BROKEN: objc ref not caught"; echo "$out"; st=1; fi
  x="$(make rustref "$MINOS" "$MINOS" -DWITH_RUST_REF)"
  out="$("$0" "$x" 2>&1 || true)"
  # A second member again, so 'prelinked' and 'exports' fail too; 'undefined' must name it.
  if grep -q '^FAIL undefined:.*__RNvCs1234_7missing4func' <<<"$out"; then
    echo "selftest ok: unresolved Rust symbol fails 'undefined'"
  else
    echo "selftest BROKEN: unresolved Rust symbol not caught"; echo "$out"; st=1
  fi
  x="$(make bitcode "$MINOS" "$MINOS" -fembed-bitcode)"; expect "$x" bitcode "embedded bitcode"
  x="$(make headers "$MINOS" "$MINOS")"
  mkdir -p "$x/ios-arm64/Headers" && cp "$ROOT/cpp/ptts.h" "$x/ios-arm64/Headers/"
  expect "$x" layout "headers"
  x="$(make nox86 "$MINOS" "$MINOS")"
  machotool thin "$x/ios-arm64_x86_64-simulator/libptts_ffi.a" arm64 "$x/thin.a"
  mv "$x/thin.a" "$x/ios-arm64_x86_64-simulator/libptts_ffi.a"
  expect "$x" archs "simulator without x86_64"
  return $st
}

case "${1:-}" in
  --selftest) selftest; exit $? ;;
  --amx-only) [[ -n "${2:-}" ]] || { echo "--amx-only <PhononCore.xcframework>" >&2; exit 2; }; verify_amx "$2" ;;
  -h|--help|"") awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 2 ;;
  *) verify "$1" ;;
esac
if ((FAILED)); then echo "verify-ios-xcframework: FAILED"; exit 1; fi
echo "verify-ios-xcframework: OK"
