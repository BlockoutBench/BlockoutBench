#!/usr/bin/env python3
"""Deterministic Unreal Engine 5 Editor whitebox importer for LevelWorkbench.

Consumes a pre-computed *-ue-whitebox.json package (from Workbench '导出 UE 包' or
tools/export_ue_whitebox.py) and spawns every Actor per AI_GUIDE.md Section 12
without letting an AI improvise coordinates, wall cuts, naming, or Tags.

Run inside UE5 Python Editor console / CLI:
    py "C:/path/to/LevelWorkbench/tools/ue_import_whitebox.py" "C:/path/to/map-ue-whitebox.json"

Test / inspect outside UE:
    python tools/ue_import_whitebox.py --dry-run path/to/map-ue-whitebox.json
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


def _hex_to_linear_color(hex_str: str):
    value = (hex_str or "#a99a7e").lstrip("#")
    if len(value) != 6:
        value = "a99a7e"
    r, g, b = (int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return unreal.LinearColor(pow(r, 2.2), pow(g, 2.2), pow(b, 2.2), 1.0)


def build_spawn_plan(pkg: dict, mapping: dict | None = None) -> list[dict]:
    """Flatten the UE build package into deterministic Actor spawn commands."""
    mapping = mapping or {}
    commands: list[dict] = []

    def add_box(actor_name: str, folder: str, center: list[float], size: list[float], *,
                yaw: float = 0.0, color: str = "#d7ccb5", collision: bool = True,
                visible: bool = True, tags: list[str] | None = None, kind: str | None = None):
        mapped = mapping.get(kind) if kind else None
        pivot_off = mapped.get("pivotOffsetCm", [0, 0, 0]) if mapped else [0, 0, 0]
        yaw_off = mapped.get("yawOffsetDeg", 0.0) if mapped else 0.0
        commands.append({
            "spawnType": "mesh" if mapped else "cube",
            "assetPath": mapped.get("assetPath") if mapped else "/Engine/BasicShapes/Cube.Cube",
            "actorName": actor_name,
            "folder": folder,
            "centerCm": [center[0] + pivot_off[0], center[1] + pivot_off[1], center[2] + pivot_off[2]],
            "sizeCm": size,
            "yawDeg": yaw + yaw_off,
            "color": color,
            "collision": collision,
            "collisionProfile": mapped.get("collisionProfile") if mapped else ("BlockAll" if collision else "NoCollision"),
            "visible": visible,
            "fitToBox": bool(mapped.get("fitToBox", True)) if mapped else False,
            "tags": tags or [],
        })

    for hole in pkg.get("stairHoles", []):
        commands.append({
            "spawnType": "note_stair_hole",
            "actorName": f"hole__{hole['roomId']}__{hole['stairId']}",
            "folder": f"Map/{hole['floorId']}/Rooms",
            "stairId": hole["stairId"],
            "roomId": hole["roomId"],
            "boxCm": hole["boxCm"],
            "tags": [f"id:{hole['roomId']}", "type:stair_hole", f"floor:{hole['floorId']}", f"stair:{hole['stairId']}"],
        })

    for room in pkg.get("rooms", []):
        box = room["boxCm"]
        add_box(
            room["actorName"], room["folder"], box["centerCm"], box["sizeCm"],
            color=room.get("color", "#e7dcc5"), collision=True, visible=True,
            tags=room.get("tags", []),
        )
        if not room.get("isRect", True):
            commands[-1]["polygonCm"] = room.get("polygonCm", [])
            commands[-1]["requiresPolygonExtrusion"] = True

    for wall in pkg.get("walls", []):
        add_box(
            wall["actorName"], wall["folder"], wall["centerCm"], wall["sizeCm"],
            yaw=wall.get("yawDeg", 0.0), color="#e9e0cd", collision=True, visible=True,
            tags=wall.get("tags", []),
        )

    for lintel in pkg.get("lintels", []):
        add_box(
            lintel["actorName"], lintel["folder"], lintel["centerCm"], lintel["sizeCm"],
            yaw=lintel.get("yawDeg", 0.0), color="#e9e0cd", collision=True, visible=True,
            tags=lintel.get("tags", []),
        )

    for door in pkg.get("doors", []):
        commands.append({
            "spawnType": "empty",
            "actorName": door["actorName"],
            "folder": door["folder"],
            "centerCm": door["centerCm"],
            "yawDeg": door.get("yawDeg", 0.0),
            "collision": False,
            "visible": True,
            "tags": door.get("tags", []),
        })
        if door.get("closedLeafActorName"):
            add_box(
                door["closedLeafActorName"], door["folder"], door["leafCenterCm"], door["leafSizeCm"],
                yaw=door.get("yawDeg", 0.0), color="#5c4637", collision=True, visible=True,
                tags=[*door.get("tags", []), "part:leaf", "state:closed"], kind="doorFrame",
            )

    for obj in pkg.get("objects", []):
        if not obj.get("present", True) or obj.get("kind") == "combat-space":
            commands.append({
                "spawnType": "empty",
                "actorName": obj["actorName"],
                "folder": obj["folder"],
                "centerCm": obj["boxCm"]["centerCm"],
                "yawDeg": 0.0,
                "collision": False,
                "visible": obj.get("visible", True),
                "tags": obj.get("tags", []),
            })
            continue
        box = obj["boxCm"]
        add_box(
            obj["actorName"], obj["folder"], box["centerCm"], box["sizeCm"],
            color=obj.get("color", "#a99a7e"), collision=bool(obj.get("collision", False)),
            visible=bool(obj.get("visible", True)), tags=obj.get("tags", []), kind=obj.get("kind"),
        )
        if not obj.get("isRect", True):
            commands[-1]["polygonCm"] = obj.get("polygonCm", [])
            commands[-1]["requiresPolygonExtrusion"] = True

    for stair in pkg.get("stairs", []):
        for step in stair.get("steps", []):
            add_box(
                step["actorName"], step["folder"], step["centerCm"], step["sizeCm"],
                color="#c4b89f", collision=True, visible=True, tags=step.get("tags", []),
            )

    for water in pkg.get("water", []):
        box = water["boxCm"]
        add_box(
            water["actorName"], water["folder"], box["centerCm"], box["sizeCm"],
            color="#6fa6a0", collision=False, visible=True, tags=water.get("tags", []),
        )

    for enemy in pkg.get("enemies", []):
        commands.append({
            "spawnType": "cylinder",
            "assetPath": "/Engine/BasicShapes/Cylinder.Cylinder",
            "actorName": enemy["actorName"],
            "folder": enemy["folder"],
            "centerCm": enemy["centerCm"],
            "sizeCm": [enemy["capsuleRadiusCm"] * 2, enemy["capsuleRadiusCm"] * 2, enemy["capsuleHeightCm"]],
            "yawDeg": 0.0,
            "color": "#b7524b",
            "collision": False,
            "collisionProfile": "NoCollision",
            "visible": True,
            "tags": enemy.get("tags", []),
        })

    for route in pkg.get("routes", []):
        commands.append({
            "spawnType": "route",
            "actorName": route["actorName"],
            "folder": route["folder"],
            "pointsCm": route.get("pointsCm", []),
            "collision": False,
            "visible": True,
            "tags": route.get("tags", []),
        })

    def _fmt_link_ref(item):
        if isinstance(item, dict):
            target = item.get("id", "")
            return f"{target}->{item['state']}" if "state" in item else str(target)
        return str(item)

    for link in pkg.get("links", []):
        from_refs = [_fmt_link_ref(x) for x in (link.get("from") or [])]
        to_refs = [_fmt_link_ref(x) for x in (link.get("to") or [])]
        commands.append({
            "spawnType": "empty",
            "actorName": link["actorName"],
            "folder": link["folder"],
            "centerCm": link.get("centerCm", [0, 0, 0]),
            "yawDeg": 0.0,
            "collision": False,
            "visible": True,
            "tags": [
                *link.get("tags", []),
                f"from:{','.join(from_refs)}",
                f"to:{','.join(to_refs)}",
                *( [f"require:{link['require']}"] if link.get("require") else [] ),
            ],
        })

    return commands


def apply_in_unreal(pkg: dict, commands: list[dict], clear_existing: bool = True) -> dict:
    """Spawn actors into the currently open UE Editor level."""
    actor_sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    mat_cache: dict[str, object] = {}

    if clear_existing:
        for actor in list(actor_sub.get_all_level_actors()):
            folder = str(actor.get_folder_path())
            if folder == "Map" or folder.startswith("Map/"):
                actor_sub.destroy_actor(actor)

    with unreal.ScopedEditorTransaction(f"Import LevelWorkbench Whitebox: {pkg.get('title', 'map')}"):
        spawned = 0
        non_rect_fallbacks = []
        for cmd in commands:
            stype = cmd["spawnType"]
            if stype == "note_stair_hole":
                non_rect_fallbacks.append(f"Stair hole needed: {cmd['roomId']} for {cmd['stairId']}")
                continue

            if stype in ("cube", "cylinder", "mesh"):
                loc = unreal.Vector(*cmd["centerCm"])
                rot = unreal.Rotator(0.0, 0.0, cmd.get("yawDeg", 0.0))
                actor = actor_sub.spawn_actor_from_class(unreal.StaticMeshActor, loc, rot)
                sm_comp = actor.static_mesh_component
                mesh = unreal.load_asset(cmd["assetPath"])
                if mesh:
                    sm_comp.set_static_mesh(mesh)
                sx, sy, sz = cmd["sizeCm"]
                if cmd.get("fitToBox") and mesh:
                    bounds = mesh.get_bounds().box_extent
                    sm_comp.set_world_scale3d(unreal.Vector(
                        (sx / 2.0) / max(1.0, bounds.x),
                        (sy / 2.0) / max(1.0, bounds.y),
                        (sz / 2.0) / max(1.0, bounds.z),
                    ))
                else:
                    # UE basic shapes (/Engine/BasicShapes/Cube & Cylinder) are 100cm cubes.
                    actor.set_actor_scale3d(unreal.Vector(sx / 100.0, sy / 100.0, sz / 100.0))

                actor.set_actor_enable_collision(bool(cmd.get("collision", False)))
                if hasattr(sm_comp, "set_collision_profile_name"):
                    sm_comp.set_collision_profile_name(cmd.get("collisionProfile", "NoCollision"))

                color_key = cmd.get("color", "#d7ccb5")
                if color_key not in mat_cache and sm_comp.get_material(0):
                    dmi = unreal.MaterialLibrary.create_dynamic_material_instance(actor, sm_comp.get_material(0))
                    if dmi:
                        dmi.set_vector_parameter_value("BaseColor", _hex_to_linear_color(color_key))
                        dmi.set_vector_parameter_value("Color", _hex_to_linear_color(color_key))
                        mat_cache[color_key] = dmi
                if color_key in mat_cache:
                    sm_comp.set_material(0, mat_cache[color_key])

                if cmd.get("requiresPolygonExtrusion"):
                    non_rect_fallbacks.append(cmd["actorName"])
            elif stype == "route":
                pts = cmd.get("pointsCm") or [[0, 0, 0]]
                actor = actor_sub.spawn_actor_from_class(unreal.Actor, unreal.Vector(*pts[0]), unreal.Rotator())
                actor.set_actor_enable_collision(False)
            else:
                actor = actor_sub.spawn_actor_from_class(unreal.Actor, unreal.Vector(*cmd["centerCm"]), unreal.Rotator(0.0, 0.0, cmd.get("yawDeg", 0.0)))
                actor.set_actor_enable_collision(False)

            actor.set_actor_label(cmd["actorName"])
            actor.set_folder_path(cmd["folder"])
            actor.tags = [unreal.Name(t) for t in cmd.get("tags", [])]
            hidden = not cmd.get("visible", True)
            actor.set_is_temporarily_hidden_in_editor(hidden)
            actor.set_actor_hidden_in_game(hidden)
            spawned += 1

    return {"spawned": spawned, "nonRectFallbacks": non_rect_fallbacks}


def main() -> int:
    parser = argparse.ArgumentParser(description="Deterministic UE5 whitebox importer for LevelWorkbench packages.")
    parser.add_argument("package", help="Path to *-ue-whitebox.json")
    parser.add_argument("--mapping", help="Optional JSON asset mapping file (see tools/ue_asset_mapping.sample.json)")
    parser.add_argument("--ignore-preflight", action="store_true", help="Proceed even if stairs.bottom is missing")
    parser.add_argument("--keep-existing", action="store_true", help="Do not clear existing Actors under Map/ before import")
    parser.add_argument("--dry-run", action="store_true", help="Print spawn plan summary without running Unreal APIs")
    args = parser.parse_args()

    pkg_path = Path(args.package).resolve()
    pkg = json.loads(pkg_path.read_text(encoding="utf-8-sig"))

    missing_bottom = pkg.get("preflight", {}).get("missingStairBottom") or []
    if missing_bottom and not args.ignore_preflight:
        print(f"STOPPED (AI_GUIDE Sec 12 3.7): stairs missing explicit 'bottom': {missing_bottom}", file=sys.stderr)
        return 2

    mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8-sig")) if args.mapping else None
    commands = build_spawn_plan(pkg, mapping=mapping)

    if args.dry_run or not HAS_UNREAL:
        mode = "DRY-RUN" if args.dry_run else "NO_UNREAL_ENV"
        by_type: dict[str, int] = {}
        for cmd in commands:
            by_type[cmd["spawnType"]] = by_type.get(cmd["spawnType"], 0) + 1
        print(f"[{mode}] package={pkg.get('title')} commands={len(commands)} breakdown={by_type}")
        if not args.dry_run and not HAS_UNREAL:
            print("Hint: run inside UE5 Editor Python to spawn Actors, or pass --dry-run outside UE.", file=sys.stderr)
            return 1
        return 0

    result = apply_in_unreal(pkg, commands, clear_existing=not args.keep_existing)
    print(f"Imported UE whitebox '{pkg.get('title')}': {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
