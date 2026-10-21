"""Describe an APK for verify-apk.sh and apk-size-report.sh (docs/phonon/DESIGN.md §3.2, §4.2).

Usage: apk_inspect.py <apk> [--extract-dir DIR] [--string S ...]
       apk_inspect.py --load-digest <lib.so>

Prints one JSON object:
  fileSize          the APK's size on disk
  native            every lib/<abi>/*.so: {path, abi, name, size, compressedSize, stored,
                    dataOffset} (dataOffset: where the bytes start in the file, which must be
                    16 KB aligned for an uncompressed library to be mmapped in place on 16 KB
                    pages)
  dex               {files: [{path, size}], size}: classes*.dex, uncompressed
  js                {path, size} of assets/index.android.bundle, or null
  strings           {S: true|false}: whether S occurs in any classes*.dex (dex string pool
                    entries are MUTF-8, plain bytes for ASCII names such as class descriptors)

--extract-dir writes every lib/<abi>/*.so to DIR/<abi>/<name> for readelf.

--load-digest prints the sha256 of an ELF file's PT_LOAD segments (their file bytes, in
program-header order, with the ELF header's section-header fields zeroed). AGP re-strips packaged libraries, which rewrites the section headers and
drops non-loaded bytes, so a packaged library is never byte-identical to its source; what the
loader maps is.

Pure stdlib, no Android tools.
"""

import argparse
import hashlib
import json
import os
import re
import struct
import sys
import zipfile

LIB_RE = re.compile(r"^lib/([^/]+)/([^/]+\.so)$")
DEX_RE = re.compile(r"^classes\d*\.dex$")
JS_BUNDLE = "assets/index.android.bundle"


def data_offset(f, info):
    """Offset of the entry's data: local header (30 bytes) + its own name and extra lengths."""
    f.seek(info.header_offset)
    header = f.read(30)
    sig, name_len, extra_len = struct.unpack("<I22xHH", header)
    if sig != 0x04034B50:
        raise ValueError(f"bad local header for {info.filename}")
    return info.header_offset + 30 + name_len + extra_len


def inspect(apk, extract_dir=None, strings=()):
    out = {"fileSize": os.path.getsize(apk), "native": [], "dex": {"files": [], "size": 0},
           "js": None, "strings": {s: False for s in strings}}
    needles = [(s, s.encode("utf-8")) for s in strings]
    with zipfile.ZipFile(apk) as z, open(apk, "rb") as raw:
        for info in sorted(z.infolist(), key=lambda i: i.filename):
            name = info.filename
            m = LIB_RE.match(name)
            if m:
                out["native"].append({
                    "path": name,
                    "abi": m.group(1),
                    "name": m.group(2),
                    "size": info.file_size,
                    "compressedSize": info.compress_size,
                    "stored": info.compress_type == zipfile.ZIP_STORED,
                    "dataOffset": data_offset(raw, info),
                })
                if extract_dir:
                    dest = os.path.join(extract_dir, m.group(1), m.group(2))
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with z.open(info) as src, open(dest, "wb") as dst:
                        while True:
                            block = src.read(1 << 20)
                            if not block:
                                break
                            dst.write(block)
            elif DEX_RE.match(name):
                out["dex"]["files"].append({"path": name, "size": info.file_size})
                out["dex"]["size"] += info.file_size
                if needles:
                    data = z.read(info)
                    for s, b in needles:
                        if b in data:
                            out["strings"][s] = True
            elif name == JS_BUNDLE:
                out["js"] = {"path": name, "size": info.file_size}
    return out


def load_digest(path):
    """sha256 over the file bytes of every PT_LOAD segment of a 64-bit little-endian ELF."""
    with open(path, "rb") as f:
        ident = f.read(64)
        if ident[:4] != b"\x7fELF" or ident[4] != 2 or ident[5] != 1:
            raise ValueError("not a 64-bit little-endian ELF")
        phoff, = struct.unpack_from("<Q", ident, 32)
        phentsize, phnum = struct.unpack_from("<HH", ident, 54)
        h = hashlib.sha256()
        for i in range(phnum):
            f.seek(phoff + i * phentsize)
            p_type, _flags, p_offset, _vaddr, _paddr, p_filesz = struct.unpack("<IIQQQQ", f.read(40))
            if p_type != 1:  # PT_LOAD
                continue
            f.seek(p_offset)
            data = f.read(p_filesz)
            if len(data) != p_filesz:
                raise ValueError("truncated PT_LOAD segment")
            if p_offset < 64:
                # The ELF header is mapped too; strip rewrites its section-header fields
                # (e_shoff at 40, e_shentsize/e_shnum/e_shstrndx at 58..63), the loader never
                # reads them.
                data = bytearray(data)
                for lo, hi in ((40, 48), (58, 64)):
                    for j in range(max(lo - p_offset, 0), max(hi - p_offset, 0)):
                        if j < len(data):
                            data[j] = 0
            h.update(struct.pack("<QQ", p_offset, p_filesz))
            h.update(data)
        return h.hexdigest()


def main(argv):
    if len(argv) == 2 and argv[0] == "--load-digest":
        try:
            print(load_digest(argv[1]))
        except (OSError, ValueError) as e:
            print(f"apk_inspect.py: {argv[1]}: {e}", file=sys.stderr)
            return 2
        return 0

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("apk")
    p.add_argument("--extract-dir")
    p.add_argument("--string", action="append", default=[])
    a = p.parse_args(argv)
    try:
        result = inspect(a.apk, a.extract_dir, a.string)
    except (OSError, zipfile.BadZipFile, ValueError) as e:
        print(f"apk_inspect.py: {a.apk}: {e}", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
