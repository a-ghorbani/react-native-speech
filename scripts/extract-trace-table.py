#!/usr/bin/env python3
"""
Extract a unified table from an Instruments .trace file.

Exports sysmon-process (CPU%, physical memory footprint) and
os-signpost PointsOfInterest events, then joins them on rounded
timestamps to produce a single CSV/table.

Usage:
    python3 scripts/extract-trace-table.py <trace_file> [--granularity 100] [--csv output.csv]

The trace must have been recorded with a template that includes:
  - Activity Monitor (sysmon-process)
  - os_signpost / Points of Interest
"""

import argparse
import csv
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field


# ── xctrace XML parser ──────────────────────────────────────────────

def export_schema(trace_path: str, xpath: str, outfile: str, retries: int = 3) -> bool:
    """Export a schema from the trace to an XML file. Retries on failure."""
    for attempt in range(retries):
        result = subprocess.run(
            ["xctrace", "export", "--input", trace_path, "--xpath", xpath],
            capture_output=True,
        )
        if result.returncode == 0 and len(result.stdout) > 0:
            with open(outfile, "wb") as f:
                f.write(result.stdout)
            return True
        if attempt < retries - 1:
            import time
            time.sleep(1)
    return False


def parse_xctrace_node(node, id_map: dict):
    """
    Parse a single <node> element from xctrace export XML.
    id_map is shared across nodes so refs from earlier nodes resolve.
    Returns (column_mnemonics: list[str], rows: list[dict]).
    """
    schema = node.find("schema")
    if schema is None:
        return [], []

    col_mnemonics = [col.find("mnemonic").text for col in schema.findall("col")]

    def resolve_element(el):
        """Get (fmt, text) from element, resolving refs."""
        ref = el.get("ref")
        if ref is not None:
            return id_map.get(ref, ("", ""))
        eid = el.get("id")
        fmt = el.get("fmt", "")
        text = el.text or ""
        if eid is not None:
            id_map[eid] = (fmt, text)
        return (fmt, text)

    rows = []
    for row_el in node.findall("row"):
        col_idx = 0
        row_data = {}
        for child in row_el:
            if child.tag == "sentinel":
                if col_idx < len(col_mnemonics):
                    row_data[col_mnemonics[col_idx]] = {"fmt": "", "text": ""}
                col_idx += 1
                continue

            fmt, text = resolve_element(child)

            # Resolve nested children into id_map too
            for nested in child:
                resolve_element(nested)
                for nested2 in nested:
                    resolve_element(nested2)

            if col_idx < len(col_mnemonics):
                row_data[col_mnemonics[col_idx]] = {"fmt": fmt, "text": text}
            col_idx += 1

        rows.append(row_data)

    return col_mnemonics, rows


def parse_xctrace_xml(xml_path: str):
    """
    Parse xctrace export XML, resolving id/ref deduplication.
    Returns (column_mnemonics: list[str], rows: list[dict]).
    If the export contains multiple <node> elements (multiple tables
    matching the xpath), all rows are merged (they share the same schema).
    """
    tree = ET.parse(xml_path)
    root = tree.getroot()
    nodes = root.findall(".//node")
    if not nodes:
        return [], []

    id_map = {}
    all_rows = []
    col_mnemonics = []

    for node in nodes:
        cols, rows = parse_xctrace_node(node, id_map)
        if cols and not col_mnemonics:
            col_mnemonics = cols
        all_rows.extend(rows)

    return col_mnemonics, all_rows


def parse_xctrace_xml_per_node(xml_path: str):
    """
    Like parse_xctrace_xml but returns each node's rows separately.
    Returns list of (column_mnemonics, rows) tuples.
    """
    tree = ET.parse(xml_path)
    root = tree.getroot()
    nodes = root.findall(".//node")
    if not nodes:
        return []

    id_map = {}
    results = []
    for node in nodes:
        cols, rows = parse_xctrace_node(node, id_map)
        results.append((cols, rows))

    return results


# ── Data extraction ──────────────────────────────────────────────────

@dataclass
class TimePoint:
    time_ns: int  # nanoseconds from trace start
    time_s: float  # seconds from trace start
    cpu_pct: float = 0.0
    memory_mb: float = 0.0
    poi_name: str = ""
    poi_duration_ms: float = 0.0
    poi_message: str = ""


@dataclass
class POIInterval:
    start_ns: int
    end_ns: int
    name: str
    message: str


def extract_sysmon(xml_path: str) -> list[dict]:
    """Extract time, CPU%, physical memory from sysmon-process."""
    cols, rows = parse_xctrace_xml(xml_path)
    results = []
    for row in rows:
        time_entry = row.get("time", {})
        time_ns_str = time_entry.get("text", "0")
        try:
            time_ns = int(time_ns_str)
        except ValueError:
            continue

        cpu_entry = row.get("cpu-percent", {})
        cpu_text = cpu_entry.get("text", "")
        try:
            cpu_pct = float(cpu_text)
        except ValueError:
            cpu_pct = 0.0

        mem_entry = row.get("memory-physical-footprint", {})
        mem_text = mem_entry.get("text", "")
        try:
            mem_bytes = int(mem_text)
            mem_mb = mem_bytes / (1024 * 1024)
        except ValueError:
            mem_mb = 0.0

        results.append({
            "time_ns": time_ns,
            "cpu_pct": cpu_pct,
            "memory_mb": round(mem_mb, 1),
        })

    return results


