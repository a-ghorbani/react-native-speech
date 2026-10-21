#!/usr/bin/env bash
# Tests for the Phonon CI scripts (docs/DESIGN.md §4.2, WP8). Linux or macOS; nothing here
# builds the app or needs a device.
#
#   1. verify-apk.sh --selftest (synthetic APKs: good with-add-on / core-only, compressed or
#      misaligned libraries, 4 KB p_align, bad NEEDED, R8-stripped natives, missing ABI, stray
#      ABI, wrong source library, Phonon in a core-only APK)
#   2. check-npm-pack.sh --selftest (required files, forbidden paths, size, core without Phonon)
#   3. ci-emulator-selftest.sh --selftest (logcat checks: results, page size, crashes)
#   4. fetch-ci-model.sh pins the same files as example/src/utils/PhononModelManager.ts, and
#      stage-android-model.sh the same curated voices (WP9 device-lab model staging)
#   5. ci.yml: the core Android / iOS builds know nothing of Phonon, the add-on jobs exist with
#      the design's matrix, steps call scripts that exist, actions are pinned by SHA (needs
#      python3 + PyYAML; skipped otherwise)
#   6. collect-android-evidence.sh --selftest (WP9 device evidence checks on fixtures, dry runs)
#
# Env: ANDROID_NDK_HOME (NDK clang, for 1). Optional real-APK checks:
#   PHONON_APK_ADDON=<apk> [PHONON_APK_ABIS=arm64-v8a,x86_64] [PHONON_APK_LIBDIR=<jniLibs>]
#   PHONON_APK_CORE=<apk of the example without the add-on>
set -euo pipefail
if ((BASH_VERSINFO[0] < 4)); then
  echo "test-ci-scripts.sh needs bash >= 4 (on macOS: brew install bash)" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

