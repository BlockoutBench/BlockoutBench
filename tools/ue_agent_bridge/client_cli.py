#!/usr/bin/env python3
"""Command-line inspector for querying UE5 selection, multi-select summary, and history.

Works against both live UE5 / `--mock` HTTP bridge and local state-file fallback.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from mcp_server import BridgeDataSource, DEFAULT_BRIDGE_URL  # noqa: E402
from selection_tracker import DEFAULT_STATE_FILE  # noqa: E402


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Inspect UE5 Editor selection & selection history.")
    parser.add_argument("--bridge-url", default=os.environ.get("UE_AGENT_BRIDGE_URL", DEFAULT_BRIDGE_URL))
    parser.add_argument("--state-file", default=os.environ.get("UE_AGENT_BRIDGE_STATE_FILE", str(DEFAULT_STATE_FILE)))
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Check live HTTP / disk fallback status")

    p_cur = sub.add_parser("current", help="Show current single/multi selection")
    p_cur.add_argument("--nearby", type=float, default=None, help="Also list nearby actors within radius cm")

    p_hist = sub.add_parser("history", help="Query selection history")
    p_hist.add_argument("--limit", type=int, default=10)
    p_hist.add_argument("--offset", type=int, default=0)
    p_hist.add_argument("--all", action="store_true", help="Include empty clear transitions")
    p_hist.add_argument("--class-filter", default=None)
    p_hist.add_argument("--query", "-q", default=None)
    p_hist.add_argument("--compact", action="store_true")

    p_rec = sub.add_parser("recent", help="Show deduplicated recently touched actors")
    p_rec.add_argument("--limit", type=int, default=20)
    p_rec.add_argument("--class-filter", default=None)
    p_rec.add_argument("--query", "-q", default=None)

    p_diff = sub.add_parser("diff", help="Diff two history sequence steps")
    p_diff.add_argument("--from-seq", type=int, default=None)
    p_diff.add_argument("--to-seq", type=int, default=None)

    p_bm = sub.add_parser("bookmark", help="Bookmark current or specified selection step")
    p_bm.add_argument("label")
    p_bm.add_argument("--note", default="")
    p_bm.add_argument("--seq", type=int, default=None)

    args = parser.parse_args()
    src = BridgeDataSource(args.bridge_url, args.state_file)

    if args.cmd == "status":
        out = src.get_status()
    elif args.cmd == "current":
        out = src.get_selection(include_nearby=args.nearby is not None, nearby_radius_cm=args.nearby or 1500.0)
    elif args.cmd == "history":
        out = src.get_history(
            limit=args.limit,
            offset=args.offset,
            non_empty_only=not args.all,
            class_filter=args.class_filter,
            query=args.query,
            compact=args.compact,
        )
    elif args.cmd == "recent":
        out = src.get_recent_actors(limit=args.limit, class_filter=args.class_filter, query=args.query)
    elif args.cmd == "diff":
        out = src.diff_selection(from_seq=args.from_seq, to_seq=args.to_seq)
    elif args.cmd == "bookmark":
        out = src.bookmark_selection(label=args.label, note=args.note, seq=args.seq)
    else:  # pragma: no cover
        return 1

    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
