#!/usr/bin/env python3
"""UE5 Editor Selection & History Bridge (pure stdlib; works inside UE5 Python or offline --mock).

Exposes:
1. Local HTTP API (`127.0.0.1:18136` by default) for live multi-selection, history queries,
   recent-actor lookups, state diffs, bookmarks, and nearby spatial context.
2. Atomic JSON state file sync (`~/.ue_agent_bridge/selection_state.json` by default) so even file-reading
   agents stay synced without network calls.
3. Safe UE5 Game-Thread integration via `unreal.register_slate_post_tick_callback` so `unreal.*`
   subsystems are never touched from HTTP worker threads.

Run inside UE5 Python Console:
    py "C:/path/to/tools/ue_agent_bridge/ue_editor_bridge.py"

Run standalone offline demo/simulator:
    python tools/ue_agent_bridge/ue_editor_bridge.py --mock --demo-steps
"""
from __future__ import annotations

import argparse
import builtins
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import queue
import sys
import threading
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from mock_scene import MockUnrealWorld  # noqa: E402
from selection_tracker import (  # noqa: E402
    DEFAULT_STATE_FILE,
    SelectionTracker,
    normalize_actor,
    save_state_atomic,
)

try:
    import unreal  # type: ignore

    HAS_UNREAL = True
except ImportError:
    unreal = None
    HAS_UNREAL = False


DEFAULT_PORT = 18136
_SINGLETON_ATTR = "_ue_agent_bridge_runtime_singleton"


def _extract_unreal_actor_dict(actor: Any, idx: int = 0) -> dict[str, Any]:
    """Read native UE5 properties of an AActor cleanly on the UE Game Thread."""
    uid = ""
    try:
        uid = str(actor.get_path_name())
    except Exception:
        uid = str(getattr(actor, "get_name", lambda: f"actor_{idx}")())

    label = uid.rsplit(".", 1)[-1]
    try:
        label = str(actor.get_actor_label()) or label
    except Exception:
        pass

    class_name = "Actor"
    try:
        class_name = str(actor.get_class().get_name())
    except Exception:
        pass

    folder = ""
    try:
        fld = str(actor.get_folder_path())
        folder = "" if fld == "None" else fld
    except Exception:
        pass

    loc_cm = [0.0, 0.0, 0.0]
    rot_deg = [0.0, 0.0, 0.0]
    scale = [1.0, 1.0, 1.0]
    try:
        loc = actor.get_actor_location()
        loc_cm = [float(loc.x), float(loc.y), float(loc.z)]
        rot = actor.get_actor_rotation()
        rot_deg = [float(rot.pitch), float(rot.yaw), float(rot.roll)]
        sc = actor.get_actor_scale3d()
        scale = [float(sc.x), float(sc.y), float(sc.z)]
    except Exception:
        pass

    bounds_cm = None
    try:
        origin, extent = actor.get_actor_bounds(False)
        bounds_cm = {
            "originCm": [float(origin.x), float(origin.y), float(origin.z)],
            "extentCm": [float(extent.x), float(extent.y), float(extent.z)],
        }
    except Exception:
        pass

    asset_path = None
    try:
        sm_comp = actor.get_component_by_class(unreal.StaticMeshComponent)
        if sm_comp:
            sm = getattr(sm_comp, "static_mesh", None) or sm_comp.get_editor_property("static_mesh")
            if sm:
                asset_path = str(sm.get_path_name())
        if asset_path is None:
            sk_comp = actor.get_component_by_class(unreal.SkeletalMeshComponent)
            if sk_comp:
                sk = sk_comp.get_editor_property("skeletal_mesh_asset") or getattr(sk_comp, "skeletal_mesh", None)
                if sk:
                    asset_path = str(sk.get_path_name())
    except Exception:
        pass

    tags = []
    try:
        tags = [str(t) for t in getattr(actor, "tags", []) if str(t).strip()]
    except Exception:
        pass

    return normalize_actor(
        {
            "uid": uid,
            "label": label,
            "className": class_name,
            "folder": folder,
            "transform": {"locationCm": loc_cm, "rotationDeg": rot_deg, "scale": scale},
            "boundsCm": bounds_cm,
            "assetPath": asset_path,
            "tags": tags,
        },
        order_index=idx,
    )


