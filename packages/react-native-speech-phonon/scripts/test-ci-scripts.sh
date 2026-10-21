#!/usr/bin/env bash
# Tests for the Phonon CI scripts (docs/DESIGN.md §4.2). Linux or macOS; nothing here
# builds the app or needs a device.
#
#   1. verify-apk.sh --selftest (synthetic APKs)
#   2. check-npm-pack.sh --selftest
#   3. ci-emulator-selftest.sh --selftest (logcat checks on fixtures)
#   4. example/src/utils/phononPins.json is well formed; fetch-ci-model.sh and
#      stage-android-model.sh fetch, verify and cache what a pins file lists (file:// fixtures)
#   5. ci.yml: the core Android / iOS builds know nothing of Phonon, the add-on jobs exist with
#      the design's matrix, steps call scripts that exist, actions are pinned by SHA (needs
#      python3 + PyYAML; skipped otherwise)
#   6. collect-android-evidence.sh --selftest (device evidence checks on fixtures, dry runs)
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

echo "# 4. model pins"
check "phononPins.json is well formed" python3 - "$REPO/example/src/utils/phononPins.json" <<'EOF'
import json, re, sys
p = json.load(open(sys.argv[1]))
hexn = lambda n, v: isinstance(v, str) and re.fullmatch(f"[0-9a-f]{{{n}}}", v)
c, v = p["checkpoint"], p["voices"]
for repo in (c, v):
    assert re.fullmatch(r"[\w.-]+/[\w.-]+", repo["repo"]), repo["repo"]
    assert hexn(40, repo["revision"]), repo["revision"]
paths = [f["path"] for f in c["files"]]
assert paths == ["config.json", "tokenizer.json", "model.q8.gguf", "default-voice.safetensors"], paths
for f in c["files"]:
    assert set(f) == {"path", "size", "sha256"} and type(f["size"]) is int and f["size"] > 0, f
    assert hexn(64, f["sha256"]), f
assert type(v["fileSize"]) is int and v["fileSize"] > 0
keys = {"name", "voiceId", "locale", "gender", "description", "sha256"}
for x in v["curated"]:
    assert set(x) == keys and all(isinstance(x[k], str) and x[k] for k in keys), x
    assert re.fullmatch(r"[A-Z][a-z]+", x["name"]) and re.fullmatch(r"[\w-]{16}", x["voiceId"]), x
    assert hexn(64, x["sha256"]), x
assert len(v["curated"]) == 8
for k in ("name", "voiceId", "sha256"):
    assert len({x[k] for x in v["curated"]}) == 8, k
EOF

# A fake HF tree (file://) and a pins file for it: the scripts' jq reads and checks, offline.
# check() runs these in an `if`, where set -e is off, hence the `|| return 1`.
CK_REV=1111111111111111111111111111111111111111
VO_REV=2222222222222222222222222222222222222222
pins_fixture() {
  local ck="$T/hf/o/ckpt/resolve/$CK_REV" vo="$T/hf/o/voices/resolve/$VO_REV/voices"
  mkdir -p "$ck" "$vo" || return 1
  for f in config.json tokenizer.json model.q8.gguf default-voice.safetensors; do echo "ckpt $f" >"$ck/$f"; done
  for id in aaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbb; do echo "voice $id" >"$vo/$id.safetensors"; done
  python3 - "$ck" "$vo" "$CK_REV" "$VO_REV" >"$T/pins.json" <<'EOF'
import hashlib, json, os, sys
ck, vo, ck_rev, vo_rev = sys.argv[1:]
h = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
files = [{"path": f, "size": os.path.getsize(f"{ck}/{f}"), "sha256": h(f"{ck}/{f}")}
         for f in ["config.json", "tokenizer.json", "model.q8.gguf", "default-voice.safetensors"]]
voices = [{"name": n, "voiceId": i, "locale": "en-us", "gender": "female", "description": "d",
           "sha256": h(f"{vo}/{i}.safetensors")} for n, i in (("Ann", "a" * 16), ("Bob", "b" * 16))]
print(json.dumps({"checkpoint": {"repo": "o/ckpt", "revision": ck_rev, "files": files},
                  "voices": {"repo": "o/voices", "revision": vo_rev, "fileSize": 1, "curated": voices}}))
EOF
}
pins_scripts() {
  pins_fixture || return 1
  local -x PHONON_PINS="$T/pins.json" PHONON_HF_BASE_URL="file://$T/hf"
  local d
  d="$("$HERE/fetch-ci-model.sh" "$T/ci")" || return 1
  [[ "$d" == "$T/ci/phonon-31m-en" ]] || return 1
  cmp "$d/model.q8.gguf" "$T/hf/o/ckpt/resolve/$CK_REV/model.q8.gguf" || return 1
  [[ "$("$HERE/fetch-ci-model.sh" "$T/ci" 2>&1 >/dev/null | grep -c '^cached')" == 4 ]] || return 1
  d="$("$HERE/stage-android-model.sh" "$T/stage" | tail -1)" || return 1
  [[ "$d" == "$T/stage/31m-en" ]] || return 1
  [[ "$(cd "$d" && find . -type f | sort | tr '\n' ' ')" == "./config.json ./default-voice.safetensors ./model.q8.gguf ./tokenizer.json ./voices/Ann.safetensors ./voices/Bob.safetensors " ]] || return 1
  cmp "$d/voices/Bob.safetensors" "$T/hf/o/voices/resolve/$VO_REV/voices/bbbbbbbbbbbbbbbb.safetensors"
}
pins_mismatch() {
  pins_fixture || return 1
  jq '.checkpoint.files[2].sha256 = ("0" * 64)' "$T/pins.json" >"$T/bad.json" || return 1
  if PHONON_PINS="$T/bad.json" PHONON_HF_BASE_URL="file://$T/hf" "$HERE/fetch-ci-model.sh" "$T/bad" 2>"$T/err"; then return 1; fi
  grep -q 'sha256 mismatch for model.q8.gguf' "$T/err" || return 1
  [[ ! -e "$T/bad/phonon-31m-en/model.q8.gguf" && ! -e "$T/bad/phonon-31m-en/model.q8.gguf.part" ]]
}
check "fetch-ci-model.sh / stage-android-model.sh fetch, verify and cache a pins file" pins_scripts
check "fetch-ci-model.sh rejects a file whose sha256 does not match its pin" pins_mismatch

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
