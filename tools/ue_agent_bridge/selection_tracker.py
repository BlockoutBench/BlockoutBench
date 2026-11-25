#!/usr/bin/env python3
"""UE5 multi-selection & selection history tracker (pure stdlib, engine-agnostic).

Maintains:
1. Click-order-preserving multi-selection (`orderedUids` / `items`), even when the
   underlying editor API returns selected actors in memory/array order.
2. Spatial aggregate summary for multi-selection (`centroid`, `unionBoundsCm`, anchor vs tail).
3. Deduplicated, queryable selection history ring buffer with diff classification
   (`select`, `add`, `remove`, `replace`, `clear`) and actor recent-touch timeline.
4. Atomic JSON state persistence (`os.replace`) so external scripts/Agents can read safely.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import threading
import time
from typing import Any


DEFAULT_STATE_FILE = Path.home() / ".ue_agent_bridge" / "selection_state.json"


def _now_iso(epoch_ms: int | None = None) -> str:
    ms = int(time.time() * 1000) if epoch_ms is None else epoch_ms
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).astimezone().isoformat(timespec="milliseconds")


def _round_vec(vec: Any, ndigits: int = 2, scale: float = 1.0) -> list[float] | None:
    if not isinstance(vec, (list, tuple)) or len(vec) < 3:
        return None
    try:
        return [round(float(vec[0]) * scale, ndigits), round(float(vec[1]) * scale, ndigits), round(float(vec[2]) * scale, ndigits)]
    except (TypeError, ValueError):
        return None


def parse_kv_tags(tags: list[str] | tuple[str, ...] | None) -> dict[str, Any]:
    """Parse generic `key:value` Unreal Actor tags without binding to any specific tool."""
    parsed: dict[str, Any] = {}
    for raw in tags or []:
        text = str(raw).strip()
        if ":" not in text:
            continue
        k, v = text.split(":", 1)
        k = k.strip()
        v = v.strip()
        if not k:
            continue
        if k in parsed:
            prev = parsed[k]
            parsed[k] = [*prev, v] if isinstance(prev, list) else [prev, v]
        else:
            parsed[k] = v
    return parsed


def normalize_actor(raw: dict[str, Any], order_index: int = 0) -> dict[str, Any]:
    """Normalize a raw actor payload into a stable snapshot structure."""
    label = str(raw.get("label") or raw.get("actorLabel") or raw.get("name") or "").strip()
    uid = str(raw.get("uid") or raw.get("pathName") or raw.get("id") or label or f"actor_{order_index}").strip()
    if not label:
        label = uid.rsplit(".", 1)[-1]

    transform_in = raw.get("transform") if isinstance(raw.get("transform"), dict) else {}
    loc_cm = (
        _round_vec(transform_in.get("locationCm"), 2)
        or _round_vec(raw.get("locationCm"), 2)
        or _round_vec(raw.get("location"), 2)
        or [0.0, 0.0, 0.0]
    )
    rot_deg = (
        _round_vec(transform_in.get("rotationDeg"), 2)
        or _round_vec(raw.get("rotationDeg"), 2)
        or _round_vec(raw.get("rotation"), 2)
        or [0.0, 0.0, 0.0]
    )
    scale = (
        _round_vec(transform_in.get("scale"), 3)
        or _round_vec(raw.get("scale"), 3)
        or [1.0, 1.0, 1.0]
    )

    bounds_raw = raw.get("boundsCm") if isinstance(raw.get("boundsCm"), dict) else {}
    origin_cm = _round_vec(bounds_raw.get("originCm"), 2)
    extent_cm = _round_vec(bounds_raw.get("extentCm"), 2)
    min_cm = _round_vec(bounds_raw.get("minCm"), 2)
    max_cm = _round_vec(bounds_raw.get("maxCm"), 2)
    if origin_cm and extent_cm and (min_cm is None or max_cm is None):
        min_cm = [round(origin_cm[i] - extent_cm[i], 2) for i in range(3)]
        max_cm = [round(origin_cm[i] + extent_cm[i], 2) for i in range(3)]
    elif min_cm and max_cm and (origin_cm is None or extent_cm is None):
        origin_cm = [round((min_cm[i] + max_cm[i]) * 0.5, 2) for i in range(3)]
        extent_cm = [round(abs(max_cm[i] - min_cm[i]) * 0.5, 2) for i in range(3)]

    bounds_cm = None
    if min_cm and max_cm and origin_cm and extent_cm:
        bounds_cm = {
            "originCm": origin_cm,
            "extentCm": extent_cm,
            "minCm": min_cm,
            "maxCm": max_cm,
        }

    tags = [str(t) for t in (raw.get("tags") or []) if str(t).strip()]
    snapshot: dict[str, Any] = {
        "uid": uid,
        "label": label,
        "className": str(raw.get("className") or raw.get("class") or "Actor"),
        "folder": str(raw.get("folder") or raw.get("folderPath") or ""),
        "orderIndex": int(order_index),
        "transform": {
            "locationCm": loc_cm,
            "locationM": _round_vec(loc_cm, 3, 0.01),
            "rotationDeg": rot_deg,
            "scale": scale,
        },
        "boundsCm": bounds_cm,
        "assetPath": raw.get("assetPath") or None,
        "tags": tags,
        "parsedTags": parse_kv_tags(tags),
        "properties": raw.get("properties") if isinstance(raw.get("properties"), dict) else {},
    }
    return snapshot


def compute_multi_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute bounding volume, centroid, click roles, and class breakdown for selected actors."""
    count = len(items)
    if count == 0:
        return {
            "count": 0,
            "isMulti": False,
            "centroidCm": None,
            "centroidM": None,
            "unionBoundsCm": None,
            "classCounts": {},
            "folders": [],
            "firstSelectedUid": None,
            "lastSelectedUid": None,
        }

    locs = [it["transform"]["locationCm"] for it in items]
    cx = round(sum(p[0] for p in locs) / count, 2)
    cy = round(sum(p[1] for p in locs) / count, 2)
    cz = round(sum(p[2] for p in locs) / count, 2)

    min_v = [math.inf, math.inf, math.inf]
    max_v = [-math.inf, -math.inf, -math.inf]
    for it in items:
        b = it.get("boundsCm")
        if b and b.get("minCm") and b.get("maxCm"):
            lo, hi = b["minCm"], b["maxCm"]
        else:
            lo = hi = it["transform"]["locationCm"]
        for i in range(3):
            min_v[i] = min(min_v[i], float(lo[i]))
            max_v[i] = max(max_v[i], float(hi[i]))

    union_min = [round(min_v[i], 2) for i in range(3)]
    union_max = [round(max_v[i], 2) for i in range(3)]
    union_size = [round(union_max[i] - union_min[i], 2) for i in range(3)]

    class_counts: dict[str, int] = {}
    folders: list[str] = []
    seen_folders: set[str] = set()
    for it in items:
        cls = it.get("className") or "Actor"
        class_counts[cls] = class_counts.get(cls, 0) + 1
        fld = it.get("folder") or ""
        if fld and fld not in seen_folders:
            seen_folders.add(fld)
            folders.append(fld)

    return {
        "count": count,
        "isMulti": count > 1,
        "centroidCm": [cx, cy, cz],
        "centroidM": _round_vec([cx, cy, cz], 3, 0.01),
        "unionBoundsCm": {
            "minCm": union_min,
            "maxCm": union_max,
            "sizeCm": union_size,
            "sizeM": _round_vec(union_size, 3, 0.01),
        },
        "classCounts": class_counts,
        "folders": folders,
        "firstSelectedUid": items[0]["uid"],
        "lastSelectedUid": items[-1]["uid"],
    }


