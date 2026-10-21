"""The flag-off size gate and the flag-on size report (docs/phonon/DESIGN.md §3.2, §4.2).

Run through apk-size-report.sh (see there for usage). Compares a release APK built at the PR's
merge-base with one built at its head, both with Phonon off, on three metrics:

  native   the set and sizes of lib/**/*.so must be identical and no libptts_ffi.so /
           librnspeech_phonon.so may appear. The app's codegen libraries (libappmodules.so,
           libreact_codegen_*.so) hold the TurboModule JNI glue of every spec method, which the
           phonon* methods add whether the flag is on or not; they are measured separately as
           "codegen" against their own budget instead.
  dex      the library's classes (apkanalyzer `dex packages`, defined size of --dex-package)
           may grow by at most --dex-budget bytes. The total dex delta is reported too; it also
           counts the example app's own code.
  js       the library's minified JS (--js-base-bytes / --js-head-bytes, from
           js-bundle-size.sh) delta, reported against --js-budget (a warning, or a failure with
           --strict-js). Without them, the APKs' assets/index.android.bundle delta stands in
           (it also counts the example app's own JS); it is always reported as "appJsDelta".
           Missing sizes are reported as not measured.

With --flag-on, also records the flag-on APK's file and download size and its Phonon libraries.
Writes everything to --out as JSON and prints a summary; exits 1 if a gate failed.
"""

import argparse
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True  # no __pycache__ in the checkout
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apk_inspect  # noqa: E402

PHONON_LIBS = {"libptts_ffi.so", "librnspeech_phonon.so"}
CODEGEN_RE = re.compile(r"^(libappmodules|libreact_codegen_.*)\.so$")


def apkanalyzer(tool, *args):
    out = subprocess.run([tool, *args], check=True, capture_output=True, text=True)
    return out.stdout


def package_size(tool, apk, package):
    """Defined dex size of one package, from `apkanalyzer dex packages --defined-only`."""
    for line in apkanalyzer(tool, "dex", "packages", "--defined-only", apk).splitlines():
        # P d <classes> <methods-defined> <methods-referenced>... <size> <name>; the size is the
        # second-last column, the package name the last.
        cols = line.split()
        if len(cols) >= 4 and cols[0] == "P" and cols[-1] == package:
            return int(cols[-2])
    return 0


def download_size(tool, apk):
    try:
        return int(apkanalyzer(tool, "apk", "download-size", apk).strip().split()[0])
    except (subprocess.CalledProcessError, ValueError, IndexError):
        return None


def describe(apk, tool, package):
    info = apk_inspect.inspect(apk)
    return {
        "apk": os.path.basename(apk),
        "fileSize": info["fileSize"],
        "downloadSize": download_size(tool, apk) if tool else None,
        "nativeLibs": [{"path": n["path"], "size": n["size"]} for n in info["native"]],
        "dexBytes": info["dex"]["size"],
        "dexPackageBytes": package_size(tool, apk, package) if tool else None,
        "jsBytes": info["js"]["size"] if info["js"] else None,
    }


def compare(base, head, budgets, strict_js, js_sizes=None):
    failures, warnings = [], []
    b = {n["path"]: n["size"] for n in base["nativeLibs"]}
    h = {n["path"]: n["size"] for n in head["nativeLibs"]}

    def codegen(path):
        return bool(CODEGEN_RE.match(path.rsplit("/", 1)[-1]))

    phonon = sorted(p for p in h if p.rsplit("/", 1)[-1] in PHONON_LIBS)
    added = sorted(p for p in h if p not in b and not codegen(p))
    removed = sorted(p for p in b if p not in h and not codegen(p))
    changed = sorted(
        ({"path": p, "base": b[p], "head": h[p]} for p in h if p in b and b[p] != h[p] and not codegen(p)),
        key=lambda c: c["path"])
    native = {"identical": not (added or removed or changed or phonon), "added": added,
              "removed": removed, "changed": changed, "phononLibs": phonon}
    if phonon:
        failures.append(f"native: Phonon libraries in a flag-off APK: {', '.join(phonon)}")
    if added or removed or changed:
        parts = [f"+{p}" for p in added] + [f"-{p}" for p in removed] + \
                [f"{c['path']} {c['base']} -> {c['head']}" for c in changed]
        failures.append("native: libraries differ from the merge-base: " + "; ".join(parts))

    cg_libs = sorted(set(p for p in list(b) + list(h) if codegen(p)))
    cg = [{"path": p, "base": b.get(p, 0), "head": h.get(p, 0)} for p in cg_libs]
    cg_delta = sum(c["head"] - c["base"] for c in cg)
    codegen_result = {"libs": cg, "delta": cg_delta, "budget": budgets["codegen"],
                      "pass": cg_delta <= budgets["codegen"]}
    if not codegen_result["pass"]:
        failures.append(f"codegen: TurboModule glue grew {cg_delta} bytes > {budgets['codegen']}")

    if base["dexPackageBytes"] is None or head["dexPackageBytes"] is None:
        dex_delta = head["dexBytes"] - base["dexBytes"]
        measured = "total dex (no apkanalyzer)"
        warnings.append("dex: apkanalyzer not available, gating on the total dex delta")
    else:
        dex_delta = head["dexPackageBytes"] - base["dexPackageBytes"]
        measured = budgets["dexPackage"]
    dex = {"measured": measured, "delta": dex_delta, "totalDelta": head["dexBytes"] - base["dexBytes"],
           "budget": budgets["dex"], "pass": dex_delta <= budgets["dex"]}
    if not dex["pass"]:
        failures.append(f"dex: {measured} grew {dex_delta} bytes > {budgets['dex']}")

    app_js = None
    if base["jsBytes"] is not None and head["jsBytes"] is not None:
        app_js = head["jsBytes"] - base["jsBytes"]
    if js_sizes:
        measured, d = "library bundle", js_sizes[1] - js_sizes[0]
    else:
        measured, d = "app bundle", app_js
    js = {"measured": measured, "delta": d, "appJsDelta": app_js, "budget": budgets["js"],
          "pass": None if d is None else d <= budgets["js"]}
    if js_sizes:
        js["base"], js["head"] = js_sizes
    if d is None:
        warnings.append("js: no JS bundle sizes (assets/index.android.bundle missing), not measured")
    elif not js["pass"]:
        msg = f"js: {measured} grew {d} bytes > budget {budgets['js']}"
        (failures if strict_js else warnings).append(msg)
    return {"native": native, "codegen": codegen_result, "dex": dex, "js": js}, failures, warnings


