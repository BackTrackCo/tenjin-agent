#!/usr/bin/env python3
"""Freshness preflight: is this run measuring the skills we actually ship?

An eval run is expensive and its number outlives the run, so the failure worth
guarding is not a crash: it is a clean-looking pass rate measured against a stale
copy of a skill. Three ways that happens, one check each, and every one of them
stops the run rather than warning into a log nobody reads.

  1. The vendored `skills/tenjin/SKILL.md` drifts from the live
     https://tenjin.blog/skills.md it is a copy of. `sync:skill` splices a banner
     in after the frontmatter and changes nothing else, so stripping that one
     comment makes the two byte-comparable. This is the same drift `skill-drift.yml`
     watches; the difference is that CI tells you tomorrow and this tells you
     before you spend.
  2. The worktree is behind `origin/main` on any `skills/**` path, which is how a
     long-lived branch ends up grading a description someone already replaced.
     Uncommitted edits under `skills/` are deliberately fine: tuning a description
     and re-running is the whole workflow.
  3. The run would see a skill copy from outside the repo. `--setting-sources
     project` is what prevents it, and the proof is in the init event: a stale
     `~/.claude/skills/tenjin-search` alongside the workspace copy makes the event
     list `tenjin-search` twice, and the run then measures whichever the model saw.
     Checked by one throwaway turn in a probe project, for about a cent.

Not a framework. It answers one question, and `--no-preflight` skips it for an
offline run, at the cost of having to say so when reporting the numbers.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

# evals/harness/preflight.py -> the repo root, resolved from this file rather
# than from cwd, so the checks hold wherever the runner was invoked from.
REPO = Path(__file__).resolve().parents[2]

VENDORED_SKILL = REPO / "skills" / "tenjin" / "SKILL.md"
SOURCE_URL = "https://tenjin.blog/skills.md"

# The frontmatter, then the banner `scripts/sync-skill.mjs` splices in directly
# after it. Matched as "any HTML comment in that position" rather than as the
# banner's literal wording, so rewording the banner does not turn into a false
# drift report here.
BANNER = re.compile(r"\A(---\n[\s\S]*?\n---\n)<!--[\s\S]*?-->\n")


def _git(*args: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(REPO), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _check_vendored() -> list[str]:
    """The vendored zero-install skill against the URL it is a copy of."""
    if not VENDORED_SKILL.exists():
        return []
    try:
        with urllib.request.urlopen(SOURCE_URL, timeout=30) as response:
            if response.status != 200:
                return [f"{SOURCE_URL} returned HTTP {response.status}, so drift is unverified"]
            live = response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return [f"could not fetch {SOURCE_URL} ({error}), so drift is unverified"]

    vendored = VENDORED_SKILL.read_text(encoding="utf-8")
    if BANNER.sub(r"\1", vendored, count=1) == live:
        return []
    return [
        "skills/tenjin/SKILL.md has drifted from the live "
        f"{SOURCE_URL}; run `pnpm sync:skill` and re-read the diff before measuring"
    ]


def _check_behind() -> list[str]:
    """Commits on origin/main touching skills/** that this worktree does not have."""
    if _git("rev-parse", "--git-dir").returncode != 0:
        return [f"{REPO} is not a git worktree, so skill freshness is unverified"]

    notes = []
    fetched = _git("fetch", "--quiet", "origin", "main")
    if fetched.returncode != 0:
        notes.append(
            "could not fetch origin/main "
            f"({fetched.stderr.strip() or 'unknown error'}); comparing against the local ref, "
            "which may itself be stale"
        )

    listed = _git("rev-list", "--oneline", "HEAD..origin/main", "--", "skills")
    if listed.returncode != 0:
        return [*notes, f"could not compare against origin/main: {listed.stderr.strip()}"]

    missing = [line for line in listed.stdout.splitlines() if line.strip()]
    if missing:
        joined = "\n       ".join(missing)
        notes.append(
            f"{len(missing)} commit(s) on origin/main touch skills/ and are not in this "
            f"worktree:\n       {joined}\n     rebase or merge before measuring"
        )
    return notes


USER_SKILLS = Path.home() / ".claude" / "skills"


def _judge(loaded: list[str], expected: list[str], installed_for_the_user: list[str]) -> list[str]:
    """Which skills a run would see, judged against which it should see.

    Built-in skills ship with the CLI and are always in this list, so an
    unfamiliar name proves nothing on its own. Two things do:

      - a repeated name, which is the same skill arriving from two sources;
      - a name that exists under ~/.claude/skills and is not one of ours, which
        can only be there because user settings loaded.

    The two overlap by design. A stale user-level copy of a skill under test
    shows up as the first (the name is expected, so the second passes it) and a
    user-level skill we do not ship shows up as the second."""
    duplicates = sorted({name for name in loaded if loaded.count(name) > 1})
    if duplicates:
        return [
            f"the init event lists {', '.join(duplicates)} more than once, so a copy outside "
            "this repo (usually ~/.claude/skills) would load alongside the one under test and "
            "the run would measure whichever the model saw"
        ]

    leaked = sorted(
        name for name in installed_for_the_user if name in loaded and name not in expected
    )
    if leaked:
        return [
            f"the init event lists {', '.join(leaked)}, which is installed under "
            "~/.claude/skills and is not part of this run, so user settings are loading and a "
            "skill copy from outside the repo is in the measurement"
        ]

    missing = [name for name in expected if name not in loaded]
    if missing:
        return [
            f"the probe project holds {', '.join(expected)} but the init event never listed "
            f"{', '.join(missing)}, so the run would measure a skill the agent was never offered"
        ]
    return []


def _check_isolation(workspace: Path, names: list[str], model: str, timeout: int) -> list[str]:
    """One throwaway turn, read for which skills the run would actually see."""
    project = workspace / "preflight"
    (project / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [
            "claude",
            "-p",
            "reply with the single word ok",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            model,
            "--strict-mcp-config",
            "--setting-sources",
            "project",
            "--tools",
            "",
            "--no-session-persistence",
        ],
        cwd=project,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
    )

    loaded: list[str] | None = None
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "system" and event.get("subtype") == "init":
            loaded = event.get("skills", [])
            break

    if loaded is None:
        return [
            "the isolation probe produced no init event, so which skills a run loads is "
            f"unverified: {completed.stderr.strip()[:200] or 'no stderr'}"
        ]

    user_installed = (
        [entry.name for entry in USER_SKILLS.iterdir() if entry.is_dir()]
        if USER_SKILLS.is_dir()
        else []
    )
    return _judge(loaded, names, user_installed)


def preflight(
    *,
    workspace: Path,
    skills: list[tuple[Path, str]],
    model: str,
    timeout: int = 300,
) -> None:
    """Run every check, then stop the run if any of them failed.

    `skills` is the (directory, frontmatter name) of each skill the run installs,
    the skill under test first. Copies them into a probe project so the isolation
    check asks about the real install set rather than a stand-in."""
    probe = workspace / "preflight" / ".claude" / "skills"
    probe.mkdir(parents=True, exist_ok=True)
    for directory, name in skills:
        target = probe / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(directory, target)

    names = [name for _, name in skills]
    failures = [
        # Mirror drift only invalidates a run that measures the mirror itself;
        # runs over other skills should not be blocked by it (skill-drift.yml
        # still guards the mirror in CI).
        *(_check_vendored() if "tenjin" in names else []),
        *_check_behind(),
        *_check_isolation(workspace, names, model, timeout),
    ]

    if not failures:
        print("preflight ok: skills current, worktree not behind, one copy of each", file=sys.stderr)
        return

    print("\nPREFLIGHT FAILED, nothing ran.", file=sys.stderr)
    print("A pass rate measured against a stale skill is worse than no pass rate.\n", file=sys.stderr)
    for index, failure in enumerate(failures, start=1):
        print(f"  {index}. {failure}", file=sys.stderr)
    print(
        "\nFix these, or pass --no-preflight to measure anyway and say so when you "
        "report the numbers.\n",
        file=sys.stderr,
    )
    raise SystemExit(2)