FAILS=0
ok() { echo "ok   - $1"; }
not_ok() { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
check() { local name="$1"; shift; if "$@" >"$T/out" 2>&1; then ok "$name"; else not_ok "$name"; sed 's/^/       /' "$T/out"; fi; }
check_fails() { local name="$1"; shift; if "$@" >"$T/out" 2>&1; then not_ok "$name (should have failed)"; sed 's/^/       /' "$T/out"; else ok "$name"; fi; }

echo "# 1. verify-apk.sh"
if [[ -n "${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}" ]]; then
  check "verify-apk.sh --selftest" "$HERE/verify-apk.sh" --selftest
else
  echo "skip - verify-apk.sh --selftest (no ANDROID_NDK_HOME)"
fi
if [[ -n "${PHONON_APK_ADDON:-}" ]]; then
  args=(--apk "$PHONON_APK_ADDON" --phonon on --abis "${PHONON_APK_ABIS:-arm64-v8a}")
  [[ -z "${PHONON_APK_LIBDIR:-}" ]] || args+=(--libdir "$PHONON_APK_LIBDIR")
  check "real with-add-on APK $(basename "$PHONON_APK_ADDON")" "$HERE/verify-apk.sh" "${args[@]}"
  check_fails "real with-add-on APK fails the core-only check" "$HERE/verify-apk.sh" --apk "$PHONON_APK_ADDON" --phonon off
fi
if [[ -n "${PHONON_APK_CORE:-}" ]]; then
  check "real core-only APK $(basename "$PHONON_APK_CORE")" "$HERE/verify-apk.sh" --apk "$PHONON_APK_CORE" --phonon off
  check_fails "real core-only APK fails the with-add-on check" "$HERE/verify-apk.sh" --apk "$PHONON_APK_CORE" --phonon on
fi

echo "# 2. check-npm-pack.sh"
check "check-npm-pack.sh --selftest" "$HERE/check-npm-pack.sh" --selftest

echo "# 3. ci-emulator-selftest.sh"
check "ci-emulator-selftest.sh --selftest" "$HERE/ci-emulator-selftest.sh" --selftest

echo "# 4. fetch-ci-model.sh pins"
check "pins match PhononModelManager.ts CHECKPOINT_31M" python3 - "$REPO/example/src/utils/PhononModelManager.ts" <<EOF
import re, subprocess, sys
src = open(sys.argv[1]).read()
block = src[src.index("const CHECKPOINT_31M"):]
block = block[:block.index("};")]
rev = re.search(r"revision: '([0-9a-f]{40})'", block).group(1)
ts = dict(re.findall(r"path: '([^']+)',\s*size: [0-9_]+,\s*sha256:\s*'([0-9a-f]{64})'", block))
pins = subprocess.run(["$HERE/fetch-ci-model.sh", "--pins"], check=True, capture_output=True, text=True).stdout.split("\n")
sh = dict(l.split() for l in pins if l and not l.startswith("revision"))
sh_rev = next(l.split()[1] for l in pins if l.startswith("revision"))
assert sh_rev == rev, (sh_rev, rev)
assert sh == ts, (sh, ts)
assert len(ts) == 4, ts
EOF

check "stage-android-model.sh voice pins match PHONON_CURATED_VOICES" python3 - "$REPO/example/src/utils/PhononModelManager.ts" <<EOF
import re, subprocess, sys
src = open(sys.argv[1]).read()
block = src[src.index("export const PHONON_CURATED_VOICES"):]
block = block[:block.index("];")]
ts = re.findall(r"name: '([^']+)',\s*voiceId: '([^']+)',.*?sha256: '([0-9a-f]{64})'", block, re.S)
vrev = re.search(r"repo: 'gradium/phonon-voices',\s*revision: '([0-9a-f]{40})'", src).group(1)
pins = subprocess.run(["$HERE/stage-android-model.sh", "--pins"], check=True, capture_output=True, text=True).stdout.split("\n")
sh = [tuple(l.split()) for l in pins if l and not l.startswith("revision")]
sh_rev = next(l.split()[1] for l in pins if l.startswith("revision"))
assert sh_rev == vrev, (sh_rev, vrev)
assert sh == ts, (sh, ts)
assert len(ts) == 8, ts
EOF

echo "# 5. ci.yml"
if python3 -c 'import yaml' 2>/dev/null; then
  check "ci.yml Phonon jobs" python3 - "$REPO/.github/workflows/ci.yml" "$REPO" <<'EOF'
import json, os, re, sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
root = sys.argv[2]
jobs = wf["jobs"]
P = "packages/react-native-speech-phonon"

# The core builds (the example without the add-on) know nothing of Phonon.
for name in ["build-android", "build-ios"]:
    assert "phonon" not in json.dumps(jobs[name]).lower(), name

for name in ["phonon-android-libs", "test-phonon-native", "build-android-phonon",
             "android-emulator-phonon", "build-ios-phonon"]:
    assert name in jobs, name
assert "android-flag-off-size" not in jobs

def runs(job):
    return "\n".join(s.get("run", "") + "\n" + str(s.get("with", {}).get("script", "")) for s in jobs[job]["steps"])

# Every scripts/... path a step runs exists.
for job in jobs:
    for path in re.findall(r"(?<![\w/.$-])((?:packages/[\w-]+/)?scripts/[\w./-]+\.(?:sh|py|gradle))", runs(job)):
        assert os.path.exists(os.path.join(root, path)), f"{job}: {path} missing"

# Actions pinned by commit SHA (local actions excepted).
for job, j in jobs.items():
    for s in j["steps"]:
        u = s.get("uses", "")
        assert not u or u.startswith("./") or re.search(r"@[0-9a-f]{40}$", u), f"{job}: {u} not pinned"

emu = jobs["android-emulator-phonon"]
assert emu["env"]["RN_SPEECH_PHONON"] == "1"
inc = emu["strategy"]["matrix"]["include"]
by = {i["target"]: i for i in inc}
assert set(by) == {"google_apis", "google_apis_ps16k"}, by
assert by["google_apis"]["page-size"] == 4096 and by["google_apis_ps16k"]["page-size"] == 16384
for t, want in (("google_apis", {"S1_support", "S3_short_speak", "S6_stop"}),
                ("google_apis_ps16k", {"S1_support", "S3_short_speak"})):
    assert want <= set(by[t]["require"].split(",")), (t, by[t]["require"])
runner = next(s for s in emu["steps"] if "android-emulator-runner" in s.get("uses", ""))
w = runner["with"]
assert str(w["api-level"]) == "35" and w["arch"] == "x86_64" and w["target"] == "${{ matrix.target }}", w
assert "ci-emulator-selftest.sh" in w["script"] and "${{ matrix.page-size }}" in w["script"], w["script"]
assert emu.get("strategy", {}).get("fail-fast") is False

assert jobs["build-android-phonon"]["env"]["RN_SPEECH_PHONON"] == "1"
on = runs("build-android-phonon")
assert "--configuration-cache" in on and "arm64-v8a,x86_64" in on
assert "rnSpeechCiMinify=true" in on and "verify-apk.sh" in on and "--phonon on" in on

assert "verify-apk.sh --phonon off" in runs("e2e-android")

nat = runs("test-phonon-native")
for s in ["test-core.sh", "test-jni-host.sh", "test-ios.sh", P + "/scripts/test-android.sh", "test-ci-scripts.sh"]:
    assert s in nat, s

lib = runs("build-library")
assert "check-npm-pack.sh --core" in lib and "check-npm-pack.sh --list" in lib

ios = runs("build-ios-phonon")
for s in ["simctl list runtimes", "RN_SPEECH_PHONON=1", "PhononTests", "-all_load", "__LLVM",
          "ios-binary-size.json", "core_test"]:
    assert s in ios, s
assert jobs["build-ios-phonon"]["runs-on"] == "macos-15"
EOF
else
  echo "skip - ci.yml checks (no PyYAML)"
fi

echo "# 6. collect-android-evidence.sh"
check "collect-android-evidence.sh --selftest" "$HERE/collect-android-evidence.sh" --selftest

echo
if ((FAILS)); then echo "$FAILS test(s) failed"; exit 1; fi
echo "all tests passed"
