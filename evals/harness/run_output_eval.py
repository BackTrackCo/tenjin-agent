#!/usr/bin/env python3
"""Keyless output eval: is a skill's output right when it fires?

Reads an `evals.json` (skill-creator's schema) and runs every case twice through
headless `claude -p` under the caller's existing Claude Code login: once with the
skill installed in a throwaway project, once with no skill at all. A second
headless call grades each expectation against the transcript. No
ANTHROPIC_API_KEY, no plugin install.

The baseline discipline is the point, not the with-skill number: a with-skill
pass rate on its own means nothing, and the delta against the no-skill run is the
result (evals/README.md).

Money and blast radius:

  --allowedTools 'Bash(curl:*)' ...   curl is pre-cleared and nothing else is, so
                                      the agent under test can reach the public
                                      HTTP surface but cannot reach for a wallet
                                      CLI. Combined with a workspace that holds
                                      no key material, a case cannot spend.
  --setting-sources project           only the throwaway project's settings load,
                                      so a skill installed under ~/.claude/skills
                                      is not silently in the no-skill run.
  --strict-mcp-config                 no MCP servers.

Cases that reach the live site do write ordinary read telemetry rows. Every
project gets a one-line CLAUDE.md asking for an `x-tenjin-client: tenjin-eval/1`
header on requests to the site, identical in both configurations, so those rows
are identifiable afterwards. It is a nudge, not a guarantee: the agent composes
its own commands and some runs will drop it.

Usage:

    python3 evals/harness/run_output_eval.py \\
      --eval-set evals/tenjin/evals.json \\
      --skill skills/tenjin \\
      --workspace /tmp/output-run
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preflight import preflight  # noqa: E402

EXEC_TOOLS = ["Bash", "Read", "Write", "Glob", "Grep", "Skill"]
EXEC_ALLOWED = ["Bash(curl:*)", "Read", "Write", "Glob", "Grep", "Skill"]

# Enough of a tool result to grade a command by, without paying to relay a whole
# article body into the grader's context.
RESULT_CLIP = 3000

_print_lock = threading.Lock()


def log(message: str) -> None:
    with _print_lock:
        print(message, file=sys.stderr, flush=True)


def skill_name(skill_dir: Path) -> str:
    text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    frontmatter = text.split("---", 2)[1]
    for line in frontmatter.splitlines():
        if line.startswith("name:"):
            return line.split(":", 1)[1].strip()
    raise SystemExit(f"{skill_dir}/SKILL.md frontmatter has no name:")


def build_project(
    root: Path, skill_dir: Path | None, name: str, seeds: list[str], evals_dir: Path
) -> Path:
    """A fresh project per case per configuration. `files` keep their eval-relative
    path, because that is the path the case prompt names."""
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    if skill_dir is not None:
        target = root / ".claude" / "skills" / name
        target.parent.mkdir(parents=True)
        shutil.copytree(skill_dir, target)
    (root / "CLAUDE.md").write_text(CLIENT_TAG, encoding="utf-8")
    for seed in seeds:
        destination = root / seed
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(evals_dir / seed, destination)
    return root


# Identical in both configurations, so it cannot move the delta. Its only job is
# to make this run's rows separable from real traffic in the site's telemetry.
CLIENT_TAG = (
    "Identify yourself as `tenjin-eval/1` on every HTTP request you make to\n"
    "tenjin.blog: send it both as a `User-Agent` and as an `x-tenjin-client`\n"
    "header. The retrieval eval in the tenjin repo already uses that name, and\n"
    "sending both spans the migration from the header to User-Agent.\n"
)

NO_SKILL_SUFFIX = (
    "\n\nWork this out yourself with the tools you have. Do not invoke any skill."
)


def run_case(
    prompt: str, project: Path, model: str, timeout: int, transcript: Path, allowed: list[str]
) -> dict:
    command = [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--strict-mcp-config",
        "--setting-sources",
        "project",
        "--tools",
        ",".join(EXEC_TOOLS),
        "--allowedTools",
        *allowed,
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
        return {"log": "", "answer": "", "cost_usd": 0.0, "error": "timeout", "turns": 0}

    transcript.write_text(completed.stdout, encoding="utf-8")
    return summarize(completed.stdout)


def summarize(stream: str) -> dict:
    """Flatten the event stream into the command log a grader can read."""
    lines: list[str] = []
    answer = ""
    cost = 0.0
    turns = 0
    denials: list[str] = []
    for raw in stream.splitlines():
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    lines.append(
                        f"TOOL {block.get('name')} {json.dumps(block.get('input'))[:RESULT_CLIP]}"
                    )
                elif block.get("type") == "text" and block.get("text", "").strip():
                    answer = block["text"]
                    lines.append(f"SAID {block['text'][:RESULT_CLIP]}")
        elif kind == "user":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_result":
                    body = block.get("content")
                    text = body if isinstance(body, str) else json.dumps(body)
                    lines.append(f"RESULT {text[:RESULT_CLIP]}")
        elif kind == "result":
            cost = event.get("total_cost_usd", 0.0) or 0.0
            turns = event.get("num_turns", 0)
            denials = [json.dumps(d)[:400] for d in event.get("permission_denials", [])]
    if denials:
        lines.append("PERMISSION DENIALS: " + "; ".join(denials))
    return {
        "log": "\n".join(lines),
        "answer": answer,
        "cost_usd": cost,
        "turns": turns,
        "error": None,
    }


GRADER_PROMPT = """You are grading one run of a skill eval. Below is the case, its
expectations, and the full command log of an agent's single turn.

