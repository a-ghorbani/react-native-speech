#!/usr/bin/env bash
# Check that each patch in patches/ (patch-package format, named <pkg>+<version>.patch) still
# applies to that exact package version as published on npm, so the run-termination patch
# consumers copy (docs/USAGE.md) cannot silently rot.
#
# Usage: scripts/check-ort-patch.sh [patch...]   (default: patches/*.patch)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
patches=("$@")
if [[ ${#patches[@]} -eq 0 ]]; then
  patches=("$root"/patches/*.patch)
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

status=0
for patch in "${patches[@]}"; do
  patch=$(cd "$(dirname "$patch")" && pwd)/$(basename "$patch")
  name=$(basename "$patch" .patch)
  pkg=${name%+*}
  version=${name##*+}
  dir="$work/$name"
  mkdir -p "$dir/node_modules/$pkg"
  tarball=$(cd "$dir" && npm pack --silent "$pkg@$version")
  tar -xzf "$dir/$tarball" -C "$dir/node_modules/$pkg" --strip-components=1
  if (cd "$dir" && git apply --check "$patch"); then
    echo "PASS $name applies to $pkg@$version from npm"
  else
    echo "FAIL $name does not apply to $pkg@$version from npm"
    status=1
  fi
done
exit $status
