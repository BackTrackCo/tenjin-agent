"""Bench-3 catalog: what the delivery hook reads, and where a pair's base commit comes from."""
import json
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
CATALOG = Path(__file__).resolve().parents[1] / "bench3" / "catalog.json"
TASKS = json.loads(CATALOG.read_text())["tasks"]
IDS = [task["id"] for task in TASKS]
# The prompt hook queries the first 512 characters of the work order, so those
# bytes are the reuse question the shelf answers.
QUERY_HEAD = 512
ENVIRONMENT = "Work within the supplied product source"
PREAMBLE = (
    ENVIRONMENT,
    "The following final historical compatibility requirements",
    "Required benchmark compatibility interfaces",
)


@pytest.mark.parametrize("task", TASKS, ids=IDS)
def test_every_work_order_fills_its_queried_head_with_the_ticket(task) -> None:
    """A preamble inside the queried head asks the shelf about the environment, not the task."""
    prompt = task["prompt"]
    head = min(len(prompt), QUERY_HEAD)
    assert prompt[:head] == prompt[:head].lstrip()
    for marker in PREAMBLE:
        position = prompt.find(marker)
        assert position < 0 or position >= head, f"{task['id']} queries {marker!r}, not its ticket"


@pytest.mark.parametrize("task", TASKS, ids=IDS)
def test_the_shared_environment_note_stays_the_last_paragraph(task) -> None:
    """Environment notes and constraints follow the ticket; moving one back ahead of it fails here."""
    prompt = task["prompt"]
    assert prompt.count(ENVIRONMENT) <= 1
    if ENVIRONMENT in prompt:
        paragraphs = [block for block in prompt.split("\n\n") if block.strip()]
        assert paragraphs[-1].startswith(ENVIRONMENT)


HEX40 = re.compile(r"[0-9a-f]{40}")
# Each rule states what the recorded base is, so the flag is not a free field.
RULES = {"merge-commit-first-parent": True, "pr-branch-base-ref": False}


def git(*arguments: str) -> tuple[int, str]:
    done = subprocess.run(("git", *arguments), cwd=REPO, capture_output=True, text=True)
    return done.returncode, done.stdout.strip()


@pytest.mark.parametrize("task", TASKS, ids=IDS)
def test_every_pair_records_how_its_base_commit_was_derived(task) -> None:
    """A base the producer never merged from is a different treatment, so the rule stays on the record."""
    derivation = task["base_derivation"]
    assert HEX40.fullmatch(derivation["merge_commit"])
    assert RULES[derivation["rule"]] is derivation["matches_merge_first_parent"]


@pytest.mark.parametrize("task", TASKS, ids=IDS)
def test_a_proven_pair_stands_on_the_merge_commit_first_parent(task) -> None:
    """A branch base ref omits whatever landed between the cut and the squash merge."""
    if "oracle-proven" in task["eligibility"]:
        assert task["base_derivation"]["matches_merge_first_parent"]


@pytest.mark.parametrize("task", TASKS, ids=IDS)
def test_the_recorded_base_is_recomputed_from_the_merge_commit(task) -> None:
    """CI checks out one commit; a checkout without the objects says so rather than passing quietly."""
    merge = task["base_derivation"]["merge_commit"]
    if git("cat-file", "-e", f"{merge}^{{commit}}")[0] != 0:
        pytest.skip(f"{merge} is outside this checkout's history")
    code, listed = git("rev-list", "--parents", "-n", "1", merge)
    assert code == 0 and len(listed.split()) == 2, "a squash merge has one parent"
    matches = task["base_derivation"]["matches_merge_first_parent"]
    assert (git("rev-parse", f"{merge}^1")[1] == task["before_commit"]) is matches
    if matches:
        assert git("rev-parse", f"{merge}:")[1] == task["trees"]["after"]
