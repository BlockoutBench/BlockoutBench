#!/usr/bin/env python3
"""Validate an AI_MAP_SPEC v1 level design JSON.

Same rules and issue codes as map-validate.js (the in-page validator);
tools/check_validator_parity.cjs keeps the two in step. Dependency-free.

    python tools/validate_ai_map.py my-map.json          # human-readable
    python tools/validate_ai_map.py my-map.json --json   # {errors, warnings} with codes
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
STATUSES = ("existing", "planned", "adjusted", "preview", "annotation")
TIERS = ("normal", "elite", "boss")
BRANCHES = ("main", "optional")
ROUTE_KINDS = ("main", "optional", "exit", "secret")
NOTE_STATUSES = ("open", "confirmed", "resolved")
SIDES = ("N", "S", "E", "W")
PLAYER_KEYS = ("radius", "height", "walkSpeed", "rollDistance", "rollDuration", "interactionRange")
DOOR_EDGE_TOLERANCE = 0.08


def is_num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def is_point(value, allow_y: bool = False) -> bool:
    return isinstance(value, list) and (len(value) == 2 or (allow_y and len(value) == 3)) and all(is_num(v) for v in value)


def closest_route_point(a, b, polygon) -> list:
    """Point on segment a-b nearest to the polygon's vertices, rounded to centimetres."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dz * dz
    best, best_d = None, math.inf
    for v in polygon:
        t = 0 if not length else max(0.0, min(1.0, ((v[0] - a[0]) * dx + (v[1] - a[1]) * dz) / length))
        q = (a[0] + t * dx, a[1] + t * dz)
        d = math.hypot(q[0] - v[0], q[1] - v[1])
        if d < best_d:
            best, best_d = q, d
    return [round(best[0], 2), round(best[1], 2)]


def is_text(value) -> bool:
    return isinstance(value, str) and value != ""


def valid_polygon(points) -> bool:
    return isinstance(points, list) and len(points) >= 3 and all(is_point(p) for p in points)


def point_in_polygon(point, polygon) -> bool:
    x, z = point[0], point[1]
    inside = False
    for i, j in zip(range(len(polygon)), range(-1, len(polygon) - 1)):
        xi, zi = polygon[i][0], polygon[i][1]
        xj, zj = polygon[j][0], polygon[j][1]
        if ((zi > z) != (zj > z)) and (x < (xj - xi) * (z - zi) / ((zj - zi) or 1e-9) + xi):
            inside = not inside
    return inside


def segment_distance(point, a, b) -> float:
    dx, dz = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dz * dz
    t = 0 if not length else max(0.0, min(1.0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length))
    return math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz)


def segments_cross(a, b, c, d) -> bool:
    def cross(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d)
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and 0 not in (d1, d2, d3, d4)


def segment_polygon_distance(a, b, polygon) -> float:
    """Distance from segment a-b to a polygon (0 when touching or inside)."""
    if point_in_polygon(a, polygon) or point_in_polygon(b, polygon):
        return 0.0
    best = math.inf
    for i in range(len(polygon)):
        p, q = polygon[i], polygon[(i + 1) % len(polygon)]
        if segments_cross(a, b, p, q):
            return 0.0
        best = min(best, segment_distance(a, p, q), segment_distance(b, p, q), segment_distance(p, a, b))
    return best


def polygon_area(points) -> float:
    return abs(sum(points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1]
                   for i in range(len(points))) / 2)


def is_int(value) -> bool:
    return is_num(value) and float(value).is_integer()


def is_str_list(value) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def states_problem(states):
    """First problem in an object's states list, or None when it is well formed."""
    if not isinstance(states, list):
        return "states 必须是数组"
    if len(states) < 2:
        return "states 至少 2 项"
    seen = set()
    for state in states:
        if not isinstance(state, dict):
            return "states 的每一项必须是对象"
        sid = state.get("id")
        if not isinstance(sid, str) or not ID_RE.match(sid):
            return f"状态 id 非法: {sid}"
        if sid in seen:
            return f"状态 id 重复: {sid}"
        seen.add(sid)
        for key in ("solid", "present"):
            if key in state and not isinstance(state[key], bool):
                return f"状态 {sid}: {key} 必须是布尔值"
        if "baseHeight" in state and (not is_num(state["baseHeight"]) or state["baseHeight"] < 0):
            return f"状态 {sid}: baseHeight 必须是 ≥0 的数字"
        if "height" in state and (not is_num(state["height"]) or state["height"] <= 0):
            return f"状态 {sid}: height 必须大于 0"
    return None


