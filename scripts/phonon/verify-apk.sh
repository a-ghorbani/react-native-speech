#!/usr/bin/env bash
# Verify what an app APK carries of Phonon (docs/phonon/DESIGN.md §3.2, §4.2).
#
# --phonon on (a flag-on build), for each ABI of --abis:
#   libs        lib/<abi>/libptts_ffi.so and lib/<abi>/librnspeech_phonon.so present, plus the
#               libc++_shared.so the shim needs
#   stored      both stored uncompressed at a 16 KB aligned offset (extractNativeLibs=false
#               mmaps them in place; AGP >= 8.5.1 aligns them)
#   align       every PT_LOAD p_align >= 0x4000 in both
#   needed      libptts_ffi.so NEEDED within {libc, libm, libdl, liblog}; the shim within those
#               plus libc++_shared (ANDROID_STL=c++_shared)
#   source      with --libdir: libptts_ffi.so maps the same PT_LOAD bytes as
#               <libdir>/<abi>/libptts_ffi.so (AGP re-strips, so the files themselves differ)
# and once:
#   other-abis  no Phonon library under any ABI outside --abis
#   dex         PhononNative and its native methods survived R8 (the JNI shim binds them by name)
#
# --phonon off (the default build):
#   libs        no libptts_ffi.so / librnspeech_phonon.so under any ABI
#   dex         no PhononNative class (only the not-compiled stub bridge), and the library's
#               classes are found at all (so the scan itself works)
#
# Usage: verify-apk.sh --apk <app.apk> --phonon on|off [--abis arm64-v8a,x86_64]
#                      [--libdir <jniLibs>] [--contents <out.txt>]
#        verify-apk.sh --selftest
# --abis defaults to arm64-v8a (the consumer default). --contents writes the APK's native
# library list (path, size, stored, offset) and dex sizes, for the evidence folder.
# Prints one PASS/FAIL line per check and exits non-zero if any failed.
#
# Tools: python3, READELF if set, else llvm-readelf from $ANDROID_NDK_HOME, else readelf.
set -euo pipefail
if ((BASH_VERSINFO[0] < 4)); then
  echo "verify-apk.sh needs bash >= 4" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

FFI_NEEDED="libc.so libm.so libdl.so liblog.so"
SHIM_NEEDED="$FFI_NEEDED libc++_shared.so"
NATIVE_CLASS="Lcom/pocketpalai/speech/phonon/PhononNative;"
# Every PhononNative method the shim registers is `native`; one is enough to show R8 kept them.
NATIVE_METHOD="nativeLoadLibrary"
LIBRARY_CLASS="Lcom/pocketpalai/speech/RNSpeechModule;"
PAGE=16384

ndk_tool() {
  local name="$1" ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}" p
  if [[ -n "$ndk" ]]; then
    for p in "$ndk"/toolchains/llvm/prebuilt/*/bin/"$name"; do
      [[ -x "$p" ]] && { echo "$p"; return; }
    done
  fi
  command -v "$name" || true
}
READELF="${READELF:-$(ndk_tool llvm-readelf)}"
READELF="${READELF:-$(command -v readelf || true)}"

FAILED=0
pass() { echo "PASS $1: $2"; }
fail() { echo "FAIL $1: $2"; FAILED=1; }

# needed_ok <check> <so> <allowed list>
needed_ok() {
  local check="$1" so="$2" allowed="$3" needed n bad=""
  needed="$("$READELF" -dW "$so" | sed -n 's/.*(NEEDED).*\[\(.*\)\].*/\1/p' | sort | tr '\n' ' ')"
  for n in $needed; do
    [[ " $allowed " == *" $n "* ]] || bad+=" $n"
  done
  if [[ -n "$bad" ]]; then fail "$check" "not allowed:$bad (have: $needed)"; else pass "$check" "${needed% }"; fi
}

# align_ok <check> <so>
align_ok() {
  local check="$1" so="$2" aligns a bad=""
  aligns="$("$READELF" -lW "$so" | awk '$1 == "LOAD" { print $NF }')"
  [[ -n "$aligns" ]] || { fail "$check" "no PT_LOAD segments"; return; }
  for a in $aligns; do
    ((a >= 0x4000)) || bad+=" $a"
  done
  if [[ -n "$bad" ]]; then fail "$check" "PT_LOAD p_align below 0x4000:$bad"; else pass "$check" "$(echo "$aligns" | paste -sd, -)"; fi
}

