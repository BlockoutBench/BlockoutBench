#!/usr/bin/env python3
"""Simulated UE5 Editor level scene for headless testing and zero-UE demos."""
from __future__ import annotations

import copy
import math
from typing import Any

from selection_tracker import normalize_actor


DEFAULT_MOCK_ACTORS: list[dict[str, Any]] = [
    {
        "uid": "/Game/Maps/MainHall.MainHall:PersistentLevel.SM_Pillar_West_01",
        "label": "SM_Pillar_West_01",
        "className": "StaticMeshActor",
        "folder": "Map/1F/Props",
        "locationCm": [1200.0, 800.0, 0.0],
        "rotationDeg": [0.0, 0.0, 0.0],
        "scale": [1.0, 1.0, 1.0],
        "boundsCm": {"originCm": [1200.0, 800.0, 180.0], "extentCm": [60.0, 60.0, 180.0]},
        "assetPath": "/Game/Art/Columns/SM_StonePillar_A.SM_StonePillar_A",
        "tags": ["material:stone", "cover:high"],
    },
    {
        "uid": "/Game/Maps/MainHall.MainHall:PersistentLevel.SM_Pillar_East_02",
        "label": "SM_Pillar_East_02",
        "className": "StaticMeshActor",
        "folder": "Map/1F/Props",
        "locationCm": [1200.0, 1600.0, 0.0],
        "rotationDeg": [0.0, 90.0, 0.0],
        "scale": [1.0, 1.0, 1.0],
        "boundsCm": {"originCm": [1200.0, 1600.0, 180.0], "extentCm": [60.0, 60.0, 180.0]},
        "assetPath": "/Game/Art/Columns/SM_StonePillar_A.SM_StonePillar_A",
        "tags": ["material:stone", "cover:high"],
    },
    {
        "uid": "/Game/Maps/MainHall.MainHall:PersistentLevel.BP_VaultDoor_North",
        "label": "BP_VaultDoor_North",
        "className": "BP_InteractiveDoor_C",
        "folder": "Map/1F/Doors",
        "locationCm": [2000.0, 1200.0, 0.0],
        "rotationDeg": [0.0, 0.0, 0.0],
        "scale": [1.0, 1.0, 1.0],
        "boundsCm": {"originCm": [2000.0, 1200.0, 120.0], "extentCm": [20.0, 110.0, 120.0]},
        "assetPath": "/Game/Blueprints/Interactive/BP_InteractiveDoor.BP_InteractiveDoor_C",
        "tags": ["door:vault", "initial:closed"],
        "properties": {"OpenDuration": 1.2, "RequiresPower": True},
    },
    {
        "uid": "/Game/Maps/MainHall.MainHall:PersistentLevel.PointLight_Altar_Warm",
        "label": "PointLight_Altar_Warm",
        "className": "PointLight",
        "folder": "Map/1F/Lighting",
        "locationCm": [1550.0, 1200.0, 310.0],
        "rotationDeg": [0.0, 0.0, 0.0],
        "scale": [1.0, 1.0, 1.0],
        "boundsCm": {"originCm": [1550.0, 1200.0, 310.0], "extentCm": [25.0, 25.0, 25.0]},
        "assetPath": None,
        "tags": ["mood:warm", "zone:altar"],
        "properties": {"Intensity": 5000.0, "AttenuationRadius": 850.0},
    },
    {
        "uid": "/Game/Maps/MainHall.MainHall:PersistentLevel.SM_AltarTable_Center",
        "label": "SM_AltarTable_Center",
        "className": "StaticMeshActor",
        "folder": "Map/1F/Props",
        "locationCm": [1550.0, 1200.0, 0.0],
        "rotationDeg": [0.0, 0.0, 0.0],
        "scale": [1.2, 1.2, 1.0],
        "boundsCm": {"originCm": [1550.0, 1200.0, 55.0], "extentCm": [110.0, 75.0, 55.0]},
        "assetPath": "/Game/Art/Props/SM_AltarStone.SM_AltarStone",
        "tags": ["cover:low"],
    },
    {
        "uid": "/Game/Maps/MainHall.MainHall:PersistentLevel.SM_Crate_Cover_01",
        "label": "SM_Crate_Cover_01",
        "className": "StaticMeshActor",
        "folder": "Map/1F/Cover",
        "locationCm": [900.0, 1050.0, 0.0],
        "rotationDeg": [0.0, 15.0, 0.0],
        "scale": [1.0, 1.0, 1.0],
        "boundsCm": {"originCm": [900.0, 1050.0, 60.0], "extentCm": [75.0, 75.0, 60.0]},
        "assetPath": "/Game/Art/Props/SM_SupplyCrate.SM_SupplyCrate",
        "tags": ["cover:low"],
    },
]