def extract_poi_events(xml_path: str) -> list[POIInterval]:
    """
    Extract Points of Interest Begin/End events and pair them into intervals.
    Searches across all <node> elements in the export for our TTS POI events.
    """
    node_tables = parse_xctrace_xml_per_node(xml_path)

    begins = {}  # (name, identifier) -> (time_ns, message)
    intervals = []

    for cols, rows in node_tables:
        for row in rows:
            time_entry = row.get("time", {})
            time_ns_str = time_entry.get("text", "0")
            try:
                time_ns = int(time_ns_str)
            except ValueError:
                continue

            event_type = row.get("event-type", {}).get("fmt", "")
            name = row.get("name", {}).get("fmt", "")
            identifier = row.get("identifier", {}).get("text", "")
            message = row.get("message", {}).get("fmt", "")
            category = row.get("category", {}).get("text", "")
            subsystem = row.get("subsystem", {}).get("text", "")

            # Only include our TTS POI events
            if category != "PointsOfInterest":
                continue
            if subsystem != "com.pocketpalai.speech":
                continue

            key = (name, identifier)

            if event_type == "Begin":
                begins[key] = (time_ns, message)
            elif event_type == "End":
                if key in begins:
                    start_ns, start_msg = begins.pop(key)
                    intervals.append(POIInterval(
                        start_ns=start_ns,
                        end_ns=time_ns,
                        name=name,
                        message=start_msg or message,
                    ))

    intervals.sort(key=lambda x: x.start_ns)
    return intervals


# ── Joining ──────────────────────────────────────────────────────────