def _read_unreal_world_info() -> tuple[str, str]:
    try:
        editor_sub = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
        world = editor_sub.get_editor_world()
        if world:
            return str(world.get_name()), str(world.get_path_name())
    except Exception:
        pass
    return "", ""


def _read_unreal_selection() -> list[dict[str, Any]]:
    actor_sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    selected = list(actor_sub.get_selected_level_actors() or [])
    return [_extract_unreal_actor_dict(a, i) for i, a in enumerate(selected)]


def _read_unreal_nearby(center_cm: list[float], radius_cm: float, exclude_uids: set[str], limit: int = 25) -> list[dict[str, Any]]:
    actor_sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    all_actors = list(actor_sub.get_all_level_actors() or [])
    hits: list[tuple[float, dict[str, Any]]] = []
    for actor in all_actors:
        try:
            uid = str(actor.get_path_name())
        except Exception:
            continue
        if uid in exclude_uids:
            continue
        try:
            loc = actor.get_actor_location()
            dist = math.sqrt((float(loc.x) - center_cm[0]) ** 2 + (float(loc.y) - center_cm[1]) ** 2 + (float(loc.z) - center_cm[2]) ** 2)
        except Exception:
            continue
        if dist <= radius_cm:
            item = _extract_unreal_actor_dict(actor)
            item["distanceCm"] = round(dist, 2)
            item["distanceM"] = round(dist * 0.01, 3)
            hits.append((dist, item))
    hits.sort(key=lambda pair: pair[0])
    return [item for _, item in hits[:limit]]


@dataclass
class MainThreadTask:
    fn: Any
    done: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: str | None = None


