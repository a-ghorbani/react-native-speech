#!/usr/bin/env python3
"""
Benchmark Comparison Tool

Compares two canonical benchmark result files and reports regressions.
Reads the canonical format produced by benchmark-ios.sh / benchmark-android.sh.

Usage:
  python3 scripts/benchmark-compare.py --baseline benchmarks/baseline/ios.json --current benchmarks/latest/ios.json
  python3 scripts/benchmark-compare.py --baseline b.json --current c.json --format markdown
  python3 scripts/benchmark-compare.py --baseline b.json --current c.json --format json

Exit codes:
  0 = no regressions above threshold
  1 = at least one metric regressed beyond threshold
"""

import argparse
import json
import sys
from pathlib import Path

# ANSI colors
RED = "\033[91m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"

TIMING_METRICS = [
    ("initMs", "Init", "median", "ms"),
    ("ttfaMs", "TTFA", "median", "ms"),
    ("totalSpeakMs", "Total Speak", "median", "ms"),
    ("releaseMs", "Release", "median", "ms"),
]

MEMORY_METRICS = [
    ("modelMemoryMB", "Model Memory", "mean", "MB"),
    ("inferMemoryMB", "Infer Memory", "mean", "MB"),
]

PEAK_METRICS = [
    ("peakInitMemoryMB", "Peak Init Mem", "MB"),
    ("peakSpeakMemoryMB", "Peak Speak Mem", "MB"),
]


