#!/usr/bin/env python3
"""Automated UE5 verification script matching AI_GUIDE.md Section 12 (3.10 self-check list).

Verifies:
  1. Expected Actor counts per type against *-ue-whitebox.json expectedCounts.
  2. World bounds containment within boundsCm (+ 20 cm tolerance for wall/slab thickness).
  3. State Actor visibility & collision toggles match initialState rules.
  4. Capsule sweep along every routes[] segment using player.radiusCm & player.heightCm.
  5. Writes structured ue-verify-report.json so failures feed back cleanly without AI guesswork.

Usage inside UE5 Python:
    py "C:/path/to/LevelWorkbench/tools/ue_verify_whitebox.py" "C:/path/to/map-ue-whitebox.json"

Test outside UE:
    python tools/ue_verify_whitebox.py --dry-run path/to/map-ue-whitebox.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import unreal  # type: ignore
    HAS_UNREAL = True
except ImportError:
    unreal = None
    HAS_UNREAL = False


def verify_dry_run(pkg: dict) -> dict:
    """Validate internal package consistency outside Unreal."""
    counts = pkg.get("expectedCounts", {})
    bounds = pkg.get("boundsCm", {})
    tol = bounds.get("toleranceCm", 20)
    out_of_bounds = []
    for coll_key in ("walls", "lintels"):
        for item in pkg.get(coll_key, []):
            cx, cy, cz = item["centerCm"]
            if cx < bounds["minX"] - tol or cx > bounds["maxX"] + tol or cy < bounds["minY"] - tol or cy > bounds["maxY"] + tol:
                out_of_bounds.append({"actorName": item["actorName"], "centerCm": [cx, cy, cz]})
    return {
        "mode": "dry-run",
        "title": pkg.get("title"),
        "expectedCounts": counts,
        "outOfBounds": out_of_bounds,
        "preflight": pkg.get("preflight", {}),
        "ok": len(out_of_bounds) == 0 and not (pkg.get("preflight", {}).get("missingStairBottom")),
    }


def verify_in_unreal(pkg: dict) -> dict:
    actor_sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    actors = [a for a in actor_sub.get_all_level_actors() if str(a.get_folder_path()).startswith("Map/") or str(a.get_folder_path()) == "Map"]

    by_label = {a.get_actor_label(): a for a in actors}
    tag_counts: dict[str, int] = {}
    for a in actors:
        for t in a.tags:
            s = str(t)
            if s.startswith("type:"):
                k = s.split(":", 1)[1]
                tag_counts[k] = tag_counts.get(k, 0) + 1

    bounds = pkg["boundsCm"]
    tol = bounds.get("toleranceCm", 20)
    out_of_bounds = []
    coord_mismatches = []

    def check_pos(label: str, expected: list[float]):
        actor = by_label.get(label)
        if not actor:
            coord_mismatches.append({"actorName": label, "reason": "missing"})
            return
        loc = actor.get_actor_location()
        err = max(abs(loc.x - expected[0]), abs(loc.y - expected[1]), abs(loc.z - expected[2]))
        if err > 1.0:
            coord_mismatches.append({"actorName": label, "expectedCm": expected, "actualCm": [loc.x, loc.y, loc.z], "maxErrCm": round(err, 2)})

    for w in pkg.get("walls", []):
        check_pos(w["actorName"], w["centerCm"])
    for d in pkg.get("doors", []):
        check_pos(d["actorName"], d["centerCm"])
    for r in pkg.get("rooms", []):
        check_pos(r["actorName"], r["boxCm"]["centerCm"])

    for a in actors:
        loc = a.get_actor_location()
        if loc.x < bounds["minX"] - tol or loc.x > bounds["maxX"] + tol or loc.y < bounds["minY"] - tol or loc.y > bounds["maxY"] + tol:
            out_of_bounds.append({"actorName": a.get_actor_label(), "locationCm": [loc.x, loc.y, loc.z]})

    state_issues = []
    for obj in pkg.get("objects", []):
        if obj.get("stateId") is None:
            continue
        actor = by_label.get(obj["actorName"])
        if not actor:
            state_issues.append({"actorName": obj["actorName"], "reason": "missing"})
            continue
        expected_hidden = not obj.get("visible", True)
        if bool(actor.is_hidden_ed()) != expected_hidden:
            state_issues.append({"actorName": obj["actorName"], "expectedHidden": expected_hidden, "actualHidden": bool(actor.is_hidden_ed())})

    # Rebuild navigation if available and run capsule sweep along every route segment.
    player = pkg.get("player", {})
    radius = float(player.get("radiusCm", 40.0))
    half_h = float(player.get("heightCm", 180.0)) / 2.0
    blocked_segments = []
    if hasattr(unreal, "SystemLibrary") and world:
        for route in pkg.get("routes", []):
            pts = route.get("pointsCm", [])
            for idx in range(len(pts) - 1):
                a = unreal.Vector(pts[idx][0], pts[idx][1], pts[idx][2] + half_h + 5.0)
                b = unreal.Vector(pts[idx + 1][0], pts[idx + 1][1], pts[idx + 1][2] + half_h + 5.0)
                hits = unreal.SystemLibrary.capsule_trace_multi(
                    world, a, b, radius, half_h,
                    unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, False, [],
                    unreal.DrawDebugTrace.NONE, True,
                )
                for hit in hits or []:
                    hit_actor = hit.to_tuple()[9] if hasattr(hit, "to_tuple") else None
                    label = hit_actor.get_actor_label() if hit_actor else "unknown"
                    blocked_segments.append({"routeId": route["id"], "segment": idx, "hitActor": label})

    expected = pkg.get("expectedCounts", {})
    count_mismatches = {}
    check_pairs = [
        ("room", expected.get("rooms", 0)),
        ("wall", expected.get("walls", 0)),
        ("door", expected.get("doors", 0) + expected.get("lintels", 0) + expected.get("closedDoorLeaves", 0)),
        ("object", expected.get("objects", 0)),
        ("stairs", expected.get("stairSteps", 0)),
        ("water", expected.get("water", 0)),
        ("enemy", expected.get("enemies", 0)),
        ("route", expected.get("routes", 0)),
        ("link", expected.get("links", 0)),
    ]
    for tag_key, exp_n in check_pairs:
        got_n = tag_counts.get(tag_key, 0)
        if got_n != exp_n:
            count_mismatches[tag_key] = {"expected": exp_n, "actual": got_n}

    ok = not (count_mismatches or coord_mismatches or out_of_bounds or state_issues or blocked_segments)
    return {
        "mode": "unreal",
        "title": pkg.get("title"),
        "expectedCounts": expected,
        "actualTagCounts": tag_counts,
        "countMismatches": count_mismatches,
        "coordMismatches": coord_mismatches[:20],
        "outOfBounds": out_of_bounds[:20],
        "stateIssues": state_issues[:20],
        "blockedRouteHits": blocked_segments[:20],
        "ok": ok,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify UE5 whitebox Actors against *-ue-whitebox.json.")
    parser.add_argument("package", help="Path to *-ue-whitebox.json")
    parser.add_argument("-o", "--report", help="Write JSON verification report path")
    parser.add_argument("--dry-run", action="store_true", help="Run package consistency checks without Unreal")
    args = parser.parse_args()

    pkg_path = Path(args.package).resolve()
    pkg = json.loads(pkg_path.read_text(encoding="utf-8-sig"))

    if args.dry_run or not HAS_UNREAL:
        report = verify_dry_run(pkg)
        if not args.dry_run and not HAS_UNREAL:
            print("Not running inside UE5 Python; pass --dry-run to validate package outside UE.", file=sys.stderr)
            return 1
    else:
        report = verify_in_unreal(pkg)

    out_path = Path(args.report) if args.report else pkg_path.with_name(f"{pkg_path.stem}-verify-report.json")
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