class UEAgentBridgeServer:
    """Hosts the UE5 selection watcher, atomic JSON writer, and localhost HTTP server."""

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: int = DEFAULT_PORT,
        state_file: str | Path = DEFAULT_STATE_FILE,
        poll_interval_sec: float = 0.15,
        max_history: int = 50,
        mock_world: MockUnrealWorld | None = None,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.state_file = Path(state_file).expanduser()
        self.poll_interval_sec = max(0.05, float(poll_interval_sec))
        self.tracker = SelectionTracker(max_history=max_history)
        self.mock_world = mock_world if mock_world is not None else (None if HAS_UNREAL else MockUnrealWorld())
        self.mode = "unreal" if (HAS_UNREAL and self.mock_world is None) else "mock"

        self._httpd: ThreadingHTTPServer | None = None
        self._http_thread: threading.Thread | None = None
        self._tick_handle: Any = None
        self._task_queue: queue.Queue[MainThreadTask] = queue.Queue()
        self._started_at_ms = int(time.time() * 1000)
        self._last_poll_mono = 0.0
        self._last_write_epoch_ms = -1
        self._running = False

    def poll_once(self) -> tuple[bool, dict[str, Any] | None]:
        """Synchronize tracker once from UE5 Game Thread or mock world."""
        if self.mode == "unreal":
            level_name, level_path = _read_unreal_world_info()
            actors = _read_unreal_selection()
        else:
            assert self.mock_world is not None
            level_name, level_path = self.mock_world.level_name, self.mock_world.level_path
            actors = self.mock_world.get_selected_actors()

        changed, entry = self.tracker.update(actors, level_name=level_name, level_path=level_path, source=f"ue-{self.mode}")
        cur_updated = self.tracker.get_current()["updatedEpochMs"]
        if changed or cur_updated != self._last_write_epoch_ms:
            save_state_atomic(self.tracker, self.state_file)
            self._last_write_epoch_ms = cur_updated
        return changed, entry

    def run_on_main_thread(self, fn: Any, timeout_sec: float = 2.0) -> Any:
        """Dispatch UE subsystem call cleanly to the active main/tick thread."""
        if self.mode == "mock" or threading.current_thread() is threading.main_thread():
            return fn()
        task = MainThreadTask(fn=fn)
        self._task_queue.put(task)
        if not task.done.wait(timeout=timeout_sec):
            raise TimeoutError("Timed out waiting for UE Game Thread tick")
        if task.error:
            raise RuntimeError(task.error)
        return task.result

    def _drain_main_thread_tasks(self) -> None:
        while True:
            try:
                task = self._task_queue.get_nowait()
            except queue.Empty:
                break
            try:
                task.result = task.fn()
            except Exception as exc:  # pragma: no cover - defensive runtime guard
                task.error = str(exc)
            finally:
                task.done.set()

    def _on_slate_tick(self, _delta: float) -> None:  # pragma: no cover - invoked by UE5 Slate
        self._drain_main_thread_tasks()
        now = time.monotonic()
        if now - self._last_poll_mono >= self.poll_interval_sec:
            self._last_poll_mono = now
            self.poll_once()

    def get_nearby(self, center_cm: list[float], radius_cm: float, exclude_uids: set[str], limit: int = 25) -> list[dict[str, Any]]:
        if self.mode == "unreal":
            return self.run_on_main_thread(lambda: _read_unreal_nearby(center_cm, radius_cm, exclude_uids, limit))
        assert self.mock_world is not None
        return self.mock_world.find_nearby(center_cm, radius_cm=radius_cm, exclude_uids=exclude_uids, limit=limit)

    def _make_handler(self):
        bridge = self

        class BridgeHandler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                return

            def _send(self, code: int, payload: Any) -> None:
                body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _read_json_body(self) -> dict[str, Any]:
                length = int(self.headers.get("Content-Length", "0") or "0")
                if length <= 0:
                    return {}
                raw = self.rfile.read(length).decode("utf-8")
                data = json.loads(raw)
                return data if isinstance(data, dict) else {}

            def do_OPTIONS(self) -> None:
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()

            def do_GET(self) -> None:
                parsed = urlparse(self.path)
                qs = parse_qs(parsed.query)
                path = parsed.path

                if path == "/health":
                    cur = bridge.tracker.get_current()
                    self._send(200, {
                        "ok": True,
                        "mode": bridge.mode,
                        "port": bridge.port,
                        "levelName": cur["levelName"],
                        "levelPath": cur["levelPath"],
                        "selectedCount": cur["summary"]["count"],
                        "seq": cur["seq"],
                        "historySize": len(bridge.tracker._history),
                        "stateFile": str(bridge.state_file.resolve()),
                        "uptimeSec": round((time.time() * 1000 - bridge._started_at_ms) / 1000.0, 2),
                    })
                    return

                if path == "/selection":
                    if qs.get("refresh", ["0"])[0] in ("1", "true"):
                        bridge.run_on_main_thread(bridge.poll_once)
                    cur = bridge.tracker.get_current()
                    radius_raw = qs.get("nearbyRadiusCm", [None])[0]
                    if radius_raw is not None:
                        try:
                            radius_cm = max(50.0, min(20000.0, float(radius_raw)))
                        except ValueError:
                            radius_cm = 1500.0
                        centroid = cur["summary"]["centroidCm"]
                        if centroid:
                            cur["nearbyRadiusCm"] = radius_cm
                            cur["nearby"] = bridge.get_nearby(centroid, radius_cm, set(cur["orderedUids"]))
                        else:
                            cur["nearbyRadiusCm"] = radius_cm
                            cur["nearby"] = []
                    self._send(200, cur)
                    return

                if path == "/history":
                    def _qs_int(name: str, default: int) -> int:
                        try:
                            return int(qs.get(name, [str(default)])[0])
                        except (TypeError, ValueError):
                            return default

                    limit = _qs_int("limit", 10)
                    offset = _qs_int("offset", 0)
                    non_empty = qs.get("nonEmpty", ["0"])[0] in ("1", "true")
                    bookmarked = qs.get("bookmarked", ["0"])[0] in ("1", "true")
                    include_items = qs.get("compact", ["0"])[0] not in ("1", "true")
                    class_filter = qs.get("class", [None])[0]
                    text_query = qs.get("q", [None])[0]
                    since_raw = qs.get("sinceSec", [None])[0]
                    try:
                        since_sec = float(since_raw) if since_raw is not None else None
                    except (TypeError, ValueError):
                        since_sec = None
                    self._send(200, bridge.tracker.query_history(
                        limit=limit,
                        offset=offset,
                        non_empty_only=non_empty,
                        class_filter=class_filter,
                        text_query=text_query,
                        since_sec=since_sec,
                        bookmarked_only=bookmarked,
                        include_items=include_items,
                    ))
                    return

                if path == "/history/diff":
                    try:
                        seq_a = int(qs["fromSeq"][0]) if "fromSeq" in qs else None
                        seq_b = int(qs["toSeq"][0]) if "toSeq" in qs else None
                    except (TypeError, ValueError):
                        self._send(400, {"error": "fromSeq and toSeq must be integers"})
                        return
                    self._send(200, bridge.tracker.diff_states(seq_a, seq_b))
                    return

                if path == "/recent-actors":
                    try:
                        limit = int(qs.get("limit", ["20"])[0])
                    except (TypeError, ValueError):
                        limit = 20
                    class_filter = qs.get("class", [None])[0]
                    text_query = qs.get("q", [None])[0]
                    self._send(200, bridge.tracker.get_recent_actors(limit=limit, class_filter=class_filter, text_query=text_query))
                    return

                self._send(404, {"error": f"Unknown endpoint: {path}"})

            def do_POST(self) -> None:
                parsed = urlparse(self.path)
                path = parsed.path
                try:
                    body = self._read_json_body()
                except Exception as exc:
                    self._send(400, {"error": f"Invalid JSON body: {exc}"})
                    return

                if path == "/selection/bookmark":
                    label = str(body.get("label") or "bookmark")
                    note = str(body.get("note") or "")
                    seq = body.get("seq")
                    res = bridge.tracker.add_bookmark(label, note, seq=int(seq) if seq is not None else None)
                    if res is None:
                        self._send(404, {"error": "No matching history step to bookmark"})
                        return
                    save_state_atomic(bridge.tracker, bridge.state_file)
                    self._send(200, {"ok": True, "bookmark": res})
                    return

                if path.startswith("/mock/") and bridge.mode == "mock" and bridge.mock_world is not None:
                    action = path.split("/mock/", 1)[1]
                    targets = body.get("actors") or ([] if body.get("actor") is None else [body.get("actor")])
                    if action == "select":
                        bridge.mock_world.set_selection([str(t) for t in targets])
                    elif action == "add":
                        bridge.mock_world.add_selection([str(t) for t in targets])
                    elif action == "remove":
                        bridge.mock_world.remove_selection([str(t) for t in targets])
                    elif action == "clear":
                        bridge.mock_world.clear_selection()
                    elif action == "move":
                        target = str(body.get("actor") or "")
                        delta = body.get("deltaCm") or [0, 0, 0]
                        bridge.mock_world.move_actor(target, float(delta[0]), float(delta[1]), float(delta[2]))
                    else:
                        self._send(404, {"error": f"Unknown mock action: {action}"})
                        return
                    bridge.poll_once()
                    self._send(200, {"ok": True, "selection": bridge.tracker.get_current()})
                    return

                self._send(404, {"error": f"Unknown endpoint: {path}"})

        return BridgeHandler

    def start(self) -> "UEAgentBridgeServer":
        if self._running:
            return self
        ThreadingHTTPServer.allow_reuse_address = True
        self._httpd = ThreadingHTTPServer((self.host, self.port), self._make_handler())
        self.port = int(self._httpd.server_address[1])
        self._running = True
        self.poll_once()

        self._http_thread = threading.Thread(target=self._httpd.serve_forever, daemon=True, name="UEAgentBridgeHTTP")
        self._http_thread.start()

        if self.mode == "unreal":  # pragma: no cover - runs only inside Unreal Editor
            self._tick_handle = unreal.register_slate_post_tick_callback(self._on_slate_tick)

        setattr(builtins, _SINGLETON_ATTR, self)
        return self

    def stop(self) -> None:
        self._running = False
        if self._tick_handle is not None and HAS_UNREAL:  # pragma: no cover
            try:
                unreal.unregister_slate_post_tick_callback(self._tick_handle)
            except Exception:
                pass
            self._tick_handle = None
        if self._httpd is not None:
            try:
                self._httpd.shutdown()
                self._httpd.server_close()
            except Exception:
                pass
            self._httpd = None
        if getattr(builtins, _SINGLETON_ATTR, None) is self:
            delattr(builtins, _SINGLETON_ATTR)


