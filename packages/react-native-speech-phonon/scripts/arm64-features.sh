# shellcheck shell=bash disable=SC2034
# The one table of arm64 target features the Phonon build knows about, sourced by
# build-android.sh (to generate phonon_required_hwcaps.h) and verify-android-so.sh (to scan the
# disassembly for instructions of extensions that were not enabled).
#
# Per feature (Rust target-feature name):
#   PHONON_FEATURE_HWCAPS   "<word>:<macro>" pairs from <asm/hwcap.h>; word 1 = AT_HWCAP,
#                           word 2 = AT_HWCAP2. All of them must be set on the device.
#   PHONON_FEATURE_INSNS    a Perl regex matched against the whole mnemonic, for instructions
#                           only that extension adds.
#   PHONON_FEATURE_OPERANDS a Perl regex matched against the operand text (SVE registers).
# A feature in ARM64_FEATURES that is not in this table fails the build: the gate on the phone
# would not know to check it.

# The fp16 pattern is a heuristic: FP arithmetic on h registers or .4h/.8h lanes. The fcvt*
# family is left out because half<->single conversion is base ARMv8.
declare -gA PHONON_FEATURE_HWCAPS=(
  [neon]="1:HWCAP_ASIMD"
  [fp-armv8]="1:HWCAP_FP"
  [dotprod]="1:HWCAP_ASIMDDP"
  [fp16]="1:HWCAP_FPHP 1:HWCAP_ASIMDHP"
  [lse]="1:HWCAP_ATOMICS"
  [rdm]="1:HWCAP_ASIMDRDM"
  [rcpc]="1:HWCAP_LRCPC"
  [rcpc2]="1:HWCAP_ILRCPC"
  [crc]="1:HWCAP_CRC32"
  [aes]="1:HWCAP_AES 1:HWCAP_PMULL"
  [sha2]="1:HWCAP_SHA1 1:HWCAP_SHA2"
  [sha3]="1:HWCAP_SHA3 1:HWCAP_SHA512"
  [fcma]="1:HWCAP_FCMA"
  [jsconv]="1:HWCAP_JSCVT"
  [mte]="2:HWCAP2_MTE"
  [i8mm]="2:HWCAP2_I8MM"
  [bf16]="2:HWCAP2_BF16"
  [sve]="1:HWCAP_SVE"
)

declare -gA PHONON_FEATURE_INSNS=(
  [dotprod]='(sdot|udot)'
  [lse]='(cas|casp|ldadd|ldclr|ldeor|ldset|ldsmax|ldsmin|ldumax|ldumin|swp|stadd|stclr|steor|stset|stsmax|stsmin|stumax|stumin)(a|l|al)?(b|h)?'
  [rdm]='(sqrdmlah|sqrdmlsh)'
  [rcpc]='ldapr(b|h)?'
  [rcpc2]='(ldapur(b|h|sb|sh|sw)?|stlur(b|h)?)'
  [crc]='crc32c?[bhwx]'
  [aes]='aes(e|d|mc|imc)'
  [sha2]='(sha1(c|h|m|p|su0|su1)|sha256(h|h2|su0|su1))'
  [sha3]='(sha512(h|h2|su0|su1)|eor3|rax1|xar|bcax)'
  [fcma]='(fcmla|fcadd)'
  [jsconv]='fjcvtzs'
  [mte]='(irg|gmi|addg|subg|subps?|stz?2?g|stgp|ldg|stz?gm|ldgm)'
  [i8mm]='(smmla|ummla|usmmla|usdot|sudot)'
  [bf16]='(bfdot|bfmmla|bfcvt|bfcvtn|bfcvtn2|bfmlalb|bfmlalt)'
)

declare -gA PHONON_FEATURE_OPERANDS=(
  [sve]='\b[zp]([0-9]|[12][0-9]|3[01])(\.[bhsdq]|/[mz]|\b)'
  [aes]='\.1q\b' # pmull/pmull2 on 64-bit lanes; the .8b form is base NEON
)

# Disabled-extension instructions allowed because their code checks the extension at run time,
# as "<mnemonic>=<max count>" so a new unconditional use still fails.
#   stg=1  the NDK's static libunwind, which tags stack memory only after its own MTE check
PHONON_RUNTIME_GATED="stg=1"

# fp16 needs both a mnemonic and an operand test; verify-android-so.sh special-cases it.
PHONON_FP16_INSNS='f(?!cvt)[a-z0-9]*'
PHONON_FP16_OPERANDS='\bh([0-9]|[12][0-9]|3[01])\b|\.[48]h\b'

# phonon_parse_features "+dotprod,+fp16" -> "dotprod fp16" on stdout. Fails on an unknown feature,
# a disabled (-feature) entry or a malformed one.
phonon_parse_features() {
  local spec="$1" item name items=() out=()
  IFS=',' read -r -a items <<<"$spec"
  for item in ${items[@]+"${items[@]}"}; do
    item="${item//[[:space:]]/}"
    [[ -z "$item" ]] && continue
    if [[ "$item" != +* ]]; then
      echo "arm64 feature '$item' must be written +name (disabling features is not supported)" >&2
      return 1
    fi
    name="${item#+}"
    if [[ -z "${PHONON_FEATURE_HWCAPS[$name]+x}" ]]; then
      echo "unknown arm64 feature '$name': add it to scripts/arm64-features.sh" >&2
      return 1
    fi
    out+=("$name")
  done
  echo "${out[*]+"${out[*]}"}"
}