def _actor_search_haystack(item: dict[str, Any]) -> str:
    parts = [
        item.get("uid", ""),
        item.get("label", ""),
        item.get("className", ""),
        item.get("folder", ""),
        item.get("assetPath") or "",
        " ".join(item.get("tags") or []),
    ]
    return " ".join(str(p) for p in parts if p).lower()


def _matches_actor_filters(item: dict[str, Any], class_filter: str | None, text_query: str | None) -> bool:
    if class_filter:
        cf = class_filter.strip().lower()
        if cf and cf not in str(item.get("className", "")).lower():
            return False
    if text_query:
        q = text_query.strip().lower()
        if q and q not in _actor_search_haystack(item):
            return False
    return True


def classify_selection_change(prev_uids: list[str], next_uids: list[str]) -> tuple[str, list[str], list[str], list[str]]:
    """Classify set transition while computing ordered additions/removals/kept UIDs."""
    prev_set = set(prev_uids)
    next_set = set(next_uids)
    added = [u for u in next_uids if u not in prev_set]
    removed = [u for u in prev_uids if u not in next_set]
    kept = [u for u in prev_uids if u in next_set]

    if not next_uids and prev_uids:
        return "clear", added, removed, kept
    if not prev_uids and next_uids:
        return "select", added, removed, kept
    if added and not removed:
        return "add", added, removed, kept
    if removed and not added:
        return "remove", added, removed, kept
    if added and removed:
        return "replace", added, removed, kept
    return "unchanged", added, removed, kept


