#!/usr/bin/env bash
# Tests for the Phonon binary scripts. Runs on Linux (with an NDK) and macOS; nothing here
# downloads or builds Phonon itself.
#
#   1. gen-hwcaps-header.sh: masks for the lock's features, rejects unknown/disabled features,
#      and the header compiles for both shim ABIs.
#   2. ptts.exp names exactly the functions cpp/ptts.h declares.
#   3. verify-android-so.sh --selftest.
#   4. verify-ios-xcframework.sh --selftest (including a planted AMX word); package-ios.sh refuses
#      to run without slices, notices and licenses.
#   5. package-android.sh is deterministic and lays the zip out as designed (GNU and BSD
#      date/touch/shasum alike).
#   6. precompile-coreml.sh + bundle_manifest.py on a synthetic bundle with a stand-in compiler,
#      and a tampered bundle that must be rejected.
#   7. update-lock.sh: names-only, sums, bad release names, missing assets.
#   8. phonon-binaries.yml: publishing is gated off pull requests, the lock PR has a branch to
#      target on a tag push, a re-run finds its own release, the iOS zip gets the build's
#      SOURCE_DATE_EPOCH, the linters run, an iOS-only run builds iOS from source and carries
#      Android forward (needs python3 + PyYAML; skipped otherwise).
#   9. build-ios.sh: the patch touches exactly xn-gemm's three microkernel.rs, a vendored xn-gemm of
#      another version stops the build at the patch step, and a foreign --vendor-cache is kept.
#  10. carry-android.sh: the previous zip under the new name with the same bytes, and nothing
#      written for a placeholder or mismatched sha256, upstream commit or BUILDINFO.
#  11. check-pinned-ios.sh refuses a placeholder or mismatched sha256, a failed download, a zip
#      without the framework or libraries, and a missing llvm-objdump; release.yml runs it
#      before the add-on's release-it.
#
# Needs bash >= 4 (gen-hwcaps-header.sh, verify-android-so.sh); on a Mac, Homebrew's bash (the
# GitHub macOS runners have it first on PATH).
# Env: ANDROID_NDK_HOME (needed for 1, 3, 4 on Linux). Optional PHONON_ANDROID_STAGE=<dir>
# also runs verify-android-so.sh on a real build-android.sh output.
set -euo pipefail
if ((BASH_VERSINFO[0] < 4)); then
  echo "test-scripts.sh needs bash >= 4 (on macOS: brew install bash)" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LOCK="$ROOT/phonon.lock.json"
REPO="$(cd "$ROOT/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