def state_ids(obj) -> list:
    states = obj.get("states")
    if not isinstance(states, list):
        return []
    return [s["id"] for s in states if isinstance(s, dict) and isinstance(s.get("id"), str)]


def proximity_problem(rule):
    """First problem in a meta.proximity rule, or None when it is well formed."""
    if not isinstance(rule, dict):
        return "规则必须是对象"
    if not isinstance(rule.get("name"), str) or not rule["name"]:
        return "name 必须是非空字符串"
    if not is_num(rule.get("radius")) or rule["radius"] <= 0:
        return "radius 必须大于 0"
    for key in ("kinds", "enemyTypes"):
        if key in rule and not is_str_list(rule[key]):
            return f"{key} 必须是字符串数组"
    if not rule.get("kinds") and not rule.get("enemyTypes"):
        return "kinds 与 enemyTypes 至少一个非空"
    if "lineOfSight" in rule and not isinstance(rule["lineOfSight"], bool):
        return "lineOfSight 必须是布尔值"
    return None


COLLECTIONS = ("floors", "rooms", "objects", "enemies", "doors", "routes", "stairs", "water", "links", "reviewNotes")
POINTED = ("rooms", "objects", "doors", "routes", "stairs", "water")
META_OBJECTS = ("bounds", "provenance", "player", "legendLabels")


def normalize_shape(data, error) -> dict:
    """Copy of data where every container has the type the checks expect. Each mismatch is
    reported once as shape-invalid (id = where it is, e.g. rooms[2].points) and treated as absent."""
    data = dict(data)
    meta = data.get("meta")
    if meta is not None and not isinstance(meta, dict):
        error("shape-invalid", "meta", "meta 必须是对象")
        meta = None
    meta = dict(meta or {})
    for key in META_OBJECTS:
        if meta.get(key) is not None and not isinstance(meta[key], dict):
            error("shape-invalid", f"meta.{key}", f"meta.{key} 必须是对象")
            del meta[key]
    data["meta"] = meta
    for key in COLLECTIONS:
        value = data.get(key)
        if value is None:
            continue
        if not isinstance(value, list):
            error("shape-invalid", key, f"{key} 必须是数组")
            data[key] = []
            continue
        items = []
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                error("shape-invalid", f"{key}[{index}]", f"{key}[{index}] 必须是对象")
                continue
            if key in POINTED and item.get("points") is not None and not isinstance(item["points"], list):
                error("shape-invalid", f"{key}[{index}].points", f"{key}[{index}].points 必须是数组")
                item = {k: v for k, v in item.items() if k != "points"}
            items.append(item)
        data[key] = items
    return data


