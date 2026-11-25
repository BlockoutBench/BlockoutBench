#!/usr/bin/env python3
"""Zero-dependency stdio MCP Server for the UE5 Selection & History Bridge.

Reads live UE5 state from the local HTTP bridge (`http://127.0.0.1:18136`) and falls
back automatically to the atomic JSON state file (`~/.ue_agent_bridge/selection_state.json`)
when the HTTP bridge is offline. Supports both newline-delimited JSON-RPC (MCP stdio)
and `Content-Length:` framed JSON-RPC.

Configure any MCP client (Claude Code, Cursor, Codex, Antigravity, etc.) with:
    command: python
    args: ["C:/path/to/tools/ue_agent_bridge/mcp_server.py"]
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any
import urllib.error
from urllib.parse import urlencode
import urllib.request

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from selection_tracker import DEFAULT_STATE_FILE, SelectionTracker, load_tracker_from_file, save_state_atomic  # noqa: E402


DEFAULT_BRIDGE_URL = "http://127.0.0.1:18136"
SUPPORTED_PROTOCOL_VERSION = "2024-11-05"


class BridgeDataSource:
    """Fetches selection & history over HTTP bridge with automatic disk-state fallback."""

    def __init__(self, bridge_url: str, state_file: str | Path, timeout_sec: float = 1.2) -> None:
        self.bridge_url = bridge_url.rstrip("/")
        self.state_file = Path(state_file).expanduser()
        self.timeout_sec = float(timeout_sec)

    def _http_json(self, path: str, params: dict[str, Any] | None = None, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any] | None:
        clean_params = {k: v for k, v in (params or {}).items() if v is not None}
        url = f"{self.bridge_url}{path}"
        if clean_params:
            url = f"{url}?{urlencode(clean_params)}"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if data is not None else {}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
            return None

    def _load_file_tracker(self) -> SelectionTracker | None:
        try:
            return load_tracker_from_file(self.state_file)
        except (json.JSONDecodeError, OSError):
            return None

    def get_status(self) -> dict[str, Any]:
        live = self._http_json("/health")
        if live is not None:
            return {**live, "transport": "live-http", "bridgeUrl": self.bridge_url}
        tracker = self._load_file_tracker()
        if tracker is not None:
            cur = tracker.get_current()
            return {
                "ok": True,
                "mode": "file-fallback",
                "transport": "state-file",
                "bridgeUrl": self.bridge_url,
                "stateFile": str(self.state_file.resolve()),
                "levelName": cur["levelName"],
                "levelPath": cur["levelPath"],
                "selectedCount": cur["summary"]["count"],
                "seq": cur["seq"],
                "updatedAt": cur["updatedAt"],
                "historySize": len(tracker._history),
            }
        return {
            "ok": False,
            "transport": "disconnected",
            "bridgeUrl": self.bridge_url,
            "stateFile": str(self.state_file.resolve()),
            "hint": "Start ue_editor_bridge.py inside UE5 Editor or run with --mock",
        }

    def get_selection(self, *, include_nearby: bool = False, nearby_radius_cm: float = 1500.0, refresh: bool = True) -> dict[str, Any]:
        params: dict[str, Any] = {"refresh": "1" if refresh else "0"}
        if include_nearby:
            params["nearbyRadiusCm"] = float(nearby_radius_cm)
        live = self._http_json("/selection", params=params)
        if live is not None:
            return {**live, "transport": "live-http"}
        tracker = self._load_file_tracker()
        if tracker is None:
            return {"error": "UE5 bridge unreachable and state file not found", "stateFile": str(self.state_file)}
        cur = tracker.get_current()
        if include_nearby:
            cur["nearby"] = []
            cur["nearbyNote"] = "Nearby spatial scan requires live HTTP bridge inside UE5"
        return {**cur, "transport": "state-file"}

    def get_history(
        self,
        *,
        limit: int = 10,
        offset: int = 0,
        non_empty_only: bool = False,
        class_filter: str | None = None,
        query: str | None = None,
        since_sec: float | None = None,
        bookmarked_only: bool = False,
        compact: bool = False,
    ) -> dict[str, Any]:
        live = self._http_json(
            "/history",
            params={
                "limit": limit,
                "offset": offset,
                "nonEmpty": "1" if non_empty_only else "0",
                "bookmarked": "1" if bookmarked_only else "0",
                "compact": "1" if compact else "0",
                "class": class_filter,
                "q": query,
                "sinceSec": since_sec,
            },
        )
        if live is not None:
            return {**live, "transport": "live-http"}
        tracker = self._load_file_tracker()
        if tracker is None:
            return {"error": "UE5 bridge unreachable and state file not found", "stateFile": str(self.state_file)}
        res = tracker.query_history(
            limit=limit,
            offset=offset,
            non_empty_only=non_empty_only,
            class_filter=class_filter,
            text_query=query,
            since_sec=since_sec,
            bookmarked_only=bookmarked_only,
            include_items=not compact,
        )
        return {**res, "transport": "state-file"}

    def get_recent_actors(self, *, limit: int = 20, class_filter: str | None = None, query: str | None = None) -> dict[str, Any]:
        live = self._http_json("/recent-actors", params={"limit": limit, "class": class_filter, "q": query})
        if live is not None:
            return {**live, "transport": "live-http"}
        tracker = self._load_file_tracker()
        if tracker is None:
            return {"error": "UE5 bridge unreachable and state file not found", "stateFile": str(self.state_file)}
        res = tracker.get_recent_actors(limit=limit, class_filter=class_filter, text_query=query)
        return {**res, "transport": "state-file"}

    def diff_selection(self, *, from_seq: int | None = None, to_seq: int | None = None) -> dict[str, Any]:
        live = self._http_json("/history/diff", params={"fromSeq": from_seq, "toSeq": to_seq})
        if live is not None:
            return {**live, "transport": "live-http"}
        tracker = self._load_file_tracker()
        if tracker is None:
            return {"error": "UE5 bridge unreachable and state file not found", "stateFile": str(self.state_file)}
        return {**tracker.diff_states(from_seq, to_seq), "transport": "state-file"}

    def bookmark_selection(self, *, label: str, note: str = "", seq: int | None = None) -> dict[str, Any]:
        live = self._http_json("/selection/bookmark", method="POST", body={"label": label, "note": note, "seq": seq})
        if live is not None:
            return {**live, "transport": "live-http"}
        tracker = self._load_file_tracker()
        if tracker is None:
            return {"error": "UE5 bridge unreachable and state file not found", "stateFile": str(self.state_file)}
        res = tracker.add_bookmark(label, note, seq=seq)
        if res is None:
            return {"error": "No matching history step to bookmark"}
        save_state_atomic(tracker, self.state_file)
        return {"ok": True, "bookmark": res, "transport": "state-file"}


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "ue_get_selection",
        "description": (
            "Read what actor(s) are currently selected in the UE5 Editor viewport. "
            "Supports both single selection and ordered multi-selection (items[0] is first-clicked anchor, "
            "items[-1] is last-clicked), world coordinates (cm & m), bounds, asset paths, tags, and optional nearby actors."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "includeNearby": {"type": "boolean", "default": False, "description": "Also scan surrounding unselected actors around the selection centroid."},
                "nearbyRadiusCm": {"type": "number", "default": 1500, "description": "Search radius in cm when includeNearby is true."},
                "refresh": {"type": "boolean", "default": True, "description": "Force a synchronous refresh from UE Game Thread before returning."},
            },
        },
    },
    {
        "name": "ue_get_selection_history",
        "description": (
            "Query historical UE5 viewport selections newest-first. Supports stepping back (`offset`), "
            "filtering empty clears (`nonEmptyOnly`), filtering by class (`classFilter`), text search (`query`), "
            "time window (`sinceSec`), and bookmarked steps."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 50},
                "offset": {"type": "integer", "default": 0, "minimum": 0, "description": "Use 1 to inspect the previous selection before current."},
                "nonEmptyOnly": {"type": "boolean", "default": True, "description": "Skip accidental empty clicks (`clear` transitions)."},
                "classFilter": {"type": "string", "description": "Case-insensitive substring match against className (e.g. 'PointLight', 'Door')."},
                "query": {"type": "string", "description": "Substring search against label, uid, assetPath, folder, or tags."},
                "sinceSec": {"type": "number", "description": "Only return selections within the past N seconds."},
                "bookmarkedOnly": {"type": "boolean", "default": False},
                "compact": {"type": "boolean", "default": False, "description": "Return slimmed items (uid, label, className, locationM)."},
            },
        },
    },
    {
        "name": "ue_get_recent_actors",
        "description": (
            "Return a deduplicated list of distinct UE5 actors touched recently, ordered by last selection time "
            "with touch counts and whether each actor is currently selected."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
                "classFilter": {"type": "string"},
                "query": {"type": "string"},
            },
        },
    },
    {
        "name": "ue_diff_selection",
        "description": (
            "Compare two selection history steps (`fromSeq` -> `toSeq`), showing added, removed, kept, and moved actors. "
            "Defaults to comparing the previous non-empty selection against the current selection."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "fromSeq": {"type": "integer", "description": "Older sequence number. Omit for previous non-empty step."},
                "toSeq": {"type": "integer", "description": "Newer sequence number. Omit for latest step."},
            },
        },
    },
    {
        "name": "ue_bookmark_selection",
        "description": "Attach a named bookmark/note to the current or specified selection history step for later recall.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "label": {"type": "string"},
                "note": {"type": "string", "default": ""},
                "seq": {"type": "integer"},
            },
            "required": ["label"],
        },
    },
    {
        "name": "ue_bridge_status",
        "description": "Check UE5 bridge connectivity, active level name, selected count, and whether data comes from live HTTP or disk fallback.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


class StdioMcpServer:
    """Pure-stdlib JSON-RPC 2.0 MCP server supporting both line and Content-Length stdio framing."""

    def __init__(self, source: BridgeDataSource) -> None:
        self.source = source
        self._last_framing = "line"

    def _call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "ue_get_selection":
            return self.source.get_selection(
                include_nearby=bool(args.get("includeNearby", False)),
                nearby_radius_cm=float(args.get("nearbyRadiusCm", 1500.0)),
                refresh=bool(args.get("refresh", True)),
            )
        if name == "ue_get_selection_history":
            return self.source.get_history(
                limit=int(args.get("limit", 10)),
                offset=int(args.get("offset", 0)),
                non_empty_only=bool(args.get("nonEmptyOnly", True)),
                class_filter=args.get("classFilter"),
                query=args.get("query"),
                since_sec=args.get("sinceSec"),
                bookmarked_only=bool(args.get("bookmarkedOnly", False)),
                compact=bool(args.get("compact", False)),
            )
        if name == "ue_get_recent_actors":
            return self.source.get_recent_actors(
                limit=int(args.get("limit", 20)),
                class_filter=args.get("classFilter"),
                query=args.get("query"),
            )
        if name == "ue_diff_selection":
            return self.source.diff_selection(
                from_seq=int(args["fromSeq"]) if args.get("fromSeq") is not None else None,
                to_seq=int(args["toSeq"]) if args.get("toSeq") is not None else None,
            )
        if name == "ue_bookmark_selection":
            return self.source.bookmark_selection(
                label=str(args.get("label") or "bookmark"),
                note=str(args.get("note") or ""),
                seq=int(args["seq"]) if args.get("seq") is not None else None,
            )
        if name == "ue_bridge_status":
            return self.source.get_status()
        raise KeyError(f"Unknown tool: {name}")

    def handle_request(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        method = msg.get("method")
        req_id = msg.get("id")
        params = msg.get("params") or {}

        # Notifications carry no id and must not emit a response.
        if req_id is None:
            return None

        if method == "initialize":
            client_proto = params.get("protocolVersion")
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": client_proto if isinstance(client_proto, str) and client_proto else SUPPORTED_PROTOCOL_VERSION,
                    "capabilities": {
                        "tools": {"listChanged": False},
                        "resources": {"subscribe": False, "listChanged": False},
                    },
                    "serverInfo": {"name": "ue-selection-bridge", "version": "1.0.0"},
                },
            }

        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOL_DEFINITIONS}}

        if method == "tools/call":
            tool_name = str(params.get("name") or "")
            tool_args = params.get("arguments") or {}
            try:
                payload = self._call_tool(tool_name, tool_args)
                is_err = isinstance(payload, dict) and "error" in payload and not payload.get("ok", True) is True and len(payload) <= 3
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}],
                        "isError": bool(payload.get("error")) if isinstance(payload, dict) else is_err,
                    },
                }
            except KeyError as exc:
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": str(exc)}}
            except Exception as exc:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps({"error": str(exc)}, ensure_ascii=False)}],
                        "isError": True,
                    },
                }

        if method == "resources/list":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "resources": [
                        {"uri": "ue://selection/current", "name": "UE5 Current Selection", "mimeType": "application/json"},
                        {"uri": "ue://selection/history", "name": "UE5 Selection History", "mimeType": "application/json"},
                        {"uri": "ue://selection/recent-actors", "name": "UE5 Recent Touched Actors", "mimeType": "application/json"},
                    ]
                },
            }

        if method == "resources/read":
            uri = str(params.get("uri") or "")
            if uri == "ue://selection/current":
                data = self.source.get_selection()
            elif uri == "ue://selection/history":
                data = self.source.get_history(limit=25, non_empty_only=False)
            elif uri == "ue://selection/recent-actors":
                data = self.source.get_recent_actors(limit=50)
            else:
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": f"Unknown resource URI: {uri}"}}
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"contents": [{"uri": uri, "mimeType": "application/json", "text": json.dumps(data, ensure_ascii=False, indent=2)}]},
            }

        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}

    def _read_message(self, stream: Any) -> tuple[dict[str, Any] | None, str]:
        while True:
            line = stream.readline()
            if not line:
                return None, self._last_framing
            stripped = line.strip()
            if not stripped:
                continue
            low = stripped.lower()
            if low.startswith(b"content-length:"):
                content_len = int(stripped.split(b":", 1)[1].strip())
                while True:
                    hdr = stream.readline()
                    if not hdr or hdr in (b"\r\n", b"\n"):
                        break
                body = stream.read(content_len)
                if not body:
                    return None, "lsp"
                self._last_framing = "lsp"
                return json.loads(body.decode("utf-8")), "lsp"
            self._last_framing = "line"
            return json.loads(stripped.decode("utf-8")), "line"

    @staticmethod
    def _write_message(stream: Any, payload: dict[str, Any], framing: str) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if framing == "lsp":
            header = f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii")
            stream.write(header + raw)
        else:
            stream.write(raw + b"\n")
        stream.flush()

    def serve_forever(self, in_stream: Any = None, out_stream: Any = None) -> int:
        in_buf = in_stream or sys.stdin.buffer
        out_buf = out_stream or sys.stdout.buffer
        while True:
            try:
                msg, framing = self._read_message(in_buf)
            except json.JSONDecodeError as exc:
                self._write_message(
                    out_buf,
                    {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {exc}"}},
                    self._last_framing,
                )
                continue
            if msg is None:
                return 0
            resp = self.handle_request(msg)
            if resp is not None:
                self._write_message(out_buf, resp, framing)


def main() -> int:
    parser = argparse.ArgumentParser(description="Zero-dependency MCP stdio server for UE5 Selection & History.")
    parser.add_argument("--bridge-url", default=os.environ.get("UE_AGENT_BRIDGE_URL", DEFAULT_BRIDGE_URL))
    parser.add_argument("--state-file", default=os.environ.get("UE_AGENT_BRIDGE_STATE_FILE", str(DEFAULT_STATE_FILE)))
    args = parser.parse_args()

    source = BridgeDataSource(bridge_url=args.bridge_url, state_file=args.state_file)
    return StdioMcpServer(source).serve_forever()


if __name__ == "__main__":
    raise SystemExit(main())