verify() {
  local apk="$1" mode="$2" abis="$3" libdir="$4" contents="$5"
  local dir info abi lib entry phonon_libs
  [[ -f "$apk" ]] || { echo "no such APK: $apk" >&2; exit 2; }
  dir="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: $dir is local
  trap "rm -rf '$dir'" RETURN
  info="$dir/apk.json"
  python3 "$HERE/apk_inspect.py" "$apk" --extract-dir "$dir/lib" \
    --string "$NATIVE_CLASS" --string "$NATIVE_METHOD" --string "$LIBRARY_CLASS" >"$info"

  if [[ -n "$contents" ]]; then
    mkdir -p "$(dirname "$contents")"
    {
      echo "# $(basename "$apk"): $(jq -r .fileSize "$info") bytes"
      echo "# path size stored dataOffset"
      jq -r '.native[] | "\(.path) \(.size) \(if .stored then "stored" else "deflated" end) \(.dataOffset)"' "$info"
      jq -r '.dex.files[] | "\(.path) \(.size)"' "$info"
      jq -r 'if .js then "\(.js.path) \(.js.size)" else "assets/index.android.bundle absent" end' "$info"
    } >"$contents"
  fi

  echo "== $apk (phonon $mode)"
  phonon_libs="$(jq -r '.native[] | select(.name == "libptts_ffi.so" or .name == "librnspeech_phonon.so") | .path' "$info")"

  if [[ "$mode" == off ]]; then
    if [[ -n "$phonon_libs" ]]; then fail libs "Phonon libraries in a flag-off APK: $(echo "$phonon_libs" | paste -sd' ' -)"; else pass libs "no libptts_ffi.so / librnspeech_phonon.so"; fi
    if [[ "$(jq -r --arg c "$LIBRARY_CLASS" '.strings[$c]' "$info")" != true ]]; then
      fail dex "library class $LIBRARY_CLASS not found: wrong APK or dex scan broken"
    elif [[ "$(jq -r --arg c "$NATIVE_CLASS" '.strings[$c]' "$info")" == true ]]; then
      fail dex "PhononNative is in a flag-off APK"
    else
      pass dex "no PhononNative ($(jq -r .dex.size "$info") dex bytes)"
    fi
    return
  fi

  [[ -n "$READELF" ]] || { echo "no readelf found" >&2; exit 2; }
  for abi in ${abis//,/ }; do
    echo "-- $abi"
    local missing=""
    for lib in libptts_ffi.so librnspeech_phonon.so libc++_shared.so; do
      [[ -f "$dir/lib/$abi/$lib" ]] || missing+=" $lib"
    done
    if [[ -n "$missing" ]]; then fail libs "$abi missing:$missing"; continue; fi
    pass libs "$abi libptts_ffi.so, librnspeech_phonon.so, libc++_shared.so"

    for lib in libptts_ffi.so librnspeech_phonon.so; do
      entry="$(jq -c --arg p "lib/$abi/$lib" '.native[] | select(.path == $p)' "$info")"
      if [[ "$(jq -r .stored <<<"$entry")" != true ]]; then
        fail stored "lib/$abi/$lib is compressed (extractNativeLibs must stay false)"
      elif (($(jq -r .dataOffset <<<"$entry") % PAGE)); then
        fail stored "lib/$abi/$lib data at offset $(jq -r .dataOffset <<<"$entry"), not 16 KB aligned (AGP >= 8.5.1)"
      else
        pass stored "lib/$abi/$lib uncompressed, 16 KB aligned"
      fi
      align_ok align "$dir/lib/$abi/$lib"
    done
    needed_ok needed "$dir/lib/$abi/libptts_ffi.so" "$FFI_NEEDED"
    needed_ok needed "$dir/lib/$abi/librnspeech_phonon.so" "$SHIM_NEEDED"

    if [[ -n "$libdir" ]]; then
      # AGP re-strips packaged libraries: compare what the loader maps, not the bytes.
      local want have
      want="$(python3 "$HERE/apk_inspect.py" --load-digest "$libdir/$abi/libptts_ffi.so" 2>&1)" || want="error: $want"
      have="$(python3 "$HERE/apk_inspect.py" --load-digest "$dir/lib/$abi/libptts_ffi.so" 2>&1)" || have="error: $have"
      if [[ "$want" == "$have" && "$want" != error* ]]; then
        pass source "lib/$abi/libptts_ffi.so loads the same segments as $libdir/$abi/libptts_ffi.so"
      else
        fail source "lib/$abi/libptts_ffi.so differs from $libdir/$abi/libptts_ffi.so ($have vs $want)"
      fi
    fi
  done

  local stray=""
  for entry in $phonon_libs; do
    abi="${entry#lib/}" abi="${abi%%/*}"
    [[ ",$abis," == *",$abi,"* ]] || stray+=" $entry"
  done
  if [[ -n "$stray" ]]; then fail other-abis "Phonon libraries outside --abis ($abis):$stray"; else pass other-abis "none outside $abis"; fi

  if [[ "$(jq -r --arg c "$NATIVE_CLASS" '.strings[$c]' "$info")" != true ]]; then
    fail dex "PhononNative missing from the dex (R8 rule -keep ... PhononNative { native <methods>; })"
  elif [[ "$(jq -r --arg c "$NATIVE_METHOD" '.strings[$c]' "$info")" != true ]]; then
    fail dex "PhononNative.$NATIVE_METHOD missing from the dex (renamed or removed by R8)"
  else
    pass dex "PhononNative with $NATIVE_METHOD"
  fi
}

# Self-test: synthetic AGP-layout APKs with NDK-clang libraries, a good flag-on and flag-off one
# and negatives that must each fail.
selftest() {
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}" clang="" p dir st=0
  if [[ -n "$ndk" ]]; then
    for p in "$ndk"/toolchains/llvm/prebuilt/*/bin/clang; do [[ -x "$p" ]] && clang="$p"; done
  fi
  [[ -n "$clang" ]] || { echo "selftest needs ANDROID_NDK_HOME (NDK clang)" >&2; exit 2; }
  dir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$dir'" RETURN

  echo 'int phonon_selftest(void) { return 1; }' >"$dir/x.c"
  local abi triple
  for abi in arm64-v8a x86_64; do
    case "$abi" in arm64-v8a) triple=aarch64-linux-android24 ;; *) triple=x86_64-linux-android24 ;; esac
    mkdir -p "$dir/good/$abi" "$dir/bad/$abi"
    "$clang" --target="$triple" -shared -fPIC -nostdlib++ -Wl,-z,max-page-size=16384 -llog \
      -o "$dir/good/$abi/libptts_ffi.so" "$dir/x.c"
    "$clang" --target="$triple" -shared -fPIC -nostdlib++ -Wl,-z,max-page-size=16384 -llog -ldl \
      -o "$dir/good/$abi/librnspeech_phonon.so" "$dir/x.c"
    cp "$dir/good/$abi/libptts_ffi.so" "$dir/good/$abi/libc++_shared.so"
    "$clang" --target="$triple" -shared -fPIC -nostdlib++ -Wl,-z,max-page-size=4096 \
      -o "$dir/bad/$abi/libptts_ffi-4k.so" "$dir/x.c"
    # A NEEDED outside the allowed set: link against a library named libz.so.
    "$clang" --target="$triple" -shared -fPIC -nostdlib++ -Wl,-z,max-page-size=16384 -lz \
      -o "$dir/bad/$abi/libptts_ffi-z.so" "$dir/x.c"
  done
  printf 'dex\n035\0%s\0%s\0%s\0' "$NATIVE_CLASS" "$NATIVE_METHOD" "$LIBRARY_CLASS" >"$dir/on.dex"
  printf 'dex\n035\0%s\0' "$LIBRARY_CLASS" >"$dir/off.dex"
  printf 'dex\n035\0%s\0%s\0' "$NATIVE_CLASS" "$LIBRARY_CLASS" >"$dir/r8-stripped.dex"

  # mkapk <out.apk> <dex> [--deflate] [--unaligned] <apk path>=<file>...
  mkapk() { python3 - "$@" <<'EOF'
import sys, zipfile
out, dex, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
deflate = "--deflate" in rest
unaligned = "--unaligned" in rest
entries = [a.split("=", 1) for a in rest if not a.startswith("--")]
with zipfile.ZipFile(out, "w") as z:
    z.write(dex, "classes.dex", zipfile.ZIP_DEFLATED)
    z.writestr("AndroidManifest.xml", b"\0" * 64)
    for name, src in entries:
        data = open(src, "rb").read()
        if name.endswith(".so") and not deflate:
            info = zipfile.ZipInfo(name, date_time=(1981, 1, 1, 1, 1, 2))
            info.compress_type = zipfile.ZIP_STORED
            # Pad the extra field to a 16 KB data boundary like zipalign -P 16 (one byte off for
            # --unaligned).
            pos = z.fp.tell() + 30 + len(name.encode())
            pad = (-(pos + 4)) % 16384 + 4
            if unaligned:
                pad += 1
            info.extra = b"\xd9\xd9" + (pad - 4).to_bytes(2, "little") + b"\0" * (pad - 4)
            z.writestr(info, data)
        else:
            z.write(src, name, zipfile.ZIP_DEFLATED)
EOF
  }
  local g="$dir/good" b="$dir/bad"
  # libs <arm64 libptts_ffi.so> <x86_64 libptts_ffi.so> [abis]: entries for a flag-on APK.
  libs() {
    local abi ffi
    for abi in ${3:-arm64-v8a x86_64}; do
      if [[ "$abi" == arm64-v8a ]]; then ffi="$1"; else ffi="$2"; fi
      echo "lib/$abi/libptts_ffi.so=$ffi"
      echo "lib/$abi/librnspeech_phonon.so=$g/$abi/librnspeech_phonon.so"
      echo "lib/$abi/libc++_shared.so=$g/$abi/libc++_shared.so"
    done
  }
  local on=() on4k=() onz=() onarm=()
  mapfile -t on < <(libs "$g/arm64-v8a/libptts_ffi.so" "$g/x86_64/libptts_ffi.so")
  mapfile -t on4k < <(libs "$g/arm64-v8a/libptts_ffi.so" "$b/x86_64/libptts_ffi-4k.so")
  mapfile -t onz < <(libs "$b/arm64-v8a/libptts_ffi-z.so" "$g/x86_64/libptts_ffi.so")
  mapfile -t onarm < <(libs "$g/arm64-v8a/libptts_ffi.so" - arm64-v8a)
  printf 'dex\n035\0' >"$dir/empty.dex"
  mkapk "$dir/on.apk" "$dir/on.dex" "${on[@]}" "lib/armeabi-v7a/libc++_shared.so=$g/arm64-v8a/libc++_shared.so"
  mkapk "$dir/off.apk" "$dir/off.dex" "lib/arm64-v8a/libc++_shared.so=$g/arm64-v8a/libc++_shared.so"
  mkapk "$dir/on-deflated.apk" "$dir/on.dex" --deflate "${on[@]}"
  mkapk "$dir/on-unaligned.apk" "$dir/on.dex" --unaligned "${on[@]}"
  mkapk "$dir/on-4k.apk" "$dir/on.dex" "${on4k[@]}"
  mkapk "$dir/on-needed.apk" "$dir/on.dex" "${onz[@]}"
  mkapk "$dir/on-r8.apk" "$dir/r8-stripped.dex" "${on[@]}"
  mkapk "$dir/on-nox86.apk" "$dir/on.dex" "${onarm[@]}"
  mkapk "$dir/on-stray.apk" "$dir/on.dex" "${on[@]}" "lib/armeabi-v7a/librnspeech_phonon.so=$g/arm64-v8a/librnspeech_phonon.so"
  mkapk "$dir/off-leak.apk" "$dir/off.dex" "lib/arm64-v8a/libptts_ffi.so=$g/arm64-v8a/libptts_ffi.so"
  mkapk "$dir/off-class.apk" "$dir/on.dex"
  mkapk "$dir/off-nolib.apk" "$dir/empty.dex"
  mkdir -p "$dir/src/arm64-v8a" "$dir/src/x86_64"
  cp "$g/arm64-v8a/libptts_ffi.so" "$dir/src/arm64-v8a/"
  cp "$b/x86_64/libptts_ffi-4k.so" "$dir/src/x86_64/libptts_ffi.so"

  # expect <pass|fail> <failing check or -> <description> <args...>
  expect() {
    local want="$1" check="$2" what="$3" out rc=0
    shift 3
    out="$("$0" "$@" 2>&1)" || rc=$?
    if [[ "$want" == pass && $rc -eq 0 ]] ||
      [[ "$want" == fail && $rc -ne 0 && "$out" == *"FAIL $check:"* ]]; then
      echo "selftest ok: $what"
    else
      echo "selftest FAILED: $what (exit $rc, wanted $want${check:+ on $check})"
      printf '    %s\n' "${out//$'\n'/$'\n'    }"
      st=1
    fi
  }
  local both=(--abis "arm64-v8a,x86_64")
  expect pass - "good flag-on APK" --apk "$dir/on.apk" --phonon on "${both[@]}"
  expect pass - "good flag-off APK" --apk "$dir/off.apk" --phonon off
  expect pass - "flag-on, default ABI" --apk "$dir/on-nox86.apk" --phonon on
  expect fail stored "compressed libraries" --apk "$dir/on-deflated.apk" --phonon on "${both[@]}"
  expect fail stored "library data not 16 KB aligned" --apk "$dir/on-unaligned.apk" --phonon on "${both[@]}"
  expect fail align "4 KB-aligned libptts_ffi.so" --apk "$dir/on-4k.apk" --phonon on "${both[@]}"
  expect fail needed "libptts_ffi.so needs libz.so" --apk "$dir/on-needed.apk" --phonon on "${both[@]}"
  expect fail dex "R8 dropped the native methods" --apk "$dir/on-r8.apk" --phonon on "${both[@]}"
  expect fail libs "x86_64 requested but not packaged" --apk "$dir/on-nox86.apk" --phonon on "${both[@]}"
  expect fail other-abis "shim under armeabi-v7a" --apk "$dir/on-stray.apk" --phonon on "${both[@]}"
  expect fail source "packaged library is not the local one" --apk "$dir/on.apk" --phonon on "${both[@]}" --libdir "$dir/src"
  expect fail libs "libptts_ffi.so in a flag-off APK" --apk "$dir/off-leak.apk" --phonon off
  expect fail dex "PhononNative in a flag-off APK" --apk "$dir/off-class.apk" --phonon off
  expect fail dex "no library classes at all" --apk "$dir/off-nolib.apk" --phonon off
  "$0" --apk "$dir/on.apk" --phonon on "${both[@]}" --contents "$dir/contents.txt" >/dev/null
  if grep -q '^lib/x86_64/libptts_ffi.so [0-9]* stored [0-9]*$' "$dir/contents.txt" && grep -q '^classes.dex ' "$dir/contents.txt"; then
    echo "selftest ok: --contents lists libraries and dex"
  else
    echo "selftest FAILED: --contents"; sed 's/^/    /' "$dir/contents.txt"; st=1
  fi
  return $st
}

APK="" MODE="" ABIS="arm64-v8a" LIBDIR="" CONTENTS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk) APK="$2"; shift 2 ;;
    --phonon) MODE="$2"; shift 2 ;;
    --abis) ABIS="$2"; shift 2 ;;
    --libdir) LIBDIR="$2"; shift 2 ;;
    --contents) CONTENTS="$2"; shift 2 ;;
    --selftest) selftest; exit $? ;;
    -h|--help) awk 'NR > 1 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$APK" ]] || { echo "--apk is required" >&2; exit 2; }
[[ "$MODE" == on || "$MODE" == off ]] || { echo "--phonon on|off is required" >&2; exit 2; }
verify "$APK" "$MODE" "$ABIS" "$LIBDIR" "$CONTENTS"
exit "$FAILED"
