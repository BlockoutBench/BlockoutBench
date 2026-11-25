#!/usr/bin/env python3
"""LevelWorkbench Benchmark v2 runner (L1~L6 blind suite).

Default: compares `tools/benchmark/samples/baseline-raw` vs `tools/benchmark/samples/assisted-relative`
and writes `tools/out/benchmark-report.json` + `tools/out/benchmark-report.md`.

Examples:
    python tools/run_benchmark.py
    python tools/run_benchmark.py --dir path/to/my-model-outputs
    python tools/run_benchmark.py --export-prompts tools/benchmark/prompts
    python tools/run_benchmark.py --check
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
CASES_FILE = ROOT / "tools" / "benchmark" / "cases.json"
OUT_DIR = ROOT / "tools" / "out"


def evaluate_suite(sample_dir: Path, label: str, cases: list[dict]) -> dict:
    payload = {
        "root": str(ROOT),
        "sampleDir": str(sample_dir.resolve()),
        "cases": cases,
    }
    node_script = r"""
const fs = require('fs');
const path = require('path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const G = require(path.resolve(input.root, 'map-geometry.js'));
const V = require(path.resolve(input.root, 'map-validate.js'));
const results = [];
for (const c of input.cases) {
  const f = path.join(input.sampleDir, c.id + '.json');
  if (!fs.existsSync(f)) {
    results.push({
      caseId: c.id, missingFile: true, passed: false, score: 0, qualityScore: 0,
      qualityDeductions: [], failedChecks: ['missing-output-file'],
      snapFixCount: 0, totalSnapShiftM: 0, preSnapWarnings: []
    });
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  const baseData = c.baseMap ? JSON.parse(fs.readFileSync(path.resolve(input.root, c.baseMap), 'utf8').replace(/^\uFEFF/, '')) : null;
  results.push(G.gradeBenchmarkCase(raw, c, { validator: V, baseData }));
}
process.stdout.write(JSON.stringify(results));
"""
    proc = subprocess.run(
        ["node", "-e", node_script],
        cwd=ROOT,
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Benchmark grading failed ({label}): {proc.stderr.strip()}")
    results = json.loads(proc.stdout)
    pass_count = sum(1 for r in results if r.get("passed"))
    avg_score = round(sum(r.get("score", 0) for r in results) / max(1, len(results)), 1)
    avg_quality = round(sum(r.get("qualityScore", 0) for r in results) / max(1, len(results)), 1)
    total_fixes = sum(r.get("snapFixCount", 0) for r in results)
    total_shift = round(sum(r.get("totalSnapShiftM", 0) for r in results), 2)
    return {
        "label": label,
        "dir": str(sample_dir),
        "total": len(results),
        "passed": pass_count,
        "passRate": round(pass_count / max(1, len(results)) * 100, 1),
        "avgScore": avg_score,
        "avgQualityScore": avg_quality,
        "totalSnapFixes": total_fixes,
        "totalSnapShiftM": total_shift,
        "cases": results,
    }


def export_prompts(out_dir: Path, cases: list[dict], include_checks: bool = False) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    node_script = r"""
const fs = require('fs');
const path = require('path');
const args = JSON.parse(fs.readFileSync(0, 'utf8'));
const G = require(path.resolve(args.root, 'map-geometry.js'));
const V = require(path.resolve(args.root, 'map-validate.js'));
const baseData = JSON.parse(fs.readFileSync(path.resolve(args.root, args.baseMap), 'utf8').replace(/^\uFEFF/, ''));
const val = V.validate(baseData);
const ctx = G.buildAiEditContext(baseData, { notes: baseData.reviewNotes || [], validation: val, hops: 2 });
process.stdout.write(JSON.stringify(ctx, null, 2));
"""
    bundle_lines = [
        "# LevelWorkbench Benchmark 考题合集（盲测版 · L1～L6）",
        "",
        "> **使用顺序**：",
        "> 1. 先把仓库根目录单文件规范包 `AI_MAP_KIT.md` 交给受测智能体。",
        "> 2. 逐题或整卷发送以下考题，要求每题只输出严格合法的纯 JSON（L4/L6 输出 `{ \"patch\": ... }` 增量补丁）。",
        "> 3. 将输出存为 `<题号>.json` 放进目录 `<out>/` 后，执行 `python tools/run_benchmark.py --dir <out>` 自动评测。",
        "",
        "---",
        "",
    ]

    for c in cases:
        lines = [
            f"# {c['id']} · {c['title']} ({c['tier']})",
            "",
            "## 任务说明",
            c["prompt"],
            "",
            "## 输出格式要求",
            "- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。",
            "- 若为局部修补题（`patch`），只输出 `{ \"patch\": { \"upsertRooms\": ..., \"upsertDoors\": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。",
            "",
        ]
        if include_checks:
            lines.extend([
                "## 硬性验收条件（调试模式）",
                "```json",
                json.dumps(c["hardChecks"], ensure_ascii=False, indent=2),
                "```",
                "",
            ])
        if c.get("mode") == "patch" and c.get("baseMap"):
            proc = subprocess.run(
                ["node", "-e", node_script],
                cwd=ROOT,
                input=json.dumps({"root": str(ROOT), "baseMap": c["baseMap"]}),
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.strip())
            lines.extend([
                "## 输入局部上下文（邻域 + reviewNotes + 校验问题）",
                "```json",
                proc.stdout.strip(),
                "```",
                "",
            ])
        prompt_text = "\n".join(lines).rstrip() + "\n"
        (out_dir / f"{c['id']}.md").write_text(prompt_text, encoding="utf-8")
        bundle_lines.extend(lines)
        bundle_lines.extend(["---", ""])

    (out_dir / "ALL_BENCHMARK_PROMPTS.md").write_text("\n".join(bundle_lines).rstrip() + "\n", encoding="utf-8")
    # Remove old v1 bundle filename if present to avoid stale confusion.
    legacy_bundle = out_dir / "ALL_6_BENCHMARK_PROMPTS.md"
    if legacy_bundle.exists():
        legacy_bundle.unlink()
    print(f"Exported {len(cases)} blind benchmark prompts -> {out_dir}")


def render_markdown(suites: list[dict], cases: list[dict]) -> str:
    lines = [
        "# LevelWorkbench Benchmark v2 评测报告（L1～L6）",
        "",
        "| 对照组 | 通过数 | 通过率 | 综合均分 | 设计质量均分 | 自动吸附 | 吸附位移 (m) |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for s in suites:
        lines.append(
            f"| `{s['label']}` | {s['passed']}/{s['total']} | {s['passRate']}% | {s['avgScore']} "
            f"| {s.get('avgQualityScore', s['avgScore'])} | {s['totalSnapFixes']} | {s['totalSnapShiftM']} |"
        )
    lines.extend(["", "## 分题明细", ""])
    for c in cases:
        lines.append(f"### {c['id']} · {c['title']}（{c['tier']}）")
        lines.append("")
        lines.append("| 组别 | 结果 | 综合分 | 质量分 | 吸附 | 环路 | 盲端率 | 峰值位 | 死锁 | 未通过断言 | 质量扣分项 |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---:|---|---|---|")
        for s in suites:
            r = next((item for item in s["cases"] if item["caseId"] == c["id"]), None)
            if not r:
                continue
            m = r.get("metrics") or {}
            topo = m.get("topology") or {}
            prog = m.get("progression") or {}
            pace = m.get("pacing") or {}
            status = "PASS" if r["passed"] else "FAIL"
            deadlock = "是" if prog and not prog.get("noDeadlock", True) else "否"
            peak_pos = pace.get("peakPosition")
            peak_str = f"{peak_pos:.2f}" if isinstance(peak_pos, (int, float)) else "—"
            fails = ", ".join(r.get("failedChecks") or []) or "—"
            quals = ", ".join(f"{q['code']}(-{q['points']})" for q in (r.get("qualityDeductions") or [])) or "—"
            lines.append(
                f"| `{s['label']}` | {status} | {r['score']} | {r.get('qualityScore', r['score'])} "
                f"| {r.get('snapFixCount', 0)} ({r.get('totalSnapShiftM', 0)}m) | {topo.get('loopCount', '—')} "
                f"| {topo.get('deadEndRatio', '—')} | {peak_str} | {deadlock} | {fails} | {quals} |"
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Run LevelWorkbench L1~L6 Benchmark suite.")
    parser.add_argument("--dir", action="append", default=[], help="Custom directory of <caseId>.json outputs to evaluate")
    parser.add_argument("--export-prompts", help="Directory to export copy-ready blind LLM prompt files")
    parser.add_argument("--include-checks", action="store_true", help="Include hardChecks JSON in exported prompts (debug only)")
    parser.add_argument("--check", action="store_true", help="CI self-check: assert assisted-relative passes all with high quality and baseline-raw fails every case")
    args = parser.parse_args()

    spec = json.loads(CASES_FILE.read_text(encoding="utf-8"))
    cases = spec["cases"]

    if args.export_prompts:
        export_prompts(Path(args.export_prompts), cases, include_checks=args.include_checks)
        if not args.dir and not args.check:
            return 0

    targets: list[tuple[str, Path]] = []
    if args.dir:
        for d in args.dir:
            p = Path(d)
            targets.append((p.name, p if p.is_absolute() else (ROOT / p)))
    else:
        targets = [
            ("baseline-raw", ROOT / "tools" / "benchmark" / "samples" / "baseline-raw"),
            ("assisted-relative", ROOT / "tools" / "benchmark" / "samples" / "assisted-relative"),
        ]

    suites = [evaluate_suite(path, label, cases) for label, path in targets]

    if not args.check:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / "benchmark-report.json").write_text(json.dumps({"suites": suites}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        md = render_markdown(suites, cases)
        (OUT_DIR / "benchmark-report.md").write_text(md, encoding="utf-8")
        print(md)
    else:
        for s in suites:
            print(f"benchmark {s['label']}: {s['passed']}/{s['total']} passed (avg={s['avgScore']}, quality={s.get('avgQualityScore')}, snapFixes={s['totalSnapFixes']})")
        raw_suite = next((s for s in suites if s["label"] == "baseline-raw"), None)
        rel_suite = next((s for s in suites if s["label"] == "assisted-relative"), None)
        if not rel_suite or rel_suite["passed"] != rel_suite["total"] or rel_suite["avgScore"] < 96:
            print(f"ERROR: assisted-relative expected {rel_suite['total'] if rel_suite else '?'} passes & avgScore>=96, got {rel_suite}", file=sys.stderr)
            return 1
        if not raw_suite or raw_suite["passed"] != 0:
            print(f"ERROR: baseline-raw expected 0 passes (all traps caught), got {raw_suite['passed'] if raw_suite else '?'}", file=sys.stderr)
            return 1
        print("benchmark suite self-check ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