def start_bridge(**kwargs: Any) -> UEAgentBridgeServer:
    """Idempotent entry point: cleanly stops any earlier instance before binding."""
    prev = getattr(builtins, _SINGLETON_ATTR, None)
    if prev is not None:
        prev.stop()
    srv = UEAgentBridgeServer(**kwargs)
    return srv.start()


def stop_bridge() -> bool:
    prev = getattr(builtins, _SINGLETON_ATTR, None)
    if prev is not None:
        prev.stop()
        return True
    return False


def _seed_demo_history(bridge: UEAgentBridgeServer) -> None:
    """Populate realistic multi-select & history transitions in mock mode."""
    assert bridge.mock_world is not None
    w = bridge.mock_world
    for step_fn in (
        lambda: w.set_selection(["SM_Crate_Cover_01"]),
        lambda: w.set_selection(["SM_Pillar_West_01"]),
        lambda: w.add_selection(["SM_Pillar_East_02"]),
        lambda: w.set_selection(["BP_VaultDoor_North", "PointLight_Altar_Warm"]),
        lambda: w.remove_selection(["PointLight_Altar_Warm"]),
        lambda: w.add_selection(["SM_AltarTable_Center"]),
    ):
        step_fn()
        bridge.poll_once()
        time.sleep(0.01)


