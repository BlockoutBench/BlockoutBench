#!/usr/bin/env python3
"""Export a deterministic UE5 whitebox build package (*-ue-whitebox.json) from an AI_MAP_SPEC map.

Pre-computes coordinate transforms (cm, X=z*100 North, Y=x*100 East, Z=y*100 Up),
merged walls, door cuts, lintels, stairs, expanded object states, expected actor counts,
and UE preflight diagnostics using map-geometry.js (single source of truth).

Usage:
    python tools/export_ue_whitebox.py AI_MAP_SAMPLE.json
    python tools/export_ue_whitebox.py my-map.json --auto-snap -o out/my-map-ue-whitebox.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]


def build_package(map_path: Path, auto_snap: bool = False) -> tuple[dict, dict]:
    script = r"""
const fs = require('fs');
const path = require('path');
const G = require(path.resolve(process.argv[1], 'map-geometry.js'));
const V = require(path.resolve(process.argv[1], 'map-validate.js'));
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const autoSnap = process.argv[3] === '1';
const expanded = G.expandRelativeLayout(raw);
const vBefore = V.validate(expanded);
let target = expanded;
let fixes = [];
if (autoSnap && vBefore.errors.length === 0) {
  const snapped = G.snapAndClearGeometry(expanded);
  target = snapped.data;
  fixes = snapped.fixes;
}
const validation = V.validate(target);
const pkg = validation.errors.length === 0 ? G.buildUeWhiteboxSpec(target) : null;
process.stdout.write(JSON.stringify({ validation, fixes, pkg }));
"""
    proc = subprocess.run(
        ["node", "-e", script, str(ROOT), str(map_path.resolve()), "1" if auto_snap else "0"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node export failed: {proc.stderr.strip()}")
    payload = json.loads(proc.stdout)
    return payload, payload.get("pkg")


def main() -> int:
    parser = argparse.ArgumentParser(description="Export deterministic UE5 whitebox package from AI_MAP_SPEC JSON.")
    parser.add_argument("map_file", help="Path to AI_MAP_SPEC v1 JSON file")
    parser.add_argument("-o", "--output", help="Output *-ue-whitebox.json path")
    parser.add_argument("--auto-snap", action="store_true", help="Run snapAndClearGeometry before exporting")
    args = parser.parse_args()

    map_path = Path(args.map_file)
    if not map_path.is_absolute():
        map_path = (ROOT / map_path).resolve()
    if not map_path.exists():
        print(f"ERROR: file not found: {map_path}", file=sys.stderr)
        return 1

    payload, pkg = build_package(map_path, auto_snap=args.auto_snap)
    val = payload["validation"]
    if val["errors"]:
        print(f"REFUSED: {len(val['errors'])} schema error(s) in {map_path.name}:", file=sys.stderr)
        for err in val["errors"][:5]:
            print(f"  [{err['code']}] {err['msg']}", file=sys.stderr)
        return 2

    out_path = Path(args.output) if args.output else map_path.with_name(f"{map_path.stem}-ue-whitebox.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    fixes = payload.get("fixes") or []
    preflight = pkg["preflight"]
    counts = pkg["expectedCounts"]
    print(f"Exported UE whitebox package -> {out_path}")
    print(f"  expectedCounts: {counts}")
    if fixes:
        print(f"  autoSnap fixes applied: {len(fixes)}")
    if val["warnings"]:
        print(f"  warnings ({len(val['warnings'])}): {[w['code'] for w in val['warnings']]}")
    if preflight["missingStairBottom"]:
        print(f"  PREFLIGHT WARN: missing stairs.bottom on {preflight['missingStairBottom']}")
    if preflight["nonRectShapes"]:
        print(f"  PREFLIGHT NOTE: non-rect polygons (need polygon extrusion in UE): {preflight['nonRectShapes']}")
    if preflight["fallbackKindObjects"]:
        print(f"  PREFLIGHT NOTE: fallback 0.8m height kinds: {preflight['fallbackKindObjects']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