def build_unified_table(
    sysmon_data: list[dict],
    poi_intervals: list[POIInterval],
    granularity_ms: int = 100,
) -> list[dict]:
    """
    Build a unified table joining sysmon time-series with POI intervals.
    Each sysmon sample gets POI columns if a POI interval overlaps that time bucket.
    """
    gran_ns = granularity_ms * 1_000_000

    # Build POI lookup: bucket -> list of active POIs
    # For each POI interval, mark all time buckets it overlaps
    poi_by_bucket = defaultdict(list)
    for poi in poi_intervals:
        start_bucket = (poi.start_ns // gran_ns) * gran_ns
        end_bucket = (poi.end_ns // gran_ns) * gran_ns
        bucket = start_bucket
        while bucket <= end_bucket:
            poi_by_bucket[bucket].append(poi)
            bucket += gran_ns

    table = []
    for sample in sysmon_data:
        time_ns = sample["time_ns"]
        bucket = (time_ns // gran_ns) * gran_ns
        time_s = time_ns / 1_000_000_000

        # Find active POIs for this bucket
        active_pois = poi_by_bucket.get(bucket, [])

        cpu_fmt = round(sample["cpu_pct"], 1)

        if active_pois:
            for poi in active_pois:
                dur_ms = (poi.end_ns - poi.start_ns) / 1_000_000
                table.append({
                    "time_s": round(time_s, 2),
                    "time_fmt": format_time(time_ns),
                    "cpu_pct": cpu_fmt,
                    "memory_mb": sample["memory_mb"],
                    "poi_name": poi.name,
                    "poi_start": format_time(poi.start_ns),
                    "poi_duration_ms": round(dur_ms, 1),
                    "poi_message": poi.message,
                })
        else:
            table.append({
                "time_s": round(time_s, 2),
                "time_fmt": format_time(time_ns),
                "cpu_pct": cpu_fmt,
                "memory_mb": sample["memory_mb"],
                "poi_name": "",
                "poi_start": "",
                "poi_duration_ms": "",
                "poi_message": "",
            })

    return table


def format_time(ns: int) -> str:
    """Format nanoseconds as mm:ss.mmm"""
    total_ms = ns // 1_000_000
    minutes = total_ms // 60000
    seconds = (total_ms % 60000) // 1000
    millis = total_ms % 1000
    return f"{minutes:02d}:{seconds:02d}.{millis:03d}"


# ── Main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Extract unified table from Instruments .trace file"
    )
    parser.add_argument("trace", help="Path to .trace file/directory")
    parser.add_argument(
        "--granularity", type=int, default=100,
        help="Time bucket granularity in ms for joining (default: 100)"
    )
    parser.add_argument(
        "--csv", dest="csv_output",
        help="Output CSV file path (default: print to stdout)"
    )
    parser.add_argument(
        "--cache-dir",
        help="Directory with pre-exported XML files (skip xctrace export)"
    )
    args = parser.parse_args()

    trace = args.trace
    if not os.path.exists(trace):
        print(f"ERROR: Trace file not found: {trace}", file=sys.stderr)
        sys.exit(1)

    tmpdir = args.cache_dir or tempfile.mkdtemp(prefix="trace_export_")
    use_cache = args.cache_dir is not None

    # Export sysmon-process
    sysmon_xml = os.path.join(tmpdir, "sysmon.xml")
    if use_cache and os.path.exists(sysmon_xml) and os.path.getsize(sysmon_xml) > 0:
        print("Using cached sysmon-process data.", file=sys.stderr)
    else:
        print("Exporting sysmon-process data...", file=sys.stderr)
        if not export_schema(
            trace,
            '/trace-toc/run/data/table[@schema="sysmon-process" and @target-pid="SINGLE"]',
            sysmon_xml,
        ):
            if not export_schema(
                trace,
                '/trace-toc/run/data/table[@schema="sysmon-process"]',
                sysmon_xml,
            ):
                print("WARNING: Could not export sysmon-process data.", file=sys.stderr)

    # Export all os-signpost tables (POI events are filtered in Python)
    poi_xml = os.path.join(tmpdir, "poi.xml")
    if use_cache and os.path.exists(poi_xml) and os.path.getsize(poi_xml) > 0:
        print("Using cached os-signpost data.", file=sys.stderr)
    else:
        print("Exporting os-signpost data...", file=sys.stderr)
        if not export_schema(
            trace,
            '/trace-toc/run/data/table[@schema="os-signpost"]',
            poi_xml,
        ):
            print("WARNING: Could not export os-signpost data.", file=sys.stderr)

    if not use_cache:
        print(f"Cache dir: {tmpdir}", file=sys.stderr)
        print(f"  Re-run with --cache-dir {tmpdir} to skip export.", file=sys.stderr)

    # Parse data
    sysmon_data = []
    if os.path.exists(sysmon_xml) and os.path.getsize(sysmon_xml) > 0:
        print(f"Parsing sysmon-process...", file=sys.stderr)
        sysmon_data = extract_sysmon(sysmon_xml)
        print(f"  {len(sysmon_data)} samples", file=sys.stderr)

    poi_intervals = []
    if os.path.exists(poi_xml) and os.path.getsize(poi_xml) > 0:
        print(f"Parsing Points of Interest...", file=sys.stderr)
        poi_intervals = extract_poi_events(poi_xml)
        print(f"  {len(poi_intervals)} intervals", file=sys.stderr)

    if not sysmon_data:
        print("ERROR: No sysmon data found in trace.", file=sys.stderr)
        sys.exit(1)

    # Build unified table
    print(f"Joining with {args.granularity}ms granularity...", file=sys.stderr)
    table = build_unified_table(sysmon_data, poi_intervals, args.granularity)

    # Output
    columns = [
        "time_s", "time_fmt", "cpu_pct", "memory_mb",
        "poi_name", "poi_start", "poi_duration_ms", "poi_message",
    ]
    headers = [
        "Time(s)", "Time", "CPU%", "Memory(MB)",
        "POI Name", "POI Start", "POI Dur(ms)", "POI Message",
    ]

    if args.csv_output:
        with open(args.csv_output, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=columns)
            writer.writerow(dict(zip(columns, headers)))
            for row in table:
                writer.writerow(row)
        print(f"Written to {args.csv_output}", file=sys.stderr)
    else:
        # Pretty-print as aligned table
        col_widths = [max(len(h), 8) for h in headers]
        for row in table:
            for i, col in enumerate(columns):
                val = str(row.get(col, ""))
                col_widths[i] = max(col_widths[i], len(val))

        # Print header
        header_line = " | ".join(
            h.ljust(col_widths[i]) for i, h in enumerate(headers)
        )
        print(header_line)
        print("-" * len(header_line))

        # Print rows
        for row in table:
            vals = [str(row.get(col, "")).ljust(col_widths[i])
                    for i, col in enumerate(columns)]
            print(" | ".join(vals))

    # Summary
    print(f"\n--- Summary ---", file=sys.stderr)
    print(f"Sysmon samples: {len(sysmon_data)}", file=sys.stderr)
    print(f"POI intervals:  {len(poi_intervals)}", file=sys.stderr)
    if poi_intervals:
        print(f"\nPoints of Interest:", file=sys.stderr)
        for poi in poi_intervals:
            dur_ms = (poi.end_ns - poi.start_ns) / 1_000_000
            print(
                f"  {format_time(poi.start_ns)} - {format_time(poi.end_ns)} "
                f"({dur_ms:.0f}ms) {poi.name}"
                f"{': ' + poi.message if poi.message else ''}",
                file=sys.stderr,
            )

    if sysmon_data:
        mems = [s["memory_mb"] for s in sysmon_data]
        cpus = [s["cpu_pct"] for s in sysmon_data if s["cpu_pct"] > 0]
        print(f"\nMemory range: {min(mems):.1f} - {max(mems):.1f} MB", file=sys.stderr)
        if cpus:
            print(f"CPU range:    {min(cpus):.1f}% - {max(cpus):.1f}%", file=sys.stderr)


if __name__ == "__main__":
    main()