def validate(data) -> dict:
    errors: list[dict] = []
    warnings: list[dict] = []

    def error(code, id_, msg):
        errors.append({"code": code, "id": id_, "msg": msg})

    def warn(code, id_, msg, at=None):
        item = {"code": code, "id": id_, "msg": msg}
        if at is not None:
            item["at"] = at   # plan point the problem is closest to, for drawing it where it happens
        warnings.append(item)

    if not isinstance(data, dict):
        error("shape-invalid", "$", "地图必须是一个 JSON 对象")
        data = {}
    data = normalize_shape(data, error)
    if not (is_num(data.get("schemaVersion")) and data["schemaVersion"] == 1):   # True == 1 in Python; reject it
        error("schema-version", None, "schemaVersion 必须是 1")
    meta = data.get("meta") or {}
    bounds = meta.get("bounds") or {}
    if meta.get("units") != "m":
        error("meta-units", None, 'meta.units 必须是 "m"')
    if not all(is_num(bounds.get(key)) for key in ("minX", "minZ", "maxX", "maxZ")):
        error("meta-bounds", None, "meta.bounds 需要数字 minX/minZ/maxX/maxZ")
        bounds = {"minX": -math.inf, "minZ": -math.inf, "maxX": math.inf, "maxZ": math.inf}
    elif bounds["minX"] >= bounds["maxX"] or bounds["minZ"] >= bounds["maxZ"]:
        error("meta-bounds-order", None, "meta.bounds 的 min 必须小于 max")

    def in_bounds(p) -> bool:
        return bounds["minX"] <= p[0] <= bounds["maxX"] and bounds["minZ"] <= p[1] <= bounds["maxZ"]

    provenance = meta.get("provenance") or {}
    if provenance.get("kind") not in ("design", "scene-snapshot"):
        error("provenance-kind", None, "meta.provenance.kind 必须是 design 或 scene-snapshot")
    if not is_text(provenance.get("label")) or not is_text(provenance.get("source")):
        error("provenance-fields", None, "meta.provenance 需要 label 和 source")
    if provenance.get("kind") == "design" and not is_text(provenance.get("generatedAt")):
        error("provenance-date", None, "design 来源需要 generatedAt")
    if provenance.get("kind") == "scene-snapshot" and not is_text(provenance.get("snapshotDate")):
        error("provenance-date", None, "scene-snapshot 来源需要 snapshotDate")
    player = meta.get("player") or {}
    for key in PLAYER_KEYS:
        if not is_num(player.get(key)) or player[key] < 0:
            error("player-field", key, f"meta.player.{key} 必须是非负数")
    for key, value in (meta.get("legendLabels") or {}).items():
        if not isinstance(value, str) or not value:
            error("legend-label", key, f"meta.legendLabels.{key} 必须是非空字符串")
    if "kindLegend" in meta:
        kind_legend = meta["kindLegend"]
        if not isinstance(kind_legend, dict):
            error("kind-legend-label", None, "meta.kindLegend 必须是对象")
        else:
            for key, value in kind_legend.items():
                if not isinstance(value, dict) or not isinstance(value.get("label"), str) or not value["label"]:
                    error("kind-legend-label", key, f"meta.kindLegend.{key} 需要非空字符串 label")

    floor_by_id: dict = {}
    levels = []
    for floor in data.get("floors") or []:
        fid = floor.get("id")
        if not isinstance(fid, str):
            # A non-string id is reported as is and never becomes a known floor.
            error("floor-id", fid, f"楼层 id 非法: {fid}")
        elif not fid or not ID_RE.match(fid):
            error("floor-id", fid, f"楼层 id 非法: {fid}")
        elif fid in floor_by_id:
            error("floor-dup", fid, f"楼层 id 重复: {fid}")
        if isinstance(fid, str):
            floor_by_id[fid] = floor
        if not is_num(floor.get("elevation")):
            error("floor-elevation", fid, f"楼层 {fid}: elevation 必须是数字")
        else:
            levels.append(floor["elevation"])
        if not is_num(floor.get("height")) or floor["height"] <= 0:
            error("floor-height", fid, f"楼层 {fid}: height 必须大于 0")
    if any(index and level < levels[index - 1] for index, level in enumerate(levels)):
        warn("floors-order", None, "楼层没有按 elevation 从低到高排列")

    ids = set(floor_by_id)

    def register(entity, type_):
        id_ = entity.get("id")
        if not isinstance(id_, str):
            # A non-string id is reported as is and never joins the id set.
            error("id-invalid", id_, f"{type_} id 非法: {id_}")
            return id_
        if not id_ or not ID_RE.match(id_):
            error("id-invalid", id_, f"{type_} id 非法: {id_}")
        elif id_ in ids:
            error("id-dup", id_, f"ID 重复: {id_}")
        ids.add(id_)
        return id_

    def check_points(points, id_, type_, allow_y=False):
        for point in points:
            if not is_point(point, allow_y):
                error("point-invalid", id_, f"{type_} {id_}: 点格式错误 {json.dumps(point, ensure_ascii=False)}")
            elif not in_bounds(point):
                error("point-out-of-bounds", id_, f"{type_} {id_}: 点超出 bounds {json.dumps(point)}")

    def check_floor(entity, id_, type_):
        if not isinstance(entity.get("floorId"), str) or entity["floorId"] not in floor_by_id:
            error("floor-unknown", id_, f"{type_} {id_}: 未知楼层 {entity.get('floorId')}")

    rooms = data.get("rooms") or []
    room_by_id = {}
    if not rooms:
        error("rooms-empty", None, "至少需要一个房间")
    for room in rooms:
        rid = register(room, "房间")
        if isinstance(rid, str):
            room_by_id[rid] = room
        check_floor(room, rid, "房间")
        if room.get("status") not in STATUSES:
            error("room-status", rid, f"房间 {rid}: status 非法")
        if "wallHeight" in room and (not is_num(room["wallHeight"]) or room["wallHeight"] < 0):
            error("room-wall-height", rid, f"房间 {rid}: wallHeight 必须是 ≥0 的数字")
        points = room.get("points") or []
        if "openEdges" in room:
            edges = room["openEdges"]
            if (not isinstance(edges, list) or any(not is_int(e) or e < 0 or e >= len(points) for e in edges)
                    or len(set(edges)) != len(edges)):
                error("room-open-edges", rid, f"房间 {rid}: openEdges 必须是不重复的边序号（0 到 {len(points) - 1}）")
        if len(points) < 3:
            error("room-points", rid, f"房间 {rid}: 至少 3 个点")
        elif all(is_point(p) for p in points) and polygon_area(points) < 0.5:
            warn("room-small", rid, f"房间 {rid}: 面积很小")
        check_points(points, rid, "房间")

    # Light AABB overlap warning; polygon-level overlap is intentionally not guessed.
    for index, a in enumerate(rooms):
        for b in rooms[index + 1:]:
            if a.get("floorId") != b.get("floorId"):
                continue
            ap, bp = a.get("points") or [], b.get("points") or []
            if len(ap) < 3 or len(bp) < 3 or not all(is_point(p) for p in ap) or not all(is_point(p) for p in bp):
                continue
            ax0, az0, ax1, az1 = min(p[0] for p in ap), min(p[1] for p in ap), max(p[0] for p in ap), max(p[1] for p in ap)
            bx0, bz0, bx1, bz1 = min(p[0] for p in bp), min(p[1] for p in bp), max(p[0] for p in bp), max(p[1] for p in bp)
            overlap = max(0, min(ax1, bx1) - max(ax0, bx0)) * max(0, min(az1, bz1) - max(az0, bz0))
            if overlap > 0.5:
                warn("room-overlap", a.get("id"), f"房间 {a.get('id')} 与 {b.get('id')} 外框重叠 {overlap:.1f} m²")

    objects = data.get("objects") or []
    for obj in objects:
        oid = register(obj, "物件")
        check_floor(obj, oid, "物件")
        points = obj.get("points") or []
        if len(points) < 3:
            error("object-points", oid, f"物件 {oid}: 至少 3 个点")
        check_points(points, oid, "物件")
        if "baseHeight" in obj and (not is_num(obj["baseHeight"]) or obj["baseHeight"] < 0):
            error("object-base-height", oid, f"物件 {oid}: baseHeight 必须是 ≥0 的数字")
        if "states" in obj:
            problem = states_problem(obj["states"])
            if problem:
                error("object-states", oid, f"物件 {oid}: {problem}")
            else:
                for state in obj["states"]:
                    if "points" not in state:
                        continue
                    state_points = state["points"]
                    if not isinstance(state_points, list) or len(state_points) < 3:
                        error("object-points", oid, f"物件 {oid}: 状态 {state['id']} 至少 3 个点")
                    if isinstance(state_points, list):
                        check_points(state_points, oid, "物件")
        if "initialState" in obj and obj["initialState"] not in state_ids(obj):
            error("object-initial-state", oid, f"物件 {oid}: initialState 不在 states 里 {obj['initialState']}")

    for enemy in data.get("enemies") or []:
        eid = register(enemy, "敌人")
        if enemy.get("tier") not in TIERS:
            error("enemy-tier", eid, f"敌人 {eid}: tier 非法")
        if enemy.get("branch") not in BRANCHES:
            error("enemy-branch", eid, f"敌人 {eid}: branch 非法")
        room = room_by_id.get(enemy["roomId"]) if isinstance(enemy.get("roomId"), str) else None
        if not room:
            error("enemy-room-unknown", eid, f"敌人 {eid}: 未知房间 {enemy.get('roomId')}")
        elif enemy.get("floorId") != room.get("floorId"):
            error("enemy-floor-mismatch", eid, f"敌人 {eid}: 楼层与房间 {room.get('id')} 不一致")
        center = enemy.get("center")
        if not is_point(center):
            error("enemy-center-invalid", eid, f"敌人 {eid}: center 格式错误")
        elif not in_bounds(center):
            error("point-out-of-bounds", eid, f"敌人 {eid}: center 超出 bounds")
        elif room and valid_polygon(room.get("points")) and not point_in_polygon(center, room["points"]):
            error("enemy-outside-room", eid, f"敌人 {eid}: center 不在房间 {room.get('id')} 内")

    radius = player["radius"] if is_num(player.get("radius")) else 0
    for door in data.get("doors") or []:
        did = register(door, "门")
        check_floor(door, did, "门")
        points = door.get("points") or []
        if len(points) != 2:
            error("door-points", did, f"门 {did}: 需要正好 2 个点")
        if not is_num(door.get("width")) or door["width"] <= 0:
            error("door-width", did, f"门 {did}: width 必须大于 0")
        elif door["width"] < radius * 2 - 1e-6:
            warn("door-narrow", did, f"门 {did}: 宽 {door['width']}m 小于玩家直径 {radius * 2:.2f}m")
        if "initial" in door and door["initial"] not in ("open", "closed"):
            error("door-initial", did, f"门 {did}: initial 必须是 open 或 closed")
        if "height" in door and (not is_num(door["height"]) or door["height"] <= 0):
            error("door-height", did, f"门 {did}: height 必须大于 0")
        if len(points) == 2 and all(is_point(p) for p in points):
            mid = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2]
            on_edge = False
            for room in rooms:
                if room.get("floorId") != door.get("floorId"):
                    continue
                rp = room.get("points") or []
                for i in range(len(rp)):
                    p, q = rp[i], rp[(i + 1) % len(rp)]
                    if is_point(p) and is_point(q) and segment_distance(mid, p, q) <= DOOR_EDGE_TOLERANCE:
                        on_edge = True
                        break
                if on_edge:
                    break
            if not on_edge:
                warn("door-off-boundary", did, f"门 {did}: 中点不在任何房间边上")

    player_height = player.get("height")

    def blocks_route(obj) -> bool:
        # Objects with states may move aside; objects hung at or above head height do not block walking.
        if isinstance(obj.get("states"), list) and len(obj["states"]) >= 1:
            return False
        return not (is_num(player_height) and player_height > 0 and is_num(obj.get("baseHeight")) and obj["baseHeight"] >= player_height)

    clearance_height = player_height if is_num(player_height) and player_height > 0 else 0

    def floor_level(floor_id) -> float:
        level = (floor_by_id.get(floor_id) or {}).get("elevation") if isinstance(floor_id, str) else None
        return level if is_num(level) else 0

    solids = [o for o in objects if o.get("solid") is True and len(o.get("points") or []) >= 3 and all(is_point(p) for p in o["points"])
              and blocks_route(o)]
    main_route = None
    for route in data.get("routes") or []:
        rid = register(route, "路线")
        check_floor(route, rid, "路线")
        if route.get("kind") not in ROUTE_KINDS:
            error("route-kind", rid, f"路线 {rid}: kind 非法")
        points = route.get("points") or []
        if len(points) < 2:
            error("route-points", rid, f"路线 {rid}: 至少 2 个点")
        check_points(points, rid, "路线", allow_y=True)
        if route.get("kind") == "main":
            if main_route:
                warn("main-multiple", rid, "有多条主线；压力节奏只用第一条")
            else:
                main_route = route
        if radius > 0 and len(points) >= 2 and all(is_point(p, True) for p in points):
            route_level = floor_level(route.get("floorId"))
            heights = [p[2] if len(p) == 3 else route_level for p in points]
            for obj in solids:
                if obj.get("floorId") != route.get("floorId"):
                    continue
                # Vertical range of the object; a segment passing wholly above or below it is clear.
                obj_low = floor_level(obj.get("floorId")) + (obj["baseHeight"] if is_num(obj.get("baseHeight")) else 0)
                obj_high = obj_low + obj["height"] if is_num(obj.get("height")) and obj["height"] > 0 else math.inf
                for i in range(len(points) - 1):
                    seg_low = min(heights[i], heights[i + 1])
                    seg_high = max(heights[i], heights[i + 1]) + clearance_height
                    if seg_high <= obj_low or seg_low >= obj_high:
                        continue
                    if segment_polygon_distance(points[i], points[i + 1], obj["points"]) < radius - 1e-6:
                        warn("route-clearance", rid, f"路线 {rid}: 离阻挡物件 {obj.get('id')} 不足玩家半径 {radius}m",
                             closest_route_point(points[i], points[i + 1], obj["points"]))
                        break
    if not main_route:
        error("main-missing", None, '缺少 kind="main" 的主线')

    for stair in data.get("stairs") or []:
        sid = register(stair, "楼梯")
        for key in ("fromFloorId", "toFloorId"):
            if not isinstance(stair.get(key), str) or stair[key] not in floor_by_id:
                error("stairs-floor-unknown", sid, f"楼梯 {sid}: 未知 {key} {stair.get(key)}")
        if "bottom" in stair and stair["bottom"] not in SIDES:
            error("stairs-bottom", sid, f"楼梯 {sid}: bottom 必须是 N/S/E/W")
        points = stair.get("points") or []
        if len(points) < 3:
            error("stairs-points", sid, f"楼梯 {sid}: 至少 3 个点")
        check_points(points, sid, "楼梯")

    for water in data.get("water") or []:
        wid = register(water, "水面")
        check_floor(water, wid, "水面")
        points = water.get("points") or []
        if len(points) < 3:
            error("water-points", wid, f"水面 {wid}: 至少 3 个点")
        check_points(points, wid, "水面")

    object_by_id = {o["id"]: o for o in objects if isinstance(o.get("id"), str)}
    enemy_ids = {e["id"] for e in data.get("enemies") or [] if isinstance(e.get("id"), str)}
    room_ids = {r["id"] for r in rooms if isinstance(r.get("id"), str)}
    door_ids = {d["id"] for d in data.get("doors") or [] if isinstance(d.get("id"), str)}
    opened_doors = []
    for link in data.get("links") or []:
        lid = register(link, "连接")
        sources, targets = link.get("from"), link.get("to")
        if "require" in link and link["require"] not in ("all", "any"):
            error("link-require", lid, f"连接 {lid}: require 必须是 all 或 any")
        if not (isinstance(sources, list) and sources and all(isinstance(s, str) for s in sources)
                and isinstance(targets, list) and targets
                and all(isinstance(t, dict) and isinstance(t.get("id"), str) and isinstance(t.get("state"), str) for t in targets)):
            error("link-endpoints", lid, f"连接 {lid}: from 需要非空 ID 数组，to 需要非空 {{id, state}} 数组")
            continue
        opened_doors.extend(t["id"] for t in targets if t["state"] == "open")
        for source in sources:
            if source not in object_by_id and source not in enemy_ids and source not in room_ids:
                error("link-from-unknown", lid, f"连接 {lid}: from 里的 {source} 不是已有的物件、敌人或房间")
        for target in targets:
            tid, state = target["id"], target["state"]
            if tid in object_by_id:
                if state not in state_ids(object_by_id[tid]):
                    error("link-to-state", lid, f"连接 {lid}: 物件 {tid} 没有状态 {state}")
            elif tid in door_ids:
                if state not in ("open", "closed"):
                    error("link-to-state", lid, f"连接 {lid}: 门 {tid} 的状态只能是 open 或 closed")
            else:
                error("link-to-unknown", lid, f"连接 {lid}: to 里的 {tid} 不是已有的物件或门")

    for door in data.get("doors") or []:
        if door.get("initial") == "closed" and door.get("id") not in opened_doors:
            warn("door-closed-unlinked", door.get("id"), f"门 {door.get('id')}: 初始关闭，但没有连接把它设为 open")

    if "proximity" in meta:
        rules = meta["proximity"]
        if not isinstance(rules, list):
            error("proximity-field", None, "meta.proximity 必须是数组")
            rules = []
        object_kinds = [o.get("kind") for o in objects if isinstance(o.get("kind"), str)]
        enemy_types = [e.get("enemyType") for e in data.get("enemies") or [] if isinstance(e.get("enemyType"), str)]
        for rule in rules:
            if isinstance(rule, dict):
                register(rule, "邻近规则")
            pid = rule.get("id") if isinstance(rule, dict) and isinstance(rule.get("id"), str) else None
            problem = proximity_problem(rule)
            if problem:
                error("proximity-field", pid, f"邻近规则 {pid}: {problem}")
                continue
            for kind in rule.get("kinds") or []:
                if kind not in object_kinds:
                    warn("proximity-kind-unused", pid, f"邻近规则 {pid}: 地图里没有 kind 为 {kind} 的物件")
            for enemy_type in rule.get("enemyTypes") or []:
                if enemy_type not in enemy_types:
                    warn("proximity-kind-unused", pid, f"邻近规则 {pid}: 地图里没有 enemyType 为 {enemy_type} 的敌人")

    for note in data.get("reviewNotes") or []:
        nid = register(note, "备注")
        if note.get("status") not in NOTE_STATUSES:
            error("note-status", nid, f"备注 {nid}: status 非法")
        # Absent or "" means "not pinned to an entity"; anything else must name a real id.
        if note.get("targetId") not in (None, "") and (not isinstance(note["targetId"], str) or note["targetId"] not in ids):
            error("note-target", nid, f"备注 {nid}: targetId 不存在 {note['targetId']}")
        if "at" in note:
            if not is_point(note["at"]):
                error("point-invalid", nid, f"备注 {nid}: at 格式错误")
            elif not in_bounds(note["at"]):
                error("point-out-of-bounds", nid, f"备注 {nid}: at 超出 bounds")
        if "floorId" in note and (not isinstance(note["floorId"], str) or note["floorId"] not in floor_by_id):
            error("floor-unknown", nid, f"备注 {nid}: 未知楼层 {note['floorId']}")

    return {"errors": errors, "warnings": warnings}