def flag_on_report(on, head):
    libs = [n for n in on["nativeLibs"] if n["path"].rsplit("/", 1)[-1] in PHONON_LIBS]
    out = {**on, "phononLibs": libs, "fileSizeDelta": on["fileSize"] - head["fileSize"]}
    if on["downloadSize"] is not None and head["downloadSize"] is not None:
        out["downloadSizeDelta"] = on["downloadSize"] - head["downloadSize"]
    return out


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--base", required=True, help="flag-off APK built at the merge-base")
    p.add_argument("--head", required=True, help="flag-off APK built at the head")
    p.add_argument("--flag-on", help="flag-on APK built at the head (report only)")
    p.add_argument("--out", required=True)
    p.add_argument("--base-ref", default="")
    p.add_argument("--head-ref", default="")
    p.add_argument("--dex-budget", type=int, default=8 * 1024)
    p.add_argument("--dex-package", default="com.pocketpalai.speech")
    p.add_argument("--codegen-budget", type=int, default=8 * 1024)
    p.add_argument("--js-budget", type=int, default=40 * 1024)
    p.add_argument("--strict-js", action="store_true")
    p.add_argument("--js-base-bytes", type=int, help="library bundle size at the merge-base")
    p.add_argument("--js-head-bytes", type=int, help="library bundle size at the head")
    p.add_argument("--apkanalyzer", default="", help="apkanalyzer binary ('' = not available)")
    a = p.parse_args(argv)

    tool = a.apkanalyzer or None
    budgets = {"dex": a.dex_budget, "dexPackage": a.dex_package, "codegen": a.codegen_budget,
               "js": a.js_budget}
    try:
        base = describe(a.base, tool, a.dex_package)
        head = describe(a.head, tool, a.dex_package)
        on = describe(a.flag_on, tool, a.dex_package) if a.flag_on else None
    except (OSError, ValueError, subprocess.CalledProcessError) as e:
        print(f"apk-size-report: {e}", file=sys.stderr)
        return 2
    if (a.js_base_bytes is None) != (a.js_head_bytes is None):
        print("apk-size-report: pass both --js-base-bytes and --js-head-bytes", file=sys.stderr)
        return 2
    js_sizes = (a.js_base_bytes, a.js_head_bytes) if a.js_base_bytes is not None else None
    metrics, failures, warnings = compare(base, head, budgets, a.strict_js, js_sizes)
    report = {
        "mergeBase": a.base_ref, "head": a.head_ref, "budgets": budgets,
        "flagOff": {"base": base, "head": head, **metrics},
        "flagOn": flag_on_report(on, head) if on else None,
        "result": "fail" if failures else "pass", "failures": failures, "warnings": warnings,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write("\n")

    m = metrics
    print(f"native   {'identical' if m['native']['identical'] else 'DIFFERENT'} "
          f"({len(head['nativeLibs'])} libraries)")
    print(f"codegen  {m['codegen']['delta']:+d} bytes (budget {m['codegen']['budget']})")
    print(f"dex      {m['dex']['delta']:+d} bytes in {m['dex']['measured']} (budget {m['dex']['budget']}; "
          f"total dex {m['dex']['totalDelta']:+d})")
    js = m["js"]["delta"]
    app_js = m["js"]["appJsDelta"]
    print(f"js       {'not measured' if js is None else f'{js:+d} bytes'} in {m['js']['measured']} "
          f"(budget {m['js']['budget']}; app bundle "
          f"{'not measured' if app_js is None else f'{app_js:+d}'})")
    if on:
        fo = report["flagOn"]
        print(f"flag-on  file {fo['fileSizeDelta']:+d} bytes"
              + (f", download {fo['downloadSizeDelta']:+d} bytes" if "downloadSizeDelta" in fo else "")
              + "; " + ", ".join(f"{n['path']} {n['size']}" for n in fo["phononLibs"]))
    for w in warnings:
        print(f"WARN {w}")
    for f_ in failures:
        print(f"FAIL {f_}")
    print(f"result: {report['result']} -> {a.out}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
