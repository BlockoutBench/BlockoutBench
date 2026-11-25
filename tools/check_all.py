#!/usr/bin/env python3
"""One-shot regression: rebuild generated files, validate every map, then run the browser check.

    python tools/check_all.py               # everything
    python tools/check_all.py --no-browser  # data only
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]


def run(label: str, command: list[str]) -> bool:
    print(f"\n== {label} ==", flush=True)
    result = subprocess.run(command, cwd=ROOT)
    ok = result.returncode == 0
    print(f"-- {label}: {'ok' if ok else 'FAILED'}", flush=True)
    return ok


def main() -> int:
    steps = [("build", [sys.executable, "tools/build.py"])]
    manifest = json.loads((ROOT / "maps" / "manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["maps"]:
        steps.append((f"validate {entry['key']}", [sys.executable, "tools/validate_ai_map.py", entry["file"]]))
    steps.append(("validator parity (py vs js)", ["node", "tools/check_validator_parity.cjs"]))
    steps.append(("benchmark suite self-check", [sys.executable, "tools/run_benchmark.py", "--check"]))
    if "--no-browser" not in sys.argv:
        steps.append(("workbench browser check", ["node", "tools/check_workbench.cjs"]))
        steps.append(("all 3D free camera", ["node", "tools/check_free_camera.cjs"]))
    failed = [label for label, command in steps if not run(label, command)]
    print()
    if failed:
        print("FAILED: " + ", ".join(failed))
        return 1
    print("ALL WORKBENCH CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
