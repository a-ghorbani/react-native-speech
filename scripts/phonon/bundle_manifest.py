"""Rewrite a Core ML bundle's bundle.json after precompile-coreml.sh compiled its packages.

Usage: bundle_manifest.py <bundle dir> <out manifest.tsv> --source <asset> --source-sha256 <sha>
       [--compiler <version>] [--xcode <version>]

1. Checks the upstream bundle.json against the files on disk, for everything that was not
   compiled (the .mlpackage entries are gone by design): each listed file present with its size
   and sha256. Files it does not list (upstream's source.json) are kept.
2. Replaces "files" with every file now in the bundle (the .mlmodelc trees included), in
   upstream's format ({path, size, sha256}, '/'-separated, sorted), and adds a "precompiled"
   record. Every other key (built, dims, voices, ...) is kept: ptts-coreml reads them.
3. Writes the same list as path<TAB>size<TAB>sha256 lines, for the HF mirror upload and the
   app's per-file download.
"""

import argparse
import hashlib
import json
import os
import sys


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def list_files(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in filenames:
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            if rel == "bundle.json" or name == ".DS_Store":
                continue
            out.append({"path": rel, "size": os.path.getsize(path), "sha256": sha256(path)})
    out.sort(key=lambda f: f["path"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle")
    ap.add_argument("manifest")
    ap.add_argument("--source", required=True)
    ap.add_argument("--source-sha256", required=True)
    ap.add_argument("--compiler", default="unknown")
    ap.add_argument("--xcode", default="")
    args = ap.parse_args()

    meta_path = os.path.join(args.bundle, "bundle.json")
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    if not isinstance(meta.get("files"), list):
        sys.exit("bundle.json has no files list")

    now = {f["path"]: f for f in list_files(args.bundle)}
    problems = []
    for f in meta["files"]:
        path = f["path"]
        if path.split("/", 1)[0].endswith(".mlpackage"):
            continue
        got = now.get(path)
        if got is None:
            problems.append("missing " + path)
        elif got["size"] != f["size"] or got["sha256"] != f["sha256"]:
            problems.append("changed " + path)
    # Files the exporter left out of bundle.json (upstream's source.json) are kept and listed.
    upstream = {f["path"] for f in meta["files"]}
    for path in sorted(now):
        top = path.split("/", 1)[0]
        if path not in upstream and not top.endswith(".mlmodelc"):
            print("note: %s is not in the upstream bundle.json; listing it" % path)
    if problems:
        sys.exit("bundle does not match its bundle.json:\n  " + "\n  ".join(problems))

    files = sorted(now.values(), key=lambda f: f["path"])
    if not any(f["path"].split("/", 1)[0].endswith(".mlmodelc") for f in files):
        sys.exit("no .mlmodelc in the bundle")
    meta["files"] = files
    meta["precompiled"] = {
        "source": args.source,
        "sourceSha256": args.source_sha256,
        "coremlcompiler": args.compiler,
        "xcode": args.xcode,
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, sort_keys=True)
        f.write("\n")

    with open(args.manifest, "w", encoding="utf-8") as f:
        for entry in files + [{"path": "bundle.json", "size": os.path.getsize(meta_path),
                               "sha256": sha256(meta_path)}]:
            f.write("%s\t%d\t%s\n" % (entry["path"], entry["size"], entry["sha256"]))
    total = sum(e["size"] for e in files)
    print("bundle.json: %d files, %.1f MB" % (len(files), total / 1e6))


if __name__ == "__main__":
    main()
