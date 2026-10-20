#!/usr/bin/env bash
# Verify a built libptts_ffi.so before it is released (design §2.3, §4.1):
#
#   elf         ELF machine matches the ABI
#   align       every PT_LOAD p_align >= 0x4000 (16 KB pages)
#   needed      DT_NEEDED is a subset of {libc, libm, libdl, liblog}
#   exports     the defined dynamic symbols are exactly the 8 ptts_* of ptts.exp
#   strip       no .symtab and no .debug_* sections
#   paths       no build-machine paths (/home/, /Users/, /runner/) left in the binary
#   size        file size within budget (arm64-v8a 8.5 MB, x86_64 9.5 MB)
#   dotprod     arm64 with +dotprod: sdot/udot are present (the fast q8_0 kernels were built)
#   extensions  arm64: no instruction from an extension that is not in the feature list (except
#               the runtime-gated allowance in arm64-features.sh)
#
# Usage: verify-android-so.sh [--features +dotprod,+fp16] [--max-size BYTES] <abi> <libptts_ffi.so>
#        verify-android-so.sh [--features ...] --jnilibs <dir>   # every <dir>/<abi>/libptts_ffi.so
#        verify-android-so.sh --selftest                         # dummies that must pass / fail
# --features defaults to phonon.lock.json arm64Features. Prints one PASS/FAIL line per check and
# exits non-zero if any failed.
#
# Tools: READELF / OBJDUMP if set, else llvm-readelf / llvm-objdump from $ANDROID_NDK_HOME, else
# from PATH, else GNU readelf / objdump (enough for arm64 disassembly on an arm64 host).
set -euo pipefail
if ((BASH_VERSINFO[0] < 4)); then
  echo "verify-android-so.sh needs bash >= 4" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=arm64-features.sh
source "$HERE/arm64-features.sh"

ALLOWED_NEEDED="libc.so libm.so libdl.so liblog.so"
declare -A BUDGET=([arm64-v8a]=$((85 * 1024 * 1024 / 10)) [x86_64]=$((95 * 1024 * 1024 / 10)))
declare -A MACHINE=([arm64-v8a]=AArch64 [x86_64]="X86-64")

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
OBJDUMP="${OBJDUMP:-$(ndk_tool llvm-objdump)}"
OBJDUMP="${OBJDUMP:-$(command -v objdump || true)}"

expected_exports() {
  sed "s/^_//" "$HERE/ptts.exp" | LC_ALL=C sort
}

FAILED=0
pass() { echo "PASS $1: $2"; }
fail() { echo "FAIL $1: $2"; FAILED=1; }

