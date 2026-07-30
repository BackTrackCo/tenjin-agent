#!/usr/bin/env python3
"""Keyless trigger eval: does a skill fire on the queries it should?

Reads a `trigger-eval.json` (the same file skill-creator's `scripts/run_loop.py`
reads) and runs every query through headless `claude -p` under the caller's
existing Claude Code login. No ANTHROPIC_API_KEY, no plugin install.

What it measures is one bit per run: did the agent invoke the skill under test.
That bit is read off the `stream-json` event stream, where a skill invocation is
an ordinary `tool_use` block with `name: "Skill"` and `input.skill` naming it.

Three flags do the isolating, and dropping any of them changes the number:

  --setting-sources project   loads only the throwaway project's settings, so
                              skills installed under ~/.claude/skills are not in
                              the run at all. Without it a stale copy of the same
                              skill loads alongside the one under test and the
                              measurement is of whichever the model saw.
  --strict-mcp-config         no MCP servers, which otherwise arrive from the
                              caller's own config and cost tokens per turn.
  --tools Skill,Read,Glob,Grep
                              a fixed built-in set. Bash is absent on purpose:
                              the agent under test can express the trigger but
                              cannot run the CLI or reach the network, so a
                              trigger pass spends no money and writes no
                              telemetry. Without the cap the agent goes hunting
                              for a shell when the skill asks for one, which is
                              several turns of nothing.

Usage:

    python3 evals/harness/run_trigger_eval.py \\
      --eval-set evals/tenjin-search/trigger-eval.json \\
      --skill skills/tenjin-search \\
      --workspace /tmp/trigger-run

Scoring follows skill-creator's defaults: 3 runs per query, and a query passes
when its fire rate lands on the right side of --threshold (0.5) for its
`should_trigger`. Read the negative pass rate first; see evals/README.md.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TOOLS = "Skill,Read,Glob,Grep"

_print_lock = threading.Lock()


def log(message: str) -> None:
    with _print_lock:
        print(message, file=sys.stderr, flush=True)


def skill_name(skill_dir: Path) -> str:
    """The `name:` from SKILL.md frontmatter, which is what `Skill` is called with."""
    text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise SystemExit(f"{skill_dir}/SKILL.md has no frontmatter")
    frontmatter = text.split("---", 2)[1]
    for line in frontmatter.splitlines():
        if line.startswith("name:"):
            return line.split(":", 1)[1].strip()
    raise SystemExit(f"{skill_dir}/SKILL.md frontmatter has no name:")


def build_project(workspace: Path, skill_dir: Path, name: str, also: list[Path]) -> Path:
    """A throwaway project holding the skill under test, plus any skill named by
    --also-skill.

    The default of nothing else is the honest measurement of a description in
    isolation. It is the wrong measurement for a description that defers ("if X
    is installed, prefer its skill over this one"), because with no X installed
    deferring means doing nothing, and the model fires rather than stall. Install
    the skill it defers to and the same query is a real choice."""
    project = workspace / "project"
    for source in [skill_dir, *also]:
        target = project / ".claude" / "skills" / skill_name(source)
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target)
    return project


def run_once(
    query: str,
    project: Path,
    name: str,
    model: str,
    timeout: int,
    transcript: Path,
) -> dict:
    """One headless turn. Returns the fired bit plus enough to audit it."""
    command = [
        "claude",
        "-p",
        query,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--strict-mcp-config",
        "--setting-sources",
        "project",
        "--tools",
        TOOLS,
        "--no-session-persistence",
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=project,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"fired": None, "error": "timeout", "tools": [], "cost_usd": 0.0}

    transcript.write_text(completed.stdout, encoding="utf-8")

    fired = False
    other_skills: list[str] = []
    tools: list[str] = []
    cost = 0.0
    result_subtype = None
    skills_loaded: list[str] = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "system" and event.get("subtype") == "init":
            skills_loaded = event.get("skills", [])
        elif event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") != "tool_use":
                    continue
                tool = block.get("name", "")
                invoked = block.get("input", {}).get("skill")
                tools.append(f"{tool}({invoked})" if invoked else tool)
                if tool == "Skill" and invoked == name:
                    fired = True
                if tool == "Skill" and invoked and invoked != name:
                    other_skills.append(invoked)
        elif event.get("type") == "result":
            cost = event.get("total_cost_usd", 0.0) or 0.0
            result_subtype = event.get("subtype")

    # A run whose init never listed the skill measured nothing: the agent was
    # never offered the thing we are asking whether it reaches for.
    loaded = name in skills_loaded
    return {
        "fired": fired,
        "other_skills_fired": other_skills,
        "skill_offered": loaded,
        "tools": tools,
        "cost_usd": cost,
        "result": result_subtype,
        "error": None if completed.returncode == 0 else f"exit {completed.returncode}",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eval-set", required=True, type=Path)
    parser.add_argument("--skill", required=True, type=Path)
    parser.add_argument(
        "--also-skill",
        nargs="*",
        default=[],
        type=Path,
        help="other skills to install alongside, for a description that defers to one",
    )
    parser.add_argument("--runs-per-query", type=int, default=3)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--model", default="sonnet")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--workspace", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    workspace = args.workspace or Path(tempfile.mkdtemp(prefix="trigger-eval-"))
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "transcripts").mkdir(exist_ok=True)

    name = skill_name(args.skill)
    project = build_project(workspace, args.skill, name, args.also_skill)
    cases = json.loads(args.eval_set.read_text(encoding="utf-8"))

    log(f"skill {name} | {len(cases)} queries x {args.runs_per_query} runs | model {args.model}")
    log(f"workspace {workspace}")

    jobs = [
        (index, case, run)
        for index, case in enumerate(cases)
        for run in range(args.runs_per_query)
    ]
    results: dict[tuple[int, int], dict] = {}

    def work(job: tuple[int, dict, int]) -> None:
        index, case, run = job
        transcript = workspace / "transcripts" / f"q{index:02d}-r{run}.jsonl"
        outcome = run_once(
            case["query"], project, name, args.model, args.timeout, transcript
        )
        results[(index, run)] = outcome
        mark = "FIRE" if outcome["fired"] else "----"
        log(f"  q{index:02d} r{run} {mark} {case['query'][:60]}")

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        list(pool.map(work, jobs))

    per_query = []
    total_cost = 0.0
    for index, case in enumerate(cases):
        runs = [results[(index, run)] for run in range(args.runs_per_query)]
        total_cost += sum(r["cost_usd"] for r in runs)
        fires = sum(1 for r in runs if r["fired"])
        rate = fires / len(runs)
        expected = bool(case["should_trigger"])
        passed = (rate >= args.threshold) == expected
        per_query.append(
            {
                "query": case["query"],
                "should_trigger": expected,
                "fires": fires,
                "runs": len(runs),
                "fire_rate": rate,
                "passed": passed,
                "offered_every_run": all(r.get("skill_offered") for r in runs),
                "other_skills_fired": sorted(
                    {s for r in runs for s in r.get("other_skills_fired", [])}
                ),
                "errors": [r["error"] for r in runs if r["error"]],
            }
        )

    positives = [q for q in per_query if q["should_trigger"]]
    negatives = [q for q in per_query if not q["should_trigger"]]
    summary = {
        "skill": name,
        "model": args.model,
        "runs_per_query": args.runs_per_query,
        "threshold": args.threshold,
        "negative_pass_rate": _rate(negatives),
        "positive_pass_rate": _rate(positives),
        "overall_pass_rate": _rate(per_query),
        "total_cost_usd": round(total_cost, 4),
        "queries": per_query,
    }

    out = args.out or (workspace / "results.json")
    out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    # Negatives first: the positives lean on the description's own vocabulary,
    # so a description tuned to fire broadly still scores well on them.
    print(f"\n{name}  ({args.runs_per_query} runs/query, threshold {args.threshold})")
    print(f"  negatives {_fmt(negatives)}   <- read this first")
    print(f"  positives {_fmt(positives)}")
    print(f"  overall   {_fmt(per_query)}")
    print(f"  cost      ${summary['total_cost_usd']}")
    print(f"  results   {out}")
    for query in per_query:
        if query["passed"]:
            continue
        want = "should fire" if query["should_trigger"] else "should not fire"
        print(f"  MISS [{want}] {query['fires']}/{query['runs']}  {query['query']}")
    return 0


def _rate(queries: list[dict]) -> float:
    if not queries:
        return 0.0
    return round(sum(1 for q in queries if q["passed"]) / len(queries), 3)


def _fmt(queries: list[dict]) -> str:
    passed = sum(1 for q in queries if q["passed"])
    return f"{passed}/{len(queries)} = {_rate(queries):.2f}"


if __name__ == "__main__":
    raise SystemExit(main())