Grade each expectation independently as one of:
  pass     - the log shows the expectation was met
  fail     - the log shows it was not met
  ungraded - the condition the expectation is written around never occurred in
             this run, so it graded nothing. Never record that as a pass.

Judge only what the log shows. Do not credit an intention the agent stated but
did not carry out, and do not penalise an expectation for something it does not
mention.

CASE PROMPT:
{prompt}

EXPECTED OUTPUT:
{expected}

EXPECTATIONS (grade every one, in order):
{expectations}

COMMAND LOG:
{log}

Reply with JSON only, no prose and no code fence:
{{"grades": [{{"expectation": "<verbatim>", "grade": "pass|fail|ungraded", "evidence": "<one sentence citing the log>"}}]}}
"""


def grade(case: dict, run: dict, model: str, workdir: Path, timeout: int) -> dict:
    numbered = "\n".join(f"{i + 1}. {e}" for i, e in enumerate(case["expectations"]))
    prompt = GRADER_PROMPT.format(
        prompt=case["prompt"],
        expected=case["expected_output"],
        expectations=numbered,
        log=run["log"] or "(the agent produced no tool calls and no text)",
    )
    completed = subprocess.run(
        [
            "claude",
            "-p",
            prompt,
            "--output-format",
            "json",
            "--model",
            model,
            "--strict-mcp-config",
            "--setting-sources",
            "project",
            "--tools",
            "",
            "--no-session-persistence",
        ],
        cwd=workdir,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    try:
        text = json.loads(completed.stdout).get("result", "")
    except json.JSONDecodeError:
        return {"grades": [], "error": "grader produced no JSON envelope"}
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return {"grades": [], "error": "grader produced no JSON body"}
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"grades": [], "error": "grader JSON did not parse"}


def pass_rate(grades: list[dict]) -> tuple[int, int, int]:
    """Passes, fails, ungraded. Computed from the per-expectation array, never
    from a grader's own summary: a grader can emit a summary that contradicts its
    own grades, and one did."""
    passed = sum(1 for g in grades if g.get("grade") == "pass")
    failed = sum(1 for g in grades if g.get("grade") == "fail")
    ungraded = sum(1 for g in grades if g.get("grade") == "ungraded")
    return passed, failed, ungraded


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eval-set", required=True, type=Path)
    parser.add_argument("--skill", required=True, type=Path)
    parser.add_argument("--model", default="sonnet")
    parser.add_argument("--grader-model", default="opus")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--workspace", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument(
        "--only", type=int, nargs="*", default=None, help="case ids to run"
    )
    parser.add_argument(
        "--allow",
        nargs="*",
        default=[],
        help=(
            "extra permission rules to pre-clear, on top of the curl-only default. "
            "The CLI skills' cases need Bash(tenjin:*), and the env pins in "
            "evals/README.md with them."
        ),
    )
    parser.add_argument(
        "--no-preflight",
        action="store_true",
        help="skip the freshness checks (offline runs); say so when reporting the numbers",
    )
    args = parser.parse_args()

    workspace = args.workspace or Path(tempfile.mkdtemp(prefix="output-eval-"))
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "transcripts").mkdir(exist_ok=True)
    grader_dir = workspace / "grader"
    grader_dir.mkdir(exist_ok=True)

    evals_dir = args.eval_set.resolve().parent.parent
    spec = json.loads(args.eval_set.read_text(encoding="utf-8"))
    name = skill_name(args.skill)

    if not args.no_preflight:
        preflight(workspace=workspace, skills=[(args.skill, name)], model=args.model)
    cases = [c for c in spec["evals"] if args.only is None or c["id"] in args.only]

    log(f"skill {name} | {len(cases)} cases x 2 configurations | model {args.model}")
    log(f"workspace {workspace}")

    jobs = [(case, with_skill) for case in cases for with_skill in (True, False)]
    runs: dict[tuple[int, bool], dict] = {}

    def work(job: tuple[dict, bool]) -> None:
        case, with_skill = job
        tag = "with" if with_skill else "without"
        project = build_project(
            workspace / f"case{case['id']}-{tag}",
            args.skill if with_skill else None,
            name,
            case.get("files", []),
            evals_dir,
        )
        prompt = case["prompt"] if with_skill else case["prompt"] + NO_SKILL_SUFFIX
        outcome = run_case(
            prompt,
            project,
            args.model,
            args.timeout,
            workspace / "transcripts" / f"case{case['id']}-{tag}.jsonl",
            EXEC_ALLOWED + args.allow,
        )
        runs[(case["id"], with_skill)] = outcome
        log(f"  case {case['id']} {tag:7s} ran ({outcome['turns']} turns, ${outcome['cost_usd']:.2f})")

    # Both configurations of a case are spawned in the same wave, each in a fresh
    # context, so neither can inherit the other's reasoning.
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        list(pool.map(work, jobs))

    log("grading")
    graded: dict[tuple[int, bool], dict] = {}

    def do_grade(job: tuple[dict, bool]) -> None:
        case, with_skill = job
        graded[(case["id"], with_skill)] = grade(
            case, runs[(case["id"], with_skill)], args.grader_model, grader_dir, args.timeout
        )

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        list(pool.map(do_grade, jobs))

    report = {"skill": name, "model": args.model, "grader_model": args.grader_model, "cases": []}
    totals = {True: [0, 0, 0], False: [0, 0, 0]}
    cost = 0.0
    for case in cases:
        entry: dict = {"id": case["id"], "prompt": case["prompt"], "configurations": {}}
        for with_skill in (True, False):
            run = runs[(case["id"], with_skill)]
            grades = graded[(case["id"], with_skill)].get("grades", [])
            passed, failed, ungraded = pass_rate(grades)
            for slot, value in enumerate((passed, failed, ungraded)):
                totals[with_skill][slot] += value
            cost += run["cost_usd"]
            entry["configurations"]["with_skill" if with_skill else "without_skill"] = {
                "passed": passed,
                "failed": failed,
                "ungraded": ungraded,
                "turns": run["turns"],
                "cost_usd": round(run["cost_usd"], 4),
                "error": run["error"] or graded[(case["id"], with_skill)].get("error"),
                "grades": grades,
            }
        report["cases"].append(entry)

    def rate(slot: list[int]) -> float:
        decided = slot[0] + slot[1]
        return round(slot[0] / decided, 3) if decided else 0.0

    report["summary"] = {
        "with_skill": {"passed": totals[True][0], "failed": totals[True][1], "ungraded": totals[True][2], "pass_rate": rate(totals[True])},
        "without_skill": {"passed": totals[False][0], "failed": totals[False][1], "ungraded": totals[False][2], "pass_rate": rate(totals[False])},
        "delta": round(rate(totals[True]) - rate(totals[False]), 3),
        "executor_cost_usd": round(cost, 4),
    }

    out = args.out or (workspace / "benchmark.json")
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    summary = report["summary"]
    print(f"\n{name} output cases")
    print(f"  with skill    {summary['with_skill']['pass_rate']:.2f}  ({summary['with_skill']['passed']} pass, {summary['with_skill']['failed']} fail, {summary['with_skill']['ungraded']} ungraded)")
    print(f"  without skill {summary['without_skill']['pass_rate']:.2f}  ({summary['without_skill']['passed']} pass, {summary['without_skill']['failed']} fail, {summary['without_skill']['ungraded']} ungraded)")
    print(f"  delta         {summary['delta']:+.2f}")
    print(f"  benchmark     {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