def main() -> int:
    args = [arg for arg in sys.argv[1:] if arg != "--json"]
    as_json = "--json" in sys.argv[1:]
    if len(args) != 1:
        print("usage: python tools/validate_ai_map.py <level.json> [--json]")
        return 2
    path = Path(args[0])
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        if as_json:
            print(json.dumps({"errors": [{"code": "json-parse", "id": None, "msg": str(exc)}], "warnings": []}, ensure_ascii=False))
        else:
            print(f"ERROR 无法读取 JSON: {exc}")
        return 1
    result = validate(data)
    if as_json:
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result["errors"] else 0
    for item in result["warnings"]:
        print(f"WARN  [{item['code']}] {item['msg']}")
    for item in result["errors"]:
        print(f"ERROR [{item['code']}] {item['msg']}")
    if result["errors"]:
        print(f"AI MAP FAILED: {len(result['errors'])} error(s), {len(result['warnings'])} warning(s)")
        return 1
    print(f"AI MAP OK: {path.name} · {len(data.get('rooms') or [])} rooms · {len(data.get('enemies') or [])} enemies · "
          f"{len(data.get('routes') or [])} routes · {len(data.get('doors') or [])} doors · "
          f"{len(data.get('stairs') or [])} stairs · {len(data.get('water') or [])} water · "
          f"{len(result['warnings'])} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