@dataclass
class SelectionTracker:
    """Thread-safe tracker for UE5 multi-selection, ordered history, and recent actors."""

    max_history: int = 50
    max_recent_actors: int = 100
    level_name: str = ""
    level_path: str = ""
    seq: int = 0
    _ordered_uids: list[str] = field(default_factory=list)
    _current_items: list[dict[str, Any]] = field(default_factory=list)
    _history: list[dict[str, Any]] = field(default_factory=list)
    _recent_actors: dict[str, dict[str, Any]] = field(default_factory=dict)
    _updated_epoch_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def update(
        self,
        raw_actors: list[dict[str, Any]] | None,
        *,
        level_name: str | None = None,
        level_path: str | None = None,
        source: str = "ue-viewport",
        preserve_order: bool = True,
        epoch_ms: int | None = None,
    ) -> tuple[bool, dict[str, Any] | None]:
        """Ingest current actor list from UE or mock; returns `(changed_selection_set, new_history_entry)`."""
        with self._lock:
            ts_ms = int(time.time() * 1000) if epoch_ms is None else int(epoch_ms)
            if level_name is not None:
                self.level_name = str(level_name)
            if level_path is not None:
                self.level_path = str(level_path)

            # De-duplicate by uid while keeping input order for newly introduced actors.
            incoming_by_uid: dict[str, dict[str, Any]] = {}
            incoming_order: list[str] = []
            for idx, raw in enumerate(raw_actors or []):
                norm = normalize_actor(raw, idx)
                uid = norm["uid"]
                if uid not in incoming_by_uid:
                    incoming_by_uid[uid] = norm
                    incoming_order.append(uid)

            if preserve_order and self._ordered_uids:
                kept_order = [u for u in self._ordered_uids if u in incoming_by_uid]
                kept_set = set(kept_order)
                added_order = [u for u in incoming_order if u not in kept_set]
                next_uids = kept_order + added_order
            else:
                next_uids = incoming_order

            next_items: list[dict[str, Any]] = []
            for order_idx, uid in enumerate(next_uids):
                item = dict(incoming_by_uid[uid])
                item["orderIndex"] = order_idx
                next_items.append(item)

            change_type, added, removed, kept = classify_selection_change(self._ordered_uids, next_uids)
            set_changed = change_type != "unchanged"

            # Always refresh live transforms/properties on current items.
            transforms_changed = json.dumps(self._current_items, sort_keys=True, ensure_ascii=False) != json.dumps(
                next_items, sort_keys=True, ensure_ascii=False
            )
            self._ordered_uids = next_uids
            self._current_items = next_items
            if set_changed or transforms_changed:
                self._updated_epoch_ms = ts_ms

            if not set_changed:
                for it in next_items:
                    uid = it["uid"]
                    if uid in self._recent_actors:
                        self._recent_actors[uid]["actor"] = it
                return False, None

            self.seq += 1
            iso = _now_iso(ts_ms)
            entry = {
                "seq": self.seq,
                "epochMs": ts_ms,
                "timestamp": iso,
                "source": source,
                "levelName": self.level_name,
                "changeType": change_type,
                "addedIds": added,
                "removedIds": removed,
                "keptIds": kept,
                "count": len(next_items),
                "orderedUids": list(next_uids),
                "summary": compute_multi_summary(next_items),
                "items": next_items,
                "bookmark": None,
            }
            self._history.append(entry)
            if len(self._history) > max(1, self.max_history):
                self._history = self._history[-self.max_history :]

            # Update recent actor touch log (only on actual new touch / re-focus).
            touched = set(added) if self.seq > 1 and change_type in ("add", "replace") else set(next_uids)
            for it in next_items:
                uid = it["uid"]
                rec = self._recent_actors.get(uid)
                if rec is None:
                    self._recent_actors[uid] = {
                        "uid": uid,
                        "touchCount": 1,
                        "firstTouchedMs": ts_ms,
                        "lastTouchedMs": ts_ms,
                        "lastTouchedIso": iso,
                        "lastSeq": self.seq,
                        "actor": it,
                    }
                else:
                    if uid in touched:
                        rec["touchCount"] += 1
                    rec["lastTouchedMs"] = ts_ms
                    rec["lastTouchedIso"] = iso
                    rec["lastSeq"] = self.seq
                    rec["actor"] = it

            if len(self._recent_actors) > max(1, self.max_recent_actors):
                oldest = sorted(self._recent_actors.values(), key=lambda r: (r["lastTouchedMs"], r["lastSeq"]))
                drop_count = len(self._recent_actors) - self.max_recent_actors
                for rec in oldest[:drop_count]:
                    self._recent_actors.pop(rec["uid"], None)

            return True, entry

    def add_bookmark(self, label: str, note: str = "", seq: int | None = None) -> dict[str, Any] | None:
        """Attach a human/Agent bookmark note onto a history step (default: latest)."""
        with self._lock:
            target = None
            if seq is None and self._history:
                target = self._history[-1]
            elif seq is not None:
                target = next((h for h in self._history if h["seq"] == seq), None)
            if target is None:
                return None
            target["bookmark"] = {
                "label": str(label).strip() or "bookmark",
                "note": str(note).strip(),
                "markedAt": _now_iso(),
            }
            self._updated_epoch_ms = int(time.time() * 1000)
            return dict(target["bookmark"])

    def get_current(self) -> dict[str, Any]:
        """Return the active multi-selection state plus multi-object spatial summary."""
        with self._lock:
            items = list(self._current_items)
            return {
                "levelName": self.level_name,
                "levelPath": self.level_path,
                "seq": self.seq,
                "updatedEpochMs": self._updated_epoch_ms,
                "updatedAt": _now_iso(self._updated_epoch_ms),
                "orderedUids": list(self._ordered_uids),
                "summary": compute_multi_summary(items),
                "items": items,
            }

    def query_history(
        self,
        *,
        limit: int = 10,
        offset: int = 0,
        non_empty_only: bool = False,
        class_filter: str | None = None,
        text_query: str | None = None,
        since_sec: float | None = None,
        bookmarked_only: bool = False,
        include_items: bool = True,
    ) -> dict[str, Any]:
        """Query selection history newest-first with offset, filters, and compact item mode."""
        with self._lock:
            now_ms = int(time.time() * 1000)
            min_ms = (now_ms - int(since_sec * 1000)) if since_sec is not None and since_sec >= 0 else None
            rows: list[dict[str, Any]] = []
            for entry in reversed(self._history):
                if non_empty_only and entry["count"] == 0:
                    continue
                if bookmarked_only and not entry.get("bookmark"):
                    continue
                if min_ms is not None and entry["epochMs"] < min_ms:
                    continue
                if class_filter or text_query:
                    if not any(_matches_actor_filters(it, class_filter, text_query) for it in entry["items"]):
                        continue
                rows.append(entry)

            total = len(rows)
            start = max(0, int(offset))
            cap = max(1, int(limit))
            sliced = rows[start : start + cap]

            out_entries = []
            for idx, entry in enumerate(sliced):
                steps_ago = self.seq - entry["seq"]
                item_view = (
                    entry["items"]
                    if include_items
                    else [{"uid": it["uid"], "label": it["label"], "className": it["className"], "locationM": it["transform"]["locationM"]} for it in entry["items"]]
                )
                out_entries.append({
                    **entry,
                    "stepsAgo": steps_ago,
                    "resultRank": start + idx,
                    "items": item_view,
                })

            return {
                "totalMatched": total,
                "historySize": len(self._history),
                "currentSeq": self.seq,
                "offset": start,
                "limit": cap,
                "entries": out_entries,
            }

    def get_recent_actors(
        self,
        *,
        limit: int = 20,
        class_filter: str | None = None,
        text_query: str | None = None,
    ) -> dict[str, Any]:
        """Return deduplicated distinct UE actors sorted by most-recently selected."""
        with self._lock:
            active_set = set(self._ordered_uids)
            rows = []
            for rec in sorted(
                self._recent_actors.values(),
                key=lambda r: (r["lastTouchedMs"], r["lastSeq"]),
                reverse=True,
            ):
                if not _matches_actor_filters(rec["actor"], class_filter, text_query):
                    continue
                rows.append({
                    **rec,
                    "currentlySelected": rec["uid"] in active_set,
                })
            cap = max(1, int(limit))
            return {
                "totalDistinct": len(rows),
                "actors": rows[:cap],
            }

    def diff_states(self, seq_a: int | None = None, seq_b: int | None = None) -> dict[str, Any]:
        """Diff two history states (defaults to previous non-empty selection vs current)."""
        with self._lock:
            entry_b = (
                next((h for h in self._history if h["seq"] == seq_b), None)
                if seq_b is not None
                else (self._history[-1] if self._history else None)
            )
            if seq_a is not None:
                entry_a = next((h for h in self._history if h["seq"] == seq_a), None)
            else:
                b_seq = entry_b["seq"] if entry_b else self.seq + 1
                entry_a = next(
                    (h for h in reversed(self._history) if h["seq"] < b_seq and h["count"] > 0),
                    None,
                )

            uids_a = entry_a["orderedUids"] if entry_a else []
            uids_b = entry_b["orderedUids"] if entry_b else []
            map_a = {it["uid"]: it for it in (entry_a["items"] if entry_a else [])}
            map_b = {it["uid"]: it for it in (entry_b["items"] if entry_b else [])}

            set_a, set_b = set(uids_a), set(uids_b)
            added = [map_b[u] for u in uids_b if u not in set_a]
            removed = [map_a[u] for u in uids_a if u not in set_b]
            kept = [map_b[u] for u in uids_b if u in set_a]

            moved = []
            for it_b in kept:
                it_a = map_a[it_b["uid"]]
                la, lb = it_a["transform"]["locationCm"], it_b["transform"]["locationCm"]
                delta = [round(lb[i] - la[i], 2) for i in range(3)]
                if any(abs(d) > 0.05 for d in delta):
                    moved.append({"uid": it_b["uid"], "label": it_b["label"], "deltaCm": delta})

            return {
                "fromSeq": entry_a["seq"] if entry_a else None,
                "toSeq": entry_b["seq"] if entry_b else None,
                "fromTimestamp": entry_a["timestamp"] if entry_a else None,
                "toTimestamp": entry_b["timestamp"] if entry_b else None,
                "addedCount": len(added),
                "removedCount": len(removed),
                "keptCount": len(kept),
                "movedCount": len(moved),
                "added": added,
                "removed": removed,
                "kept": kept,
                "moved": moved,
            }

    def to_state_dict(self) -> dict[str, Any]:
        with self._lock:
            return {
                "schema": "ue-selection-bridge/v1",
                "levelName": self.level_name,
                "levelPath": self.level_path,
                "seq": self.seq,
                "updatedEpochMs": self._updated_epoch_ms,
                "updatedAt": _now_iso(self._updated_epoch_ms),
                "current": self.get_current(),
                "history": list(self._history),
                "recentActors": list(self._recent_actors.values()),
            }

    @classmethod
    def from_state_dict(cls, payload: dict[str, Any], *, max_history: int = 50, max_recent_actors: int = 100) -> "SelectionTracker":
        tracker = cls(
            max_history=max_history,
            max_recent_actors=max_recent_actors,
            level_name=str(payload.get("levelName") or ""),
            level_path=str(payload.get("levelPath") or ""),
            seq=int(payload.get("seq") or 0),
        )
        cur = payload.get("current") or {}
        cur_items = [normalize_actor(it, i) for i, it in enumerate(cur.get("items") or [])]
        tracker._current_items = cur_items
        tracker._ordered_uids = [it["uid"] for it in cur_items]
        tracker._history = list(payload.get("history") or [])[-max_history:]
        tracker._recent_actors = {
            str(r["uid"]): r for r in (payload.get("recentActors") or []) if isinstance(r, dict) and r.get("uid")
        }
        tracker._updated_epoch_ms = int(payload.get("updatedEpochMs") or cur.get("updatedEpochMs") or time.time() * 1000)
        return tracker


def save_state_atomic(tracker: SelectionTracker, path: str | Path) -> Path:
    """Persist tracker state atomically (`tmp -> os.replace`) so readers never see partial JSON."""
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f"{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    data = json.dumps(tracker.to_state_dict(), ensure_ascii=False, indent=2) + "\n"
    tmp.write_text(data, encoding="utf-8")
    os.replace(tmp, target)
    return target


def load_tracker_from_file(path: str | Path) -> SelectionTracker | None:
    target = Path(path).expanduser()
    if not target.exists():
        return None
    raw = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        return None
    return SelectionTracker.from_state_dict(raw)