def load_result(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def pct_change(baseline: float, current: float) -> float:
    if baseline == 0:
        return 0.0 if current == 0 else float("inf")
    return ((current - baseline) / baseline) * 100


def format_change(pct: float, threshold: float) -> tuple[str, str]:
    """Returns (formatted string, status)."""
    if pct == float("inf"):
        return "+inf%", "regressed"
    sign = "+" if pct > 0 else ""
    text = f"{sign}{pct:.1f}%"
    if pct > threshold:
        return text, "regressed"
    elif pct < -2.0:  # >2% improvement
        return text, "improved"
    else:
        return text, "ok"


def compare(baseline: dict, current: dict, timing_threshold: float,
            memory_threshold: float) -> list[dict]:
    """Compare two canonical results. Returns list of comparison rows."""
    rows = []

    # Index engines by key
    base_engines = {f"{e['engine']}:{e.get('variant', 'default')}": e
                    for e in baseline.get("engines", [])}
    curr_engines = {f"{e['engine']}:{e.get('variant', 'default')}": e
                    for e in current.get("engines", [])}

    all_keys = sorted(set(list(base_engines.keys()) + list(curr_engines.keys())))

    for key in all_keys:
        base_eng = base_engines.get(key)
        curr_eng = curr_engines.get(key)

        if not base_eng or not curr_eng:
            rows.append({
                "engine": key,
                "metric": "N/A",
                "baseline": "missing" if not base_eng else "present",
                "current": "missing" if not curr_eng else "present",
                "change": "N/A",
                "status": "skipped",
            })
            continue

        base_stats = base_eng.get("stats", {})
        curr_stats = curr_eng.get("stats", {})

        # Timing metrics (use percentile stat)
        for metric_key, label, stat_key, unit in TIMING_METRICS:
            b_stat = base_stats.get(metric_key, {})
            c_stat = curr_stats.get(metric_key, {})
            b_val = b_stat.get(stat_key, 0)
            c_val = c_stat.get(stat_key, 0)
            pct = pct_change(b_val, c_val)
            change_str, status = format_change(pct, timing_threshold)

            rows.append({
                "engine": key,
                "metric": f"{label} ({stat_key})",
                "baseline": f"{b_val}{unit}",
                "current": f"{c_val}{unit}",
                "change": change_str,
                "status": status,
                "pct": pct,
                "threshold": timing_threshold,
                "baseline_val": b_val,
                "current_val": c_val,
            })

        # Memory metrics (use percentile stat)
        for metric_key, label, stat_key, unit in MEMORY_METRICS:
            b_stat = base_stats.get(metric_key, {})
            c_stat = curr_stats.get(metric_key, {})
            b_val = b_stat.get(stat_key, 0)
            c_val = c_stat.get(stat_key, 0)
            pct = pct_change(b_val, c_val)
            change_str, status = format_change(pct, memory_threshold)

            rows.append({
                "engine": key,
                "metric": f"{label} ({stat_key})",
                "baseline": f"{b_val}{unit}",
                "current": f"{c_val}{unit}",
                "change": change_str,
                "status": status,
                "pct": pct,
                "threshold": memory_threshold,
                "baseline_val": b_val,
                "current_val": c_val,
            })

        # Peak memory (scalar values)
        for metric_key, label, unit in PEAK_METRICS:
            b_val = base_eng.get(metric_key, 0) or 0
            c_val = curr_eng.get(metric_key, 0) or 0
            pct = pct_change(b_val, c_val)
            change_str, status = format_change(pct, memory_threshold)

            rows.append({
                "engine": key,
                "metric": label,
                "baseline": f"{b_val}{unit}",
                "current": f"{c_val}{unit}",
                "change": change_str,
                "status": status,
                "pct": pct,
                "threshold": memory_threshold,
                "baseline_val": b_val,
                "current_val": c_val,
            })

    return rows


def print_table(rows: list[dict], baseline_meta: dict, current_meta: dict):
    """Print colored terminal table."""
    print()
    b_sha = baseline_meta.get("commitSha", "?")[:8]
    c_sha = current_meta.get("commitSha", "?")[:8]
    b_device = baseline_meta.get("device", "?")
    c_device = current_meta.get("device", "?")

    print(f"{BOLD}Benchmark Comparison{RESET}")
    print(f"  Baseline: {b_sha} on {b_device}  ({baseline_meta.get('collectedAt', '?')})")
    print(f"  Current:  {c_sha} on {c_device}  ({current_meta.get('collectedAt', '?')})")
    print()

    # Column widths
    w_eng = max(len(r["engine"]) for r in rows) if rows else 10
    w_met = max(len(r["metric"]) for r in rows) if rows else 10
    w_bas = max(len(str(r["baseline"])) for r in rows) if rows else 10
    w_cur = max(len(str(r["current"])) for r in rows) if rows else 10
    w_chg = max(len(str(r["change"])) for r in rows) if rows else 8

    w_eng = max(w_eng, 6)
    w_met = max(w_met, 6)
    w_bas = max(w_bas, 8)
    w_cur = max(w_cur, 7)
    w_chg = max(w_chg, 6)

    header = (f"  {'Engine':<{w_eng}}  {'Metric':<{w_met}}  "
              f"{'Baseline':>{w_bas}}  {'Current':>{w_cur}}  "
              f"{'Change':>{w_chg}}  Status")
    print(f"{DIM}{header}{RESET}")
    print(f"  {'─' * (w_eng + w_met + w_bas + w_cur + w_chg + 20)}")

    prev_engine = None
    has_regression = False

    for r in rows:
        eng_display = r["engine"] if r["engine"] != prev_engine else ""
        prev_engine = r["engine"]
        status = r["status"]

        if status == "regressed":
            color = RED
            marker = "REGRESSED"
            has_regression = True
        elif status == "improved":
            color = GREEN
            marker = "improved"
        elif status == "skipped":
            color = YELLOW
            marker = "skipped"
        else:
            color = DIM
            marker = "ok"

        line = (f"  {eng_display:<{w_eng}}  {r['metric']:<{w_met}}  "
                f"{str(r['baseline']):>{w_bas}}  {str(r['current']):>{w_cur}}  "
                f"{color}{str(r['change']):>{w_chg}}  {marker}{RESET}")
        print(line)

    print()
    if has_regression:
        print(f"{RED}{BOLD}Regressions detected!{RESET}")
    else:
        print(f"{GREEN}No regressions.{RESET}")
    print()


def format_markdown(rows: list[dict], baseline_meta: dict,
                    current_meta: dict) -> str:
    """Generate markdown comparison table."""
    lines = []
    b_sha = baseline_meta.get("commitSha", "?")[:8]
    c_sha = current_meta.get("commitSha", "?")[:8]

    lines.append("## Benchmark Comparison")
    lines.append("")
    lines.append(f"| | Baseline ({b_sha}) | Current ({c_sha}) | |")
    lines.append(f"| Metric | Value | Value | Change |")
    lines.append("|--------|------:|------:|-------:|")

    prev_engine = None
    for r in rows:
        if r["engine"] != prev_engine:
            prev_engine = r["engine"]
            lines.append(f"| **{r['engine']}** | | | |")

        status = r["status"]
        if status == "regressed":
            icon = "🔴"
        elif status == "improved":
            icon = "🟢"
        else:
            icon = ""

        lines.append(
            f"| {r['metric']} | {r['baseline']} | {r['current']} "
            f"| {r['change']} {icon} |"
        )

    has_regression = any(r["status"] == "regressed" for r in rows)
    lines.append("")
    if has_regression:
        lines.append("**Regressions detected.**")
    else:
        lines.append("No regressions.")

    return "\n".join(lines)


def format_json_output(rows: list[dict], baseline_meta: dict,
                       current_meta: dict) -> str:
    """Generate machine-readable JSON diff."""
    output = {
        "baseline": {
            "commitSha": baseline_meta.get("commitSha"),
            "device": baseline_meta.get("device"),
            "collectedAt": baseline_meta.get("collectedAt"),
        },
        "current": {
            "commitSha": current_meta.get("commitSha"),
            "device": current_meta.get("device"),
            "collectedAt": current_meta.get("collectedAt"),
        },
        "hasRegression": any(r["status"] == "regressed" for r in rows),
        "comparisons": [
            {
                "engine": r["engine"],
                "metric": r["metric"],
                "baseline": r.get("baseline_val", r["baseline"]),
                "current": r.get("current_val", r["current"]),
                "changePercent": round(r.get("pct", 0), 1),
                "status": r["status"],
                "threshold": r.get("threshold", 0),
            }
            for r in rows
        ],
    }
    return json.dumps(output, indent=2)


def main():
    parser = argparse.ArgumentParser(
        description="Compare two benchmark result files"
    )
    parser.add_argument("--baseline", required=True,
                        help="Path to baseline result JSON")
    parser.add_argument("--current", required=True,
                        help="Path to current result JSON")
    parser.add_argument("--format", choices=["table", "markdown", "json"],
                        default="table", help="Output format (default: table)")
    parser.add_argument("--threshold-timing", type=float, default=15.0,
                        help="Timing regression threshold in %% (default: 15)")
    parser.add_argument("--threshold-memory", type=float, default=10.0,
                        help="Memory regression threshold in %% (default: 10)")
    args = parser.parse_args()

    baseline = load_result(args.baseline)
    current = load_result(args.current)

    rows = compare(baseline, current, args.threshold_timing,
                   args.threshold_memory)

    if args.format == "table":
        print_table(rows, baseline, current)
    elif args.format == "markdown":
        print(format_markdown(rows, baseline, current))
    elif args.format == "json":
        print(format_json_output(rows, baseline, current))

    has_regression = any(r["status"] == "regressed" for r in rows)
    sys.exit(1 if has_regression else 0)


if __name__ == "__main__":
    main()