# verify_one <abi> <so> <features> <max-size>
verify_one() {
  local abi="$1" so="$2" features="$3" max="$4"
  local names machine size aligns bad needed exports extra missing sections leaks
  echo "== $abi $so"
  [[ -f "$so" ]] || { fail elf "$so does not exist"; return; }
  [[ -n "${MACHINE[$abi]+x}" ]] || { fail elf "unknown ABI '$abi'"; return; }
  [[ -n "$READELF" ]] || { echo "no readelf found" >&2; exit 2; }

  machine="$("$READELF" -hW "$so" | sed -n 's/^ *Machine: *//p')"
  case "$abi:$machine" in
    arm64-v8a:AArch64 | x86_64:*X86-64*) pass elf "$machine" ;;
    *) fail elf "machine '$machine' is not ${MACHINE[$abi]}" ;;
  esac

  aligns="$("$READELF" -lW "$so" | awk '$1 == "LOAD" { print $NF }')"
  if [[ -z "$aligns" ]]; then
    fail align "no PT_LOAD segments"
  else
    bad=""
    for a in $aligns; do
      ((a >= 0x4000)) || bad+=" $a"
    done
    if [[ -n "$bad" ]]; then fail align "PT_LOAD p_align below 0x4000:$bad"; else pass align "$(echo "$aligns" | paste -sd, -)"; fi
  fi

  needed="$("$READELF" -dW "$so" | sed -n 's/.*(NEEDED).*\[\(.*\)\].*/\1/p' | sort | tr '\n' ' ')"
  bad=""
  for n in $needed; do
    [[ " $ALLOWED_NEEDED " == *" $n "* ]] || bad+=" $n"
  done
  if [[ -n "$bad" ]]; then fail needed "not allowed:$bad (have: $needed)"; else pass needed "${needed% }"; fi

  # Defined global/weak dynamic symbols, without version suffixes.
  exports="$("$READELF" --dyn-syms -W "$so" |
    awk '$1 ~ /^[0-9]+:$/ && $7 != "UND" && ($5 == "GLOBAL" || $5 == "WEAK") && $8 != "" { sub(/@.*/, "", $8); print $8 }' |
    sort -u)"
  extra="$(LC_ALL=C comm -13 <(expected_exports) <(echo "$exports") | tr '\n' ' ')"
  missing="$(LC_ALL=C comm -23 <(expected_exports) <(echo "$exports") | tr '\n' ' ')"
  if [[ -n "${extra// /}" || -n "${missing// /}" ]]; then
    fail exports "extra: [${extra% }] missing: [${missing% }]"
  else
    pass exports "$(echo "$exports" | wc -l | tr -d ' ') ptts_* symbols"
  fi

  sections="$("$READELF" -SW "$so" | grep -oE '\.(symtab|debug_[a-z_]+)\b' | sort -u | tr '\n' ' ' || true)"
  if [[ -n "${sections// /}" ]]; then fail strip "has ${sections% }"; else pass strip "no .symtab/.debug_*"; fi

  # --remap-path-prefix rewrites source paths to /xn-ptts, /cargo, /build.
  leaks="$(grep -aoE '/(home|Users|runner)/[[:print:]]{0,60}' "$so" | sort -u | awk 'NR<=3' | tr '\n' ' ' || true)"
  if [[ -n "${leaks// /}" ]]; then fail paths "build paths in binary: ${leaks% }"; else pass paths "no build-machine paths"; fi

  size="$(wc -c <"$so" | tr -d ' ')"
  [[ -n "$max" ]] || max="${BUDGET[$abi]}"
  if ((size > max)); then fail size "$size bytes > budget $max"; else pass size "$size bytes <= $max"; fi

  [[ "$abi" == arm64-v8a ]] || return 0
  names="$(phonon_parse_features "$features")" || { fail extensions "bad feature list '$features'"; return; }
  [[ -n "$OBJDUMP" ]] || { echo "no objdump found" >&2; exit 2; }
  scan_arm64 "$so" "$names"
}