class MockUnrealWorld:
    """In-memory mock of a UE5 level's actors and active multi-selection."""

    def __init__(self, actors: list[dict[str, Any]] | None = None, level_name: str = "MainHall") -> None:
        self.level_name = level_name
        self.level_path = f"/Game/Maps/{level_name}.{level_name}"
        self.actors: dict[str, dict[str, Any]] = {}
        for raw in actors if actors is not None else DEFAULT_MOCK_ACTORS:
            norm = normalize_actor(copy.deepcopy(raw))
            self.actors[norm["uid"]] = norm
        self.selected_uids: list[str] = []

    def resolve_key(self, token: str) -> str | None:
        """Resolve an actor by exact UID, actor label, or case-insensitive suffix/substring."""
        t = token.strip()
        if not t:
            return None
        if t in self.actors:
            return t
        low = t.lower()
        for uid, actor in self.actors.items():
            if actor["label"].lower() == low or uid.lower() == low:
                return uid
        matches = [uid for uid, actor in self.actors.items() if low in actor["label"].lower() or low in uid.lower()]
        return matches[0] if len(matches) == 1 else (matches[0] if matches else None)

    def set_selection(self, tokens: list[str]) -> list[dict[str, Any]]:
        next_uids: list[str] = []
        for tok in tokens:
            uid = self.resolve_key(tok)
            if uid and uid not in next_uids:
                next_uids.append(uid)
        self.selected_uids = next_uids
        return self.get_selected_actors()

    def add_selection(self, tokens: list[str]) -> list[dict[str, Any]]:
        for tok in tokens:
            uid = self.resolve_key(tok)
            if uid and uid not in self.selected_uids:
                self.selected_uids.append(uid)
        return self.get_selected_actors()

    def remove_selection(self, tokens: list[str]) -> list[dict[str, Any]]:
        drop = {u for tok in tokens if (u := self.resolve_key(tok))}
        self.selected_uids = [u for u in self.selected_uids if u not in drop]
        return self.get_selected_actors()

    def clear_selection(self) -> list[dict[str, Any]]:
        self.selected_uids = []
        return []

    def move_actor(self, token: str, dx_cm: float, dy_cm: float, dz_cm: float) -> dict[str, Any] | None:
        uid = self.resolve_key(token)
        if not uid:
            return None
        actor = self.actors[uid]
        loc = actor["transform"]["locationCm"]
        new_loc = [round(loc[0] + dx_cm, 2), round(loc[1] + dy_cm, 2), round(loc[2] + dz_cm, 2)]
        actor["transform"]["locationCm"] = new_loc
        actor["transform"]["locationM"] = [round(v * 0.01, 3) for v in new_loc]
        bounds = actor.get("boundsCm")
        if bounds:
            org = bounds["originCm"]
            new_org = [round(org[0] + dx_cm, 2), round(org[1] + dy_cm, 2), round(org[2] + dz_cm, 2)]
            ext = bounds["extentCm"]
            bounds["originCm"] = new_org
            bounds["minCm"] = [round(new_org[i] - ext[i], 2) for i in range(3)]
            bounds["maxCm"] = [round(new_org[i] + ext[i], 2) for i in range(3)]
        return copy.deepcopy(actor)

    def get_selected_actors(self) -> list[dict[str, Any]]:
        return [copy.deepcopy(self.actors[u]) for u in self.selected_uids if u in self.actors]

    def find_nearby(self, center_cm: list[float], radius_cm: float = 1500.0, exclude_uids: set[str] | None = None, limit: int = 25) -> list[dict[str, Any]]:
        exclude = exclude_uids or set()
        hits: list[tuple[float, dict[str, Any]]] = []
        for uid, actor in self.actors.items():
            if uid in exclude:
                continue
            loc = actor["transform"]["locationCm"]
            dist = math.sqrt(sum((loc[i] - center_cm[i]) ** 2 for i in range(3)))
            if dist <= radius_cm:
                item = copy.deepcopy(actor)
                item["distanceCm"] = round(dist, 2)
                item["distanceM"] = round(dist * 0.01, 3)
                hits.append((dist, item))
        hits.sort(key=lambda pair: pair[0])
        return [item for _, item in hits[:limit]]