FAILS=0
ok() { echo "ok   - $1"; }
not_ok() { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
check() { local name="$1"; shift; if "$@" >"$T/out" 2>&1; then ok "$name"; else not_ok "$name"; sed 's/^/       /' "$T/out"; fi; }
check_fails() { local name="$1"; shift; if "$@" >"$T/out" 2>&1; then not_ok "$name (should have failed)"; sed 's/^/       /' "$T/out"; else ok "$name"; fi; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

ndk_clang() {
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}" p
  [[ -n "$ndk" ]] || return 1
  for p in "$ndk"/toolchains/llvm/prebuilt/*/bin/clang; do [[ -x "$p" ]] && { echo "$p"; return 0; }; done
  return 1
}

echo "# 1. gen-hwcaps-header.sh"
features="$(jq -er '.arm64Features' "$LOCK")"
check "header for lock features ($features)" "$HERE/gen-hwcaps-header.sh" "$features" "$T/h/phonon_required_hwcaps.h"
check "header names the feature string" grep -q "#define PHONON_ARM64_FEATURES \"$features\"" "$T/h/phonon_required_hwcaps.h"
check_fails "unknown feature rejected" "$HERE/gen-hwcaps-header.sh" "+dotprod,+warpdrive" "$T/h/bad.h"
check_fails "disabled feature rejected" "$HERE/gen-hwcaps-header.sh" "+dotprod,-fp16" "$T/h/bad.h"
check "empty feature list gives empty masks" "$HERE/gen-hwcaps-header.sh" "" "$T/h0/phonon_required_hwcaps.h"
if clang="$(ndk_clang)"; then
  cat >"$T/h/t.c" <<'EOF'
#include "phonon_required_hwcaps.h"
#if defined(__aarch64__)
_Static_assert(PHONON_REQUIRED_HWCAP == (HWCAP_ASIMDDP | HWCAP_FPHP | HWCAP_ASIMDHP), "hwcap");
_Static_assert(PHONON_REQUIRED_HWCAP2 == 0, "hwcap2");
#define COUNT(w, b, n) +1
_Static_assert((0 PHONON_REQUIRED_HWCAP_LIST(COUNT)) == 3, "list");
#else
_Static_assert(PHONON_REQUIRED_HWCAP == 0 && PHONON_REQUIRED_HWCAP2 == 0, "non-arm64");
#endif
int x;
EOF
  if [[ "$features" == "+dotprod,+fp16" ]]; then
    check "header compiles + masks right (arm64-v8a)" "$clang" --target=aarch64-linux-android24 -I "$T/h" -c "$T/h/t.c" -o "$T/h/a.o"
  fi
  check "header compiles (x86_64)" "$clang" --target=x86_64-linux-android24 -I "$T/h" -c "$T/h/t.c" -o "$T/h/x.o"
  echo 'int x;' >"$T/h0/t.c"
  sed -i.bak '1i\
#include "phonon_required_hwcaps.h"\
_Static_assert(PHONON_REQUIRED_HWCAP == 0, "empty");' "$T/h0/t.c"
  check "empty header compiles (arm64-v8a)" "$clang" --target=aarch64-linux-android24 -I "$T/h0" -c "$T/h0/t.c" -o "$T/h0/a.o"
else
  echo "skip - header compile checks (no ANDROID_NDK_HOME)"
fi

echo "# 2. ptts.exp vs ptts.h"
declared="$(grep -oE '\bptts_[a-z_]+\(' "$ROOT/cpp/ptts.h" | tr -d '(' | LC_ALL=C sort -u)"
exported="$(sed 's/^_//' "$HERE/ptts.exp" | LC_ALL=C sort -u)"
check "ptts.exp == ptts.h functions" test "$declared" == "$exported"
check "8 symbols" test "$(grep -c . <<<"$exported")" == 8
stubbed="$(grep -oE 'PTTS_STUB_EXPORT [^(]*\bptts_[a-z_]+\(' "$HERE/ptts_stub.c" | grep -oE 'ptts_[a-z_]+' | LC_ALL=C sort -u)"
check "ptts_stub.c defines all 8" test "$stubbed" == "$exported"

echo "# 3. verify-android-so.sh --selftest"
if ndk_clang >/dev/null; then
  check "android verifier self-test" "$HERE/verify-android-so.sh" --selftest
  if [[ -n "${PHONON_ANDROID_STAGE:-}" ]]; then
    check "real build passes verification" "$HERE/verify-android-so.sh" --jnilibs "$PHONON_ANDROID_STAGE/jniLibs"
  fi
else
  echo "skip - android verifier self-test (no ANDROID_NDK_HOME)"
fi

echo "# 4. verify-ios-xcframework.sh --selftest"
if [[ "$(uname)" == Darwin ]] || ndk_clang >/dev/null; then
  check "ios verifier self-test" "$HERE/verify-ios-xcframework.sh" --selftest
else
  echo "skip - ios verifier self-test (no Xcode, no ANDROID_NDK_HOME)"
fi
mkdir -p "$T/lic" && echo MIT >"$T/lic/xn-ptts-LICENSE-MIT" && echo '# notices' >"$T/ios-notices.md"
check_fails "package-ios.sh without --slices" "$HERE/package-ios.sh" --notices "$T/ios-notices.md" --licenses "$T/lic"
# shellcheck disable=SC2016 # expanded by the inner bash
check "package-ios.sh names the missing slices" bash -c '"$1" --notices "$2" --licenses "$3" 2>&1 | grep -q -- "--slices .* is required"' \
  _ "$HERE/package-ios.sh" "$T/ios-notices.md" "$T/lic"
check_fails "package-ios.sh without --notices" "$HERE/package-ios.sh" --slices "$T/nothing" --licenses "$T/lic"
check_fails "package-ios.sh without --licenses" "$HERE/package-ios.sh" --slices "$T/nothing" --notices "$T/ios-notices.md"
# shellcheck disable=SC2016 # expanded by the inner bash
check "package-ios.sh names the missing licenses" bash -c '"$1" --slices "$4" --notices "$2" --licenses "$3" 2>&1 | grep -q -- "--licenses .* is required"' \
  _ "$HERE/package-ios.sh" "$T/ios-notices.md" "$T/nothing" "$T/nothing"

echo "# 5. package-android.sh"
stage="$T/stage"
mkdir -p "$stage/jniLibs/arm64-v8a" "$stage/jniLibs/x86_64" "$stage/include" "$stage/licenses"
printf 'arm64' >"$stage/jniLibs/arm64-v8a/libptts_ffi.so"
printf 'x86_64' >"$stage/jniLibs/x86_64/libptts_ffi.so"
cp "$ROOT/cpp/ptts.h" "$stage/include/"
cp "$T/h/phonon_required_hwcaps.h" "$stage/include/"
echo MIT >"$stage/licenses/xn-ptts-LICENSE-MIT"
echo APACHE >"$stage/licenses/xn-ptts-LICENSE-APACHE"
echo '{"sourceDateEpoch": 1792492521}' >"$stage/BUILDINFO.json"
echo '# notices' >"$T/notices.md"
asset="$(jq -er '.binaries.android.asset' "$LOCK")"
check "package (1st)" "$HERE/package-android.sh" --stage "$stage" --notices "$T/notices.md" --out-dir "$T/d1"
touch "$stage/include/ptts.h" # a newer mtime must not change the zip
check "package (2nd)" "$HERE/package-android.sh" --stage "$stage" --notices "$T/notices.md" --out-dir "$T/d2"
check "zips are byte-identical" cmp "$T/d1/$asset" "$T/d2/$asset"
check "SHA256SUMS line" grep -qx "$(sha "$T/d1/$asset")  $asset" "$T/d1/SHA256SUMS"
want="BUILDINFO.json
THIRD_PARTY_NOTICES.md
include/phonon_required_hwcaps.h
include/ptts.h
jniLibs/arm64-v8a/libptts_ffi.so
jniLibs/x86_64/libptts_ffi.so
licenses/xn-ptts-LICENSE-APACHE
licenses/xn-ptts-LICENSE-MIT"
check "zip layout" test "$(unzip -Z1 "$T/d1/$asset")" == "$want"
# The macOS spelling: a date without --version that takes -r <epoch>, and no sha256sum.
if [[ "$(uname)" != Darwin ]] && command -v shasum >/dev/null; then
  mkdir -p "$T/bsd"
  for tool in /usr/bin/* /bin/*; do
    n="${tool##*/}"
    [[ "$n" == sha256sum || "$n" == date || -e "$T/bsd/$n" ]] || ln -s "$tool" "$T/bsd/$n" 2>/dev/null || true
  done
  gnudate="$(command -v date)"
  cat >"$T/bsd/date" <<EOF
#!$BASH
[[ "\$1" == --version ]] && exit 1
if [[ "\$1" == -r ]]; then e="\$2"; shift 2; exec "$gnudate" -d "@\$e" "\$@"; fi
exec "$gnudate" "\$@"
EOF
  chmod +x "$T/bsd/date"
  check "package with BSD date and shasum" env PATH="$T/bsd" "$BASH" "$HERE/package-android.sh" \
    --stage "$stage" --notices "$T/notices.md" --out-dir "$T/dbsd"
  check "BSD-path zip is byte-identical" cmp "$T/d1/$asset" "$T/dbsd/$asset"
  check "BSD-path SHA256SUMS identical" cmp "$T/d1/SHA256SUMS" "$T/dbsd/SHA256SUMS"
else
  echo "skip - BSD tool path (on macOS it is the native path; no shasum otherwise)"
fi
check_fails "package refuses an unbuilt stage" "$HERE/package-android.sh" --stage "$T/nothing" --notices "$T/notices.md" --out-dir "$T/d3"

echo "# 6. precompile-coreml.sh"
b="$T/coreml/phonon-test-coreml"
mkdir -p "$b/flow.mlpackage/Data" "$b/mimi.mlpackage/Data" "$b/voices"
echo flow >"$b/flow.mlpackage/Data/model.mlmodel"
echo mimi >"$b/mimi.mlpackage/Data/model.mlmodel"
echo tok >"$b/tokenizer.json"
echo voice >"$b/voices/Sir Bramwell.safetensors"
python3 -I - "$b" <<'EOF'
import hashlib, json, os, sys
root = sys.argv[1]
files = []
for d, _, names in os.walk(root):
    for n in names:
        p = os.path.join(d, n)
        files.append({"path": os.path.relpath(p, root), "size": os.path.getsize(p),
                      "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest()})
json.dump({"built": 123, "dims": {"d": 512}, "files": sorted(files, key=lambda f: f["path"])},
          open(os.path.join(root, "bundle.json"), "w"))
EOF
(cd "$T/coreml" && zip -qr ../bundle.zip phonon-test-coreml)
cat >"$T/fakecompiler" <<'EOF'
#!/usr/bin/env bash
# Stand-in for `xcrun coremlcompiler compile <pkg> <outdir>`.
set -euo pipefail
[[ "$1" == version ]] && { echo "fake-coremlcompiler 1.0"; exit 0; }
[[ "$1" == compile ]] || exit 2
name="$(basename "$2" .mlpackage)"
mkdir -p "$3/$name.mlmodelc/weights"
cp "$2/Data/model.mlmodel" "$3/$name.mlmodelc/model.mil"
echo compiled >"$3/$name.mlmodelc/coremldata.bin"
EOF
chmod +x "$T/fakecompiler"
jq --arg s "$(sha "$T/bundle.zip")" '.upstream.coreml = {asset: "bundle.zip", sha256: $s}' "$LOCK" >"$T/lock-coreml.json"
check "precompile with stand-in compiler" env PHONON_LOCK="$T/lock-coreml.json" \
  "$HERE/precompile-coreml.sh" --zip "$T/bundle.zip" --out-dir "$T/pc" --compiler "$T/fakecompiler"
out="$T/pc/phonon-test-coreml"
check "packages replaced by .mlmodelc" test -d "$out/flow.mlmodelc" -a -d "$out/mimi.mlmodelc" -a ! -e "$out/flow.mlpackage"
check "bundle.json keeps other keys" test "$(jq -c '[.built, .dims.d, .precompiled.source]' "$out/bundle.json")" == '[123,512,"bundle.zip"]'
check "bundle.json lists compiled files" test "$(jq -r '.files[].path' "$out/bundle.json" | tr '\n' ' ')" == \
  "flow.mlmodelc/coremldata.bin flow.mlmodelc/model.mil mimi.mlmodelc/coremldata.bin mimi.mlmodelc/model.mil tokenizer.json voices/Sir Bramwell.safetensors "
# shellcheck disable=SC2016 # expanded by the inner bash
check "manifest matches files on disk" bash -c '
  cd "$1" && while IFS=$'"'"'\t'"'"' read -r p s h; do
    [[ "$(wc -c <"$p" | tr -d " ")" == "$s" ]] || exit 1
    [[ "$( (sha256sum "$p" 2>/dev/null || shasum -a 256 "$p") | cut -d" " -f1)" == "$h" ]] || exit 1
  done <"$2"' _ "$out" "$T/pc/phonon-test-coreml.manifest.tsv"
check "manifest covers bundle.json" grep -q "^bundle.json	" "$T/pc/phonon-test-coreml.manifest.tsv"
check_fails "wrong zip sha256 rejected" "$HERE/precompile-coreml.sh" --zip "$T/bundle.zip" --out-dir "$T/pc2" --compiler "$T/fakecompiler"
echo tampered >"$b/tokenizer.json"
(cd "$T/coreml" && rm -f ../bad.zip && zip -qr ../bad.zip phonon-test-coreml)
jq --arg s "$(sha "$T/bad.zip")" '.upstream.coreml = {asset: "bad.zip", sha256: $s}' "$LOCK" >"$T/lock-bad.json"
check_fails "file not matching bundle.json rejected" env PHONON_LOCK="$T/lock-bad.json" \
  "$HERE/precompile-coreml.sh" --zip "$T/bad.zip" --out-dir "$T/pc3" --compiler "$T/fakecompiler"

echo "# 7. update-lock.sh"
cp "$LOCK" "$T/lock.json"
check "names only" "$HERE/update-lock.sh" --lock "$T/lock.json" --release phonon-bin-v0.4.0-r7
check "names derived from release" test "$(jq -c '[.binaries.release, .binaries.android.asset, .binaries.ios.asset, .binaries.android.sha256]' "$T/lock.json")" == \
  '["phonon-bin-v0.4.0-r7","phonon-android-0.4.0-r7.zip","phonon-ios-0.4.0-r7.xcframework.zip","PLACEHOLDER"]'
a64="$(printf 'a%.0s' {1..64})" i64="$(printf 'b%.0s' {1..64})"
printf '%s  phonon-android-0.4.0-r7.zip\n%s *phonon-ios-0.4.0-r7.xcframework.zip\n' "$a64" "$i64" >"$T/SUMS"
check "sums" "$HERE/update-lock.sh" --lock "$T/lock.json" --sums "$T/SUMS"
check "sha256s written" test "$(jq -r '.binaries.android.sha256 + " " + .binaries.ios.sha256' "$T/lock.json")" == "$a64 $i64"
check "rest of the lock untouched" test "$(jq -S 'del(.binaries)' "$T/lock.json")" == "$(jq -S 'del(.binaries)' "$LOCK")"
check_fails "release for another upstream tag" "$HERE/update-lock.sh" --lock "$T/lock.json" --release phonon-bin-v0.5.0-r1
check_fails "malformed release" "$HERE/update-lock.sh" --lock "$T/lock.json" --release phonon-bin-v0.4.0
cp "$LOCK" "$T/lock2.json"
check_fails "asset missing from sums" "$HERE/update-lock.sh" --lock "$T/lock2.json" --sums "$T/SUMS"
check "lock unchanged after a failure" cmp "$LOCK" "$T/lock2.json"
check "--only android" "$HERE/update-lock.sh" --lock "$T/lock2.json" --sums "$T/SUMS" --release phonon-bin-v0.4.0-r7 --only android
check "--only leaves ios alone" test "$(jq -r .binaries.ios.sha256 "$T/lock2.json")" == PLACEHOLDER

echo "# 8. phonon-binaries.yml"
if python3 -c 'import yaml' 2>/dev/null; then
  check "publishing is gated" python3 - "$REPO/.github/workflows/phonon-binaries.yml" <<'EOF'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
on = wf.get(True, wf.get("on"))
assert set(on) == {"workflow_dispatch", "push", "pull_request"}, on
assert list(on["push"]) == ["tags"] and on["push"]["tags"] == ["phonon-bin-v*"], on["push"]
assert wf["permissions"] == {"contents": "read"}, wf["permissions"]
jobs = wf["jobs"]
for name, job in jobs.items():
    if name != "publish":
        assert "permissions" not in job, name + " must not raise permissions"
        for step in job["steps"]:
            run = step.get("run", "")
            assert "gh release" not in run and "create-pull-request" not in step.get("uses", ""), name
pub = jobs["publish"]
assert pub["if"] == "needs.meta.outputs.publish == 'true'", pub["if"]
meta = "\n".join(s.get("run", "") for s in jobs["meta"]["steps"])
assert "*) release=" in meta and "publish=false ;;" in meta.split("*) release=")[1], "PRs must not publish"
assert "--latest=false" in "\n".join(s.get("run", "") for s in pub["steps"]), "release must not be Latest"
EOF
  check "lock PR targets a branch, re-runs recover" python3 - "$REPO/.github/workflows/phonon-binaries.yml" <<'EOF'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
jobs = wf["jobs"]
pub = jobs["publish"]
steps = pub["steps"]
names = [s.get("name") for s in steps]
base = pub["env"]["BASE"]
# A tag push is a detached HEAD: BASE falls back to the default branch.
assert "github.ref_type == 'branch'" in base and "github.event.repository.default_branch" in base, base
assert steps[0]["uses"].startswith("actions/checkout@") and steps[0]["with"]["ref"] == "${{ env.BASE }}", steps[0]
cpr = next(s for s in steps if "create-pull-request" in s.get("uses", ""))
assert cpr["with"]["base"] == "${{ env.BASE }}", cpr["with"]
# The lock is updated (and can fail) before anything is published; the PR comes last.
i_lock, i_rel = names.index("Update phonon.lock.json and notices"), names.index("Create release")
assert i_lock < i_rel < names.index(cpr["name"]), names
assert any("upstream.commit" in s.get("run", "") for s in steps[:i_rel]), "base lock not checked"
rel = steps[i_rel]["run"]
assert "gh release download" in rel and "cmp -s" in rel and "exit 0" in rel, "re-run must find its own release"
assert set(pub["needs"]) >= {"meta", "lint", "android", "ios"}, pub["needs"]
EOF
  check "ios zip gets the build's SOURCE_DATE_EPOCH" python3 - "$REPO/.github/workflows/phonon-binaries.yml" "$HERE" <<'EOF'
import sys, yaml
jobs = yaml.safe_load(open(sys.argv[1]))["jobs"]
assert "notices" in jobs["ios"]["needs"]
pkg = open(sys.argv[2] + "/package-ios.sh").read()
assert "EPOCH=\"$(jq -er '.build.sourceDateEpoch' \"$SLICES/BUILDINFO.json\")\"" in pkg
assert "build: {" in open(sys.argv[2] + "/build-ios.sh").read() and "sourceDateEpoch: $epoch" in open(sys.argv[2] + "/build-ios.sh").read()
EOF
  check "linters run on every event" python3 - "$REPO/.github/workflows/phonon-binaries.yml" <<'EOF'
import sys, yaml
lint = yaml.safe_load(open(sys.argv[1]))["jobs"]["lint"]
assert "if" not in lint and "needs" not in lint, lint
run = "\n".join(s.get("run", "") for s in lint["steps"])
assert "sha256sum -c" in run, "actionlint download must be pinned"
assert "actionlint .github/workflows/phonon-binaries.yml" in run and "shellcheck -x packages/react-native-speech-phonon/scripts/*.sh" in run, run
EOF
  check "iOS-only runs carry Android forward" python3 - "$REPO/.github/workflows/phonon-binaries.yml" <<'EOF'
import sys, yaml
text = open(sys.argv[1]).read()
wf = yaml.safe_load(text)
on = wf.get(True, wf.get("on"))
plat = on["workflow_dispatch"]["inputs"]["platforms"]
assert plat["type"] == "choice" and plat["options"] == ["all", "ios"] and plat["default"] == "all", plat
jobs = wf["jobs"]
assert jobs["meta"]["outputs"]["platforms"] == "${{ steps.meta.outputs.platforms }}"
meta = "\n".join(s.get("run", "") for s in jobs["meta"]["steps"])
assert 'platforms="$PLATFORMS"' in meta and "all|ios) ;;" in meta, "meta must pass and validate platforms"
steps = jobs["android"]["steps"]
names = [s.get("name") for s in steps]
i_prev = next(i for i, s in enumerate(steps) if "prev-lock.json" in s.get("run", ""))
assert i_prev < names.index("Use release asset names"), names
carry = next(s for s in steps if "carry-android.sh" in s.get("run", ""))
assert carry["if"] == "needs.meta.outputs.platforms == 'ios'", carry.get("if")
for name in ["Build libptts_ffi.so", "Verify libptts_ffi.so", "Download notices", "Package", "Reproducibility check"]:
    assert steps[names.index(name)].get("if") == "needs.meta.outputs.platforms == 'all'", name
assert "if" not in steps[names.index("Script tests")], "script tests run in every mode"
ios = jobs["ios"]["steps"]
runs = [s.get("run", "") for s in ios]
i_build = next(i for i, r in enumerate(runs) if "build-ios.sh" in r)
i_pkg = next(i for i, r in enumerate(runs) if "package-ios.sh" in r)
assert i_build < i_pkg and '--slices "$RUNNER_TEMP/ios-build"' in runs[i_pkg], "ios: build, then package the slices"
tool = "\n".join(runs[:next(i for i, s in enumerate(ios) if s.get("name") == "Script tests")])
assert "llvm@19" in tool and "LLVM_OBJDUMP=" in tool, "selftest needs LLVM_OBJDUMP"
assert "--upstream-zip" not in text
EOF
else
  echo "skip - workflow checks (no PyYAML)"
fi

echo "# 9. build-ios.sh"
patch_files="$(sed -n 's|^+++ b/||p' "$HERE/patches/xn-gemm-no-amx.patch" | cut -f1 | LC_ALL=C sort | tr '\n' ' ')"
check "patch targets xn-gemm-f{16,32,64} 0.20.2" test "$patch_files" == \
  "xn-gemm-f16-0.20.2/src/microkernel.rs xn-gemm-f32-0.20.2/src/microkernel.rs xn-gemm-f64-0.20.2/src/microkernel.rs "
check_fails "build-ios.sh without --upstream" "$HERE/build-ios.sh" --out "$T/ib"
up="$T/xn-ptts"
mkdir -p "$up/ptts-ffi/include"
cp "$ROOT/cpp/ptts.h" "$up/ptts-ffi/include/ptts.h"
echo '# fixture' >"$up/Cargo.lock"
git -C "$up" init -q
git -C "$up" add -A
git -C "$up" -c user.name=t -c user.email=t@t commit -qm fixture
jq --arg c "$(git -C "$up" rev-parse HEAD)" '.upstream.commit = $c' "$LOCK" >"$T/lock-ios.json"
mkdir -p "$T/vc/xn-gemm-f16-0.21.0/src"
sha "$up/Cargo.lock" >"$T/vc/.complete"
check_fails "another xn-gemm version stops the build" env PHONON_LOCK="$T/lock-ios.json" \
  "$HERE/build-ios.sh" --upstream "$up" --out "$T/ib" --vendor-cache "$T/vc"
cp "$T/out" "$T/ib.err"
check "the failure names xn-gemm-f16-0.20.2" grep -q "patch targets xn-gemm-f16-0.20.2, not in the vendored sources" "$T/ib.err"
mkdir -p "$T/vc2" && echo keep >"$T/vc2/mine"
check_fails "a --vendor-cache without .complete is refused" env PHONON_LOCK="$T/lock-ios.json" \
  "$HERE/build-ios.sh" --upstream "$up" --out "$T/ib" --vendor-cache "$T/vc2"
check "and left as it was" test -f "$T/vc2/mine"

echo "# 10. carry-android.sh"
prev="$(jq -er '.binaries.android.asset' "$LOCK")"
commit="$(jq -er '.upstream.commit' "$LOCK")"
mkdir -p "$T/carry/z" "$T/carry/from"
echo "{\"upstream\": {\"commit\": \"$commit\"}}" >"$T/carry/z/BUILDINFO.json"
(cd "$T/carry/z" && zip -qX "$T/carry/from/$prev" BUILDINFO.json)
cp "$T/carry/z/BUILDINFO.json" "$T/carry/from/BUILDINFO-android.json"
jq --arg s "$(sha "$T/carry/from/$prev")" '.binaries.android.sha256 = $s' "$LOCK" >"$T/carry/lock.json"
check "carry forward" "$HERE/carry-android.sh" --lock "$T/carry/lock.json" --release phonon-bin-v0.4.0-r9 \
  --from "$T/carry/from" --out-dir "$T/carry/out"
check "same bytes under the new name" cmp "$T/carry/from/$prev" "$T/carry/out/phonon-android-0.4.0-r9.zip"
check "SHA256SUMS lists it" grep -qx "$(sha "$T/carry/from/$prev")  phonon-android-0.4.0-r9.zip" "$T/carry/out/SHA256SUMS"
check "BUILDINFO-android.json carried" cmp "$T/carry/from/BUILDINFO-android.json" "$T/carry/out/BUILDINFO-android.json"
carry_refuses() {
  local name="$1" lock="$2"
  check_fails "$name" "$HERE/carry-android.sh" --lock "$lock" --release phonon-bin-v0.4.0-r9 \
    --from "$T/carry/from" --out-dir "$T/carry/$name"
  check "$name: nothing written" test ! -e "$T/carry/$name"
}
jq '.binaries.android.sha256 = "PLACEHOLDER"' "$LOCK" >"$T/carry/lock-ph.json"
carry_refuses placeholder "$T/carry/lock-ph.json"
jq --arg s "$(printf 'c%.0s' {1..64})" '.binaries.android.sha256 = $s' "$LOCK" >"$T/carry/lock-sha.json"
carry_refuses sha-mismatch "$T/carry/lock-sha.json"
jq '.upstream.commit = "0000000000000000000000000000000000000000"' "$T/carry/lock.json" >"$T/carry/lock-commit.json"
carry_refuses commit-mismatch "$T/carry/lock-commit.json"
cp "$T/carry/from/BUILDINFO-android.json" "$T/carry/good-info.json"
echo '{}' >"$T/carry/from/BUILDINFO-android.json"
carry_refuses buildinfo-mismatch "$T/carry/lock.json"
cp "$T/carry/good-info.json" "$T/carry/from/BUILDINFO-android.json"

echo "# 11. check-pinned-ios.sh"
pin_lock() { jq --arg s "$2" '.binaries.ios.sha256 = $s' "$LOCK" >"$1"; }
pin_zip() {
  local name="$1" plist="$2" d="$T/pin/$1"
  mkdir -p "$d/PhononCore.xcframework/ios-arm64"
  printf '\xcf\xfa\xed\xfe\x0c\x00\x00\x01' >"$d/PhononCore.xcframework/ios-arm64/libptts_ffi.a"
  python3 -I - "$d/PhononCore.xcframework/Info.plist" "$plist" <<'EOF'
import plistlib, sys
libs = [{"LibraryIdentifier": "ios-arm64", "LibraryPath": "libptts_ffi.a",
         "SupportedArchitectures": ["arm64"], "SupportedPlatform": "ios"}] if sys.argv[2] == "lib" else []
plistlib.dump({"AvailableLibraries": libs}, open(sys.argv[1], "wb"))
EOF
  (cd "$d" && zip -qr "$T/pin/$name.zip" PhononCore.xcframework)
  echo "$T/pin/$name.zip"
}
# pinned_fails <name> <lock> <expected message (ERE)> <command...>
pinned_fails() {
  local name="$1" lock="$2" why="$3"; shift 3
  check_fails "$name" env PHONON_LOCK="$lock" LLVM_OBJDUMP="$T/pin/no-objdump" "$@"
  cp "$T/out" "$T/pin.err"
  check "$name: $why" grep -Eq "$why" "$T/pin.err"
}
mkdir -p "$T/pin"
z="$(pin_zip onelib lib)"
pin_lock "$T/pin/ph.json" PLACEHOLDER
pinned_fails "placeholder sha256 refused" "$T/pin/ph.json" "pins no iOS sha256" "$HERE/check-pinned-ios.sh" --zip "$z"
pin_lock "$T/pin/other.json" "$(printf 'c%.0s' {1..64})"
pinned_fails "sha256 mismatch refused" "$T/pin/other.json" "sha256 [0-9a-f]+, .* pins" "$HERE/check-pinned-ios.sh" --zip "$z"
pin_lock "$T/pin/ok.json" "$(sha "$z")"
pinned_fails "failed download refused" "$T/pin/ok.json" "could not download" env PHONON_RELEASE_BASE_URL="file://$T/pin/nowhere" \
  "$HERE/check-pinned-ios.sh"
pinned_fails "missing llvm-objdump refused" "$T/pin/ok.json" "^FAIL amx: ios-arm64/arm64: .*no-objdump failed" \
  "$HERE/check-pinned-ios.sh" --zip "$z"
check_fails "no llvm-objdump anywhere refused" env PHONON_LOCK="$T/pin/ok.json" LLVM_OBJDUMP= ANDROID_NDK_HOME= \
  ANDROID_NDK_ROOT= PATH="$(dirname "$(command -v jq)"):/usr/bin:/bin" "$HERE/check-pinned-ios.sh" --zip "$z"
cp "$T/out" "$T/pin.err"
check "no llvm-objdump anywhere refused: names it" grep -q '^FAIL amx: ios-arm64/arm64: no llvm-objdump' "$T/pin.err"
z="$(pin_zip nolibs none)"
pin_lock "$T/pin/nolibs.json" "$(sha "$z")"
pinned_fails "framework without libraries refused" "$T/pin/nolibs.json" "no library architectures" "$HERE/check-pinned-ios.sh" --zip "$z"
mkdir -p "$T/pin/empty" && echo x >"$T/pin/empty/x" && (cd "$T/pin/empty" && zip -q "$T/pin/empty.zip" x)
pin_lock "$T/pin/empty.json" "$(sha "$T/pin/empty.zip")"
pinned_fails "zip without the framework refused" "$T/pin/empty.json" "has no PhononCore.xcframework" "$HERE/check-pinned-ios.sh" --zip "$T/pin/empty.zip"
if python3 -c 'import yaml' 2>/dev/null; then
  check "release.yml checks the pinned iOS zip before the add-on release" python3 - "$REPO/.github/workflows/release.yml" <<'EOF'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["release"]["steps"]
names = [s.get("name") for s in steps]
guard = [i for i, s in enumerate(steps) if "check-pinned-ios.sh" in s.get("run", "")]
assert len(guard) == 1, "one guard step"
g = steps[guard[0]]
assert g.get("if") == "env.PACKAGE == 'phonon'", g.get("if")
assert "continue-on-error" not in g, "the guard must fail the release"
assert "shell" not in g and "set +e" not in g["run"], "the guard runs under bash -e"
lines = [l.strip() for l in g["run"].splitlines() if l.strip()]
assert [l for l in lines if "check-pinned-ios.sh" in l] == lines[-1:], "the guard is the step's last command"
assert lines[-1] == "packages/react-native-speech-phonon/scripts/check-pinned-ios.sh", "exit status swallowed: " + lines[-1]
assert "LLVM_OBJDUMP=" in g["run"] and "ndk;" in g["run"] and 'test -x "$LLVM_OBJDUMP"' in g["run"], "pinned objdump"
i_rel = names.index("Release the Phonon add-on")
assert guard[0] < i_rel and steps[i_rel]["if"] == "env.PACKAGE == 'phonon'"
core = steps[names.index("Release")]
assert core["if"] == "env.PACKAGE == 'core'" and "check-pinned-ios" not in core["run"]
EOF
else
  echo "skip - release.yml check (no PyYAML)"
fi

echo
if ((FAILS)); then echo "$FAILS test(s) failed"; exit 1; fi
echo "all tests passed"