def _run_mock_interactive(bridge: UEAgentBridgeServer) -> None:
    assert bridge.mock_world is not None
    print(f"[UEAgentBridge mock] HTTP=http://{bridge.host}:{bridge.port}  state={bridge.state_file}", file=sys.stderr)
    print("[UEAgentBridge mock] Available actors:", ", ".join(a["label"] for a in bridge.mock_world.actors.values()), file=sys.stderr)
    print("[UEAgentBridge mock] Commands: select <a...>, add <a...>, remove <a...>, clear, move <a> dx dy dz, history, quit", file=sys.stderr)
    if not sys.stdin or sys.stdin.closed:
        while True:
            time.sleep(1.0)
    try:
        while True:
            line = input("ue-mock> ").strip()
            if not line:
                continue
            parts = line.split()
            cmd, rest = parts[0].lower(), parts[1:]
            if cmd in ("quit", "exit", "q"):
                break
            elif cmd == "select":
                bridge.mock_world.set_selection(rest)
            elif cmd == "add":
                bridge.mock_world.add_selection(rest)
            elif cmd == "remove":
                bridge.mock_world.remove_selection(rest)
            elif cmd == "clear":
                bridge.mock_world.clear_selection()
            elif cmd == "move" and len(rest) >= 4:
                bridge.mock_world.move_actor(rest[0], float(rest[1]), float(rest[2]), float(rest[3]))
            elif cmd == "history":
                print(json.dumps(bridge.tracker.query_history(limit=8, include_items=False), ensure_ascii=False, indent=2))
                continue
            elif cmd == "current":
                print(json.dumps(bridge.tracker.get_current(), ensure_ascii=False, indent=2))
                continue
            else:
                print("Unknown command. Try: select / add / remove / clear / move / current / history / quit")
                continue
            bridge.poll_once()
            cur = bridge.tracker.get_current()
            labels = [it["label"] for it in cur["items"]]
            print(f"seq={cur['seq']} selected({len(labels)}): {labels}")
    except (EOFError, KeyboardInterrupt):
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="UE5 Selection & History Bridge Server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("UE_AGENT_BRIDGE_PORT", DEFAULT_PORT)))
    parser.add_argument("--state-file", default=os.environ.get("UE_AGENT_BRIDGE_STATE_FILE", str(DEFAULT_STATE_FILE)))
    parser.add_argument("--mock", action="store_true", help="Run standalone outside UE5 using a simulated UE scene")
    parser.add_argument("--demo-steps", action="store_true", help="Seed realistic single/multi-select history steps on startup (mock)")
    args = parser.parse_args()

    mock_world = MockUnrealWorld() if (args.mock or not HAS_UNREAL) else None
    bridge = start_bridge(host=args.host, port=args.port, state_file=args.state_file, mock_world=mock_world)
    if bridge.mode == "unreal":
        print(f"[UEAgentBridge unreal] Listening on http://{bridge.host}:{bridge.port}  state={bridge.state_file}")
        return 0

    if args.demo_steps:
        _seed_demo_history(bridge)
    try:
        _run_mock_interactive(bridge)
    finally:
        bridge.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
