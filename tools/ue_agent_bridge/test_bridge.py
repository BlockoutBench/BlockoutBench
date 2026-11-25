#!/usr/bin/env python3
"""Comprehensive offline verification tests for tools/ue_agent_bridge."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from mock_scene import DEFAULT_MOCK_ACTORS, MockUnrealWorld  # noqa: E402
from selection_tracker import SelectionTracker, load_tracker_from_file, save_state_atomic  # noqa: E402
from ue_editor_bridge import start_bridge, stop_bridge  # noqa: E402


def _http_get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=3) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_post(url: str, body: dict) -> dict:
    raw = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=raw, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _make_lsp_frame(obj: dict) -> bytes:
    raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii") + raw


def _read_lsp_frames(raw_bytes: bytes) -> list[dict]:
    frames = []
    idx = 0
    while idx < len(raw_bytes):
        hdr_end = raw_bytes.find(b"\r\n\r\n", idx)
        if hdr_end == -1:
            break
        hdr = raw_bytes[idx:hdr_end].decode("ascii")
        length = 0
        for line in hdr.splitlines():
            if line.lower().startswith("content-length:"):
                length = int(line.split(":", 1)[1].strip())
        body_start = hdr_end + 4
        body_end = body_start + length
        frames.append(json.loads(raw_bytes[body_start:body_end].decode("utf-8")))
        idx = body_end
    return frames


class SelectionTrackerTests(unittest.TestCase):
    def test_click_order_preservation_and_multi_summary(self) -> None:
        a = DEFAULT_MOCK_ACTORS[0]
        b = DEFAULT_MOCK_ACTORS[1]
        c = DEFAULT_MOCK_ACTORS[2]

        tracker = SelectionTracker(max_history=20)
        changed, entry1 = tracker.update([b], epoch_ms=1000)
        self.assertTrue(changed)
        self.assertEqual(entry1["changeType"], "select")

        # Simulate UE returning array in unsorted order [c, b, a] while keeping B first, then A, C.
        changed, entry2 = tracker.update([c, b, a], epoch_ms=2000)
        self.assertTrue(changed)
        self.assertEqual(entry2["changeType"], "add")
        cur = tracker.get_current()
        self.assertEqual([it["label"] for it in cur["items"]], ["SM_Pillar_East_02", "BP_VaultDoor_North", "SM_Pillar_West_01"])
        self.assertEqual(cur["summary"]["count"], 3)
        self.assertTrue(cur["summary"]["isMulti"])
        self.assertEqual(cur["summary"]["firstSelectedUid"], b["uid"])
        self.assertEqual(cur["summary"]["lastSelectedUid"], a["uid"])
        self.assertIsNotNone(cur["summary"]["unionBoundsCm"])
        self.assertEqual(cur["summary"]["classCounts"]["StaticMeshActor"], 2)
        self.assertEqual(cur["summary"]["classCounts"]["BP_InteractiveDoor_C"], 1)

        # Repeated identical poll must NOT create duplicate history entries.
        changed_again, _ = tracker.update([a, b, c], epoch_ms=2500)
        self.assertFalse(changed_again)
        self.assertEqual(tracker.seq, 2)

    def test_history_queries_diffs_recent_and_persistence(self) -> None:
        a, b, door, light = DEFAULT_MOCK_ACTORS[0], DEFAULT_MOCK_ACTORS[1], DEFAULT_MOCK_ACTORS[2], DEFAULT_MOCK_ACTORS[3]
        tracker = SelectionTracker(max_history=3)
        tracker.update([a], epoch_ms=1000)
        tracker.update([a, b], epoch_ms=2000)
        tracker.update([], epoch_ms=3000)  # clear
        tracker.update([door, light], epoch_ms=4000)

        # Ring buffer pruned to max_history=3: keeps seq 2, 3, 4.
        self.assertEqual(tracker.seq, 4)
        self.assertEqual([e["seq"] for e in tracker.query_history(limit=10)["entries"]], [4, 3, 2])

        # Skip empty clear step cleanly when querying previous non-empty step (offset=1).
        prev_non_empty = tracker.query_history(limit=1, offset=1, non_empty_only=True)
        self.assertEqual(prev_non_empty["entries"][0]["seq"], 2)
        self.assertEqual(prev_non_empty["entries"][0]["stepsAgo"], 2)

        # Filter by className and search text.
        lights = tracker.query_history(class_filter="PointLight", non_empty_only=True)
        self.assertEqual(lights["totalMatched"], 1)
        self.assertEqual(lights["entries"][0]["seq"], 4)

        pillars = tracker.query_history(text_query="Pillar", non_empty_only=True)
        self.assertEqual(pillars["totalMatched"], 1)

        # Diff previous non-empty (seq=2) vs current (seq=4).
        diff = tracker.diff_states()
        self.assertEqual(diff["fromSeq"], 2)
        self.assertEqual(diff["toSeq"], 4)
        self.assertEqual(diff["addedCount"], 2)
        self.assertEqual(diff["removedCount"], 2)

        # Recent deduplicated actor timeline & touch count.
        recent = tracker.get_recent_actors(limit=10)
        self.assertEqual(recent["totalDistinct"], 4)
        by_label = {r["actor"]["label"]: r for r in recent["actors"]}
        self.assertTrue(by_label["PointLight_Altar_Warm"]["currentlySelected"])
        self.assertFalse(by_label["SM_Pillar_West_01"]["currentlySelected"])

        # Bookmark & atomic state save/reload roundtrip.
        bm = tracker.add_bookmark("照明核对", "圣坛光源+北大门")
        self.assertIsNotNone(bm)
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "selection_state.json"
            save_state_atomic(tracker, state_path)
            reloaded = load_tracker_from_file(state_path)
            self.assertIsNotNone(reloaded)
            self.assertEqual(reloaded.get_current()["orderedUids"], tracker.get_current()["orderedUids"])
            self.assertEqual(reloaded.query_history(bookmarked_only=True)["totalMatched"], 1)

    def test_since_sec_filter_and_moved_actor_diff(self) -> None:
        a = dict(DEFAULT_MOCK_ACTORS[0])
        b = dict(DEFAULT_MOCK_ACTORS[1])
        tracker = SelectionTracker(max_history=10)
        now_ms = int(time.time() * 1000)
        tracker.update([a], epoch_ms=now_ms - 60_000)
        moved_a = {**a, "locationCm": [1450.0, 800.0, 0.0]}
        tracker.update([moved_a, b], epoch_ms=now_ms)

        recent_only = tracker.query_history(since_sec=10)
        self.assertEqual(recent_only["totalMatched"], 1)
        self.assertEqual(recent_only["entries"][0]["seq"], 2)

        diff = tracker.diff_states(1, 2)
        self.assertEqual(diff["keptCount"], 1)
        self.assertEqual(diff["movedCount"], 1)
        self.assertEqual(diff["moved"][0]["deltaCm"], [250.0, 0.0, 0.0])


class BridgeAndMcpIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.state_file = Path(self._tmpdir.name) / "selection_state.json"
        self.world = MockUnrealWorld()
        self.bridge = start_bridge(
            host="127.0.0.1",
            port=0,
            state_file=self.state_file,
            mock_world=self.world,
        )
        self.base_url = f"http://127.0.0.1:{self.bridge.port}"

    def tearDown(self) -> None:
        stop_bridge()
        self._tmpdir.cleanup()

    def test_http_bridge_and_live_mcp_plus_fallback(self) -> None:
        health = _http_get(f"{self.base_url}/health")
        self.assertTrue(health["ok"])
        self.assertEqual(health["mode"], "mock")

        # Multi-select step 1 -> step 2 -> move -> bookmark via HTTP.
        _http_post(f"{self.base_url}/mock/select", {"actors": ["SM_Pillar_West_01"]})
        _http_post(f"{self.base_url}/mock/add", {"actors": ["SM_Pillar_East_02", "BP_VaultDoor_North"]})
        _http_post(f"{self.base_url}/mock/move", {"actor": "BP_VaultDoor_North", "deltaCm": [120, 0, 0]})
        bm = _http_post(f"{self.base_url}/selection/bookmark", {"label": "双柱与北门"})
        self.assertTrue(bm["ok"])

        cur = _http_get(f"{self.base_url}/selection?nearbyRadiusCm=1000")
        self.assertEqual(cur["summary"]["count"], 3)
        self.assertGreaterEqual(len(cur["nearby"]), 1)

        # Check live MCP stdio subprocess with newline-delimited JSON-RPC.
        mcp_script = str(_HERE / "mcp_server.py")
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "ping"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "ue_get_selection", "arguments": {"includeNearby": True, "nearbyRadiusCm": 1000}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "ue_get_selection_history", "arguments": {"limit": 5, "nonEmptyOnly": True}}},
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "ue_get_recent_actors", "arguments": {"query": "Pillar"}}},
            {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "ue_diff_selection", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 8, "method": "resources/read", "params": {"uri": "ue://selection/current"}},
        ]
        stdin_text = "\n".join(json.dumps(r, ensure_ascii=False) for r in requests) + "\n"
        proc = subprocess.run(
            [sys.executable, mcp_script, "--bridge-url", self.base_url, "--state-file", str(self.state_file)],
            input=stdin_text.encode("utf-8"),
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr.decode("utf-8", errors="replace"))
        lines = [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
        by_id = {msg["id"]: msg for msg in lines}
        self.assertEqual(set(by_id.keys()), {1, 2, 3, 4, 5, 6, 7, 8})

        tool_names = {t["name"] for t in by_id[3]["result"]["tools"]}
        self.assertTrue({"ue_get_selection", "ue_get_selection_history", "ue_get_recent_actors", "ue_diff_selection", "ue_bookmark_selection", "ue_bridge_status"}.issubset(tool_names))

        sel_payload = json.loads(by_id[4]["result"]["content"][0]["text"])
        self.assertEqual(sel_payload["transport"], "live-http")
        self.assertEqual(sel_payload["summary"]["count"], 3)
        self.assertTrue(len(sel_payload["nearby"]) >= 1)

        hist_payload = json.loads(by_id[5]["result"]["content"][0]["text"])
        self.assertGreaterEqual(len(hist_payload["entries"]), 2)

        recent_payload = json.loads(by_id[6]["result"]["content"][0]["text"])
        self.assertEqual(recent_payload["totalDistinct"], 2)

        diff_payload = json.loads(by_id[7]["result"]["content"][0]["text"])
        self.assertEqual(diff_payload["addedCount"], 2)

        # Check client_cli.py against live HTTP bridge + invalid query resilience.
        bad_hist = _http_get(f"{self.base_url}/history?limit=abc")
        self.assertIn("entries", bad_hist)

        cli_script = str(_HERE / "client_cli.py")
        cli_proc = subprocess.run(
            [sys.executable, cli_script, "--bridge-url", self.base_url, "--state-file", str(self.state_file), "current", "--nearby", "1000"],
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(cli_proc.returncode, 0, msg=cli_proc.stderr.decode("utf-8", errors="replace"))
        cli_cur = json.loads(cli_proc.stdout.decode("utf-8"))
        self.assertEqual(cli_cur["summary"]["count"], 3)

        # Now stop HTTP server & test disk state-file fallback using Content-Length LSP framing!
        stop_bridge()
        lsp_in = b"".join([
            _make_lsp_frame({"jsonrpc": "2.0", "id": 10, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}),
            _make_lsp_frame({"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "ue_bridge_status", "arguments": {}}}),
            _make_lsp_frame({"jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": "ue_get_selection", "arguments": {}}}),
        ])
        proc_fb = subprocess.run(
            [sys.executable, mcp_script, "--bridge-url", self.base_url, "--state-file", str(self.state_file)],
            input=lsp_in,
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(proc_fb.returncode, 0, msg=proc_fb.stderr.decode("utf-8", errors="replace"))
        fb_msgs = {m["id"]: m for m in _read_lsp_frames(proc_fb.stdout)}
        status_fb = json.loads(fb_msgs[11]["result"]["content"][0]["text"])
        sel_fb = json.loads(fb_msgs[12]["result"]["content"][0]["text"])
        self.assertEqual(status_fb["transport"], "state-file")
        self.assertEqual(sel_fb["transport"], "state-file")
        self.assertEqual(sel_fb["summary"]["count"], 3)


if __name__ == "__main__":
    unittest.main()