# scan_arm64 <so> <enabled feature names>: dotprod presence + disallowed-extension scan.
scan_arm64() {
  local so="$1" enabled=" $2 " name insns="" operands="" fp16=0 report
  for name in "${!PHONON_FEATURE_INSNS[@]}"; do
    [[ "$enabled" == *" $name "* ]] || insns+="${insns:+|}${PHONON_FEATURE_INSNS[$name]}"
  done
  for name in "${!PHONON_FEATURE_OPERANDS[@]}"; do
    [[ "$enabled" == *" $name "* ]] || operands+="${operands:+|}${PHONON_FEATURE_OPERANDS[$name]}"
  done
  [[ "$enabled" == *" fp16 "* ]] || fp16=1

  # One pass over the disassembly: counts of sdot/udot and of every disallowed mnemonic.
  # Runtime-gated mnemonics (arm64-features.sh) are dropped from the report while their count
  # stays within the limit, and listed in the PASS line.
  report="$("$OBJDUMP" -d --no-show-raw-insn "$so" | INSNS="$insns" OPERANDS="$operands" FP16="$fp16" \
    FP16_INSNS="$PHONON_FP16_INSNS" FP16_OPERANDS="$PHONON_FP16_OPERANDS" \
    GATED="${PHONON_GATED_OVERRIDE-$PHONON_RUNTIME_GATED}" perl -ne '
      BEGIN {
        $insns = $ENV{INSNS}; $ops = $ENV{OPERANDS}; $fp16 = $ENV{FP16};
        $fi = $ENV{FP16_INSNS}; $fo = $ENV{FP16_OPERANDS};
        %gated = map { split /=/ } split " ", $ENV{GATED};
      }
      next unless /^\s*[0-9a-f]+:\s+([a-z][a-z0-9.]*)\s*(.*)$/;
      ($m, $o) = ($1, $2);
      $o =~ s{//.*$}{}; $o =~ s{<[^>]*>}{}g;
      $dot++ if $m eq "sdot" || $m eq "udot";
      $total++;
      if (($insns ne "" && $m =~ /^(?:$insns)$/) || ($ops ne "" && $o =~ /$ops/)
          || ($fp16 && $m =~ /^(?:$fi)$/ && $o =~ /$fo/)) { $bad{$m}++; }
      END {
        for (sort keys %bad) {
          if (exists $gated{$_} && $bad{$_} <= $gated{$_}) { push @ok, "$_=$bad{$_}"; delete $bad{$_}; }
        }
        printf "total=%d dot=%d\n", $total, $dot;
        print join(" ", map { "$_=$bad{$_}" } sort keys %bad), "\n";
        print join(" ", @ok), "\n";
      }')"
  local counts bad dot total gated
  counts="$(sed -n 1p <<<"$report")"
  bad="$(sed -n 2p <<<"$report")"
  gated="$(sed -n 3p <<<"$report")"
  total="${counts#*total=}" total="${total%% *}"
  dot="${counts#*dot=}" dot="${dot%% *}"
  if ((total == 0)); then
    fail extensions "objdump produced no instructions (wrong objdump for arm64?)"
    return
  fi
  if [[ "$enabled" == *" dotprod "* ]]; then
    if ((dot > 0)); then pass dotprod "$dot sdot/udot"; else fail dotprod "+dotprod enabled but no sdot/udot found"; fi
  fi
  if [[ -n "${bad// /}" ]]; then
    fail extensions "instructions outside [${2}]: $bad"
  else
    pass extensions "$total instructions, none outside [${2}]${gated:+ (runtime-gated: $gated)}"
  fi
}

# --- selftest ---------------------------------------------------------------------------------
# Builds tiny libraries with the NDK clang: one that must pass every check, and negatives that
# must each fail exactly the check they target.
selftest() {
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}" clang="" p dir out rc st=0
  if [[ -n "$ndk" ]]; then
    for p in "$ndk"/toolchains/llvm/prebuilt/*/bin/clang; do [[ -x "$p" ]] && clang="$p"; done
  fi
  [[ -n "$clang" ]] || { echo "selftest needs ANDROID_NDK_HOME (NDK clang)" >&2; exit 2; }
  dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' RETURN

  cat >"$dir/kernel.c" <<'EOF'
__attribute__((used, visibility("hidden"))) void phonon_selftest_kernel(void) {
  __asm__ volatile("sdot v0.4s, v1.16b, v2.16b" ::: "v0");
#ifdef WITH_LDADD
  __asm__ volatile("ldadd x0, x1, [x2]" ::: "x1", "memory");
#endif
#ifdef WITH_FP16
  __asm__ volatile("fadd h0, h1, h2" ::: "v0");
#endif
#ifdef WITH_CRC
  __asm__ volatile("crc32b w0, w1, w2" ::: "x0");
#endif
#ifdef WITH_STG
  __asm__ volatile("stg x0, [x0]\n\tstg x0, [x0, #16]" ::: "memory");
#endif
#ifdef WITH_SVE
  __asm__ volatile("add z0.s, z1.s, z2.s" ::: "memory");
#endif
}
#ifdef PATH_LEAK
__attribute__((used)) static const char phonon_selftest_path[] = "/home/builder/src/xn/lib.rs";
#endif
#ifdef WITH_EXTRA_EXPORT
__attribute__((visibility("default"))) int phonon_selftest_extra(void) { return 1; }
#endif
EOF
  # build <name> <extra clang args...>
  build() {
    local name="$1"; shift
    "$clang" --target=aarch64-linux-android24 -O1 -shared -fPIC -fvisibility=hidden \
      -march=armv8.2-a+dotprod -I "$ROOT/cpp/phonon" -o "$dir/$name.so" \
      "$HERE/ptts_stub.c" "$dir/kernel.c" "$@"
  }
  # shellcheck disable=SC2054 # one linker flag, commas included
  local strip16=(-s -Wl,-z,max-page-size=16384)
  build good "${strip16[@]}"
  build align4k -s -Wl,-z,max-page-size=4096
  build symtab -Wl,-z,max-page-size=16384
  build ldadd "${strip16[@]}" -march=armv8.2-a+dotprod+lse -DWITH_LDADD
  build sve "${strip16[@]}" -march=armv8.2-a+dotprod+sve -DWITH_SVE
  build fp16 "${strip16[@]}" -march=armv8.2-a+dotprod+fp16 -DWITH_FP16
  build crc "${strip16[@]}" -march=armv8.2-a+dotprod+crc -DWITH_CRC
  build stg "${strip16[@]}" -march=armv8.5-a+dotprod+memtag -DWITH_STG
  build extraexport "${strip16[@]}" -DWITH_EXTRA_EXPORT
  build liblog "${strip16[@]}" -llog -lz
  build pathleak "${strip16[@]}" -DPATH_LEAK

  # expect <name> <expected: pass|check-that-must-fail> [verify args]
  expect() {
    local name="$1" want="$2"; shift 2
    out="$("$0" "$@" arm64-v8a "$dir/$name.so" 2>&1)" && rc=0 || rc=$?
    if [[ "$want" == pass ]]; then
      if ((rc == 0)); then echo "selftest ok: $name passes"; else echo "selftest BROKEN: $name should pass"; echo "$out"; st=1; fi
      return
    fi
    if ((rc != 0)) && grep -q "^FAIL $want:" <<<"$out" && [[ "$(grep -c '^FAIL' <<<"$out")" == 1 ]]; then
      echo "selftest ok: $name fails '$want' only"
    else
      echo "selftest BROKEN: $name should fail '$want' and nothing else (rc=$rc)"; echo "$out"; st=1
    fi
  }
  expect good pass --features +dotprod,+fp16
  expect align4k align --features +dotprod,+fp16
  expect symtab strip --features +dotprod,+fp16
  expect ldadd extensions --features +dotprod,+fp16
  expect ldadd pass --features +dotprod,+fp16,+lse
  expect sve extensions --features +dotprod,+fp16
  expect fp16 extensions --features +dotprod
  expect fp16 pass --features +dotprod,+fp16
  expect crc extensions --features +dotprod,+fp16
  expect crc pass --features +dotprod,+fp16,+crc
  # Two stg: over the stg=1 allowance fails; within an allowance of 2 passes.
  expect stg extensions --features +dotprod,+fp16
  PHONON_GATED_OVERRIDE="stg=2" expect stg pass --features +dotprod,+fp16
  expect good extensions --features +fp16
  expect extraexport exports --features +dotprod,+fp16
  expect liblog needed --features +dotprod,+fp16
  expect pathleak paths --features +dotprod,+fp16
  expect good size --features +dotprod,+fp16 --max-size 100
  return $st
}

FEATURES=""
MAX=""
JNILIBS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --features) FEATURES="$2"; shift 2 ;;
    --max-size) MAX="$2"; shift 2 ;;
    --jnilibs) JNILIBS="$2"; shift 2 ;;
    --selftest) selftest; exit $? ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[[ -n "$FEATURES" ]] || FEATURES="$(jq -er '.arm64Features' "${PHONON_LOCK:-$ROOT/phonon.lock.json}")"

if [[ -n "$JNILIBS" ]]; then
  found=0
  for d in "$JNILIBS"/*/; do
    d="${d%/}"
    abi="$(basename "$d")"
    [[ -f "$d/libptts_ffi.so" ]] || continue
    found=1
    verify_one "$abi" "$d/libptts_ffi.so" "$FEATURES" "$MAX"
  done
  ((found)) || { echo "no <abi>/libptts_ffi.so under $JNILIBS" >&2; exit 1; }
else
  [[ $# -eq 2 ]] || { echo "usage: $0 [--features F] [--max-size N] <abi> <so> | --jnilibs <dir> | --selftest" >&2; exit 2; }
  verify_one "$1" "$2" "$FEATURES" "$MAX"
fi

if ((FAILED)); then echo "verify-android-so: FAILED"; exit 1; fi
echo "verify-android-so: OK"
