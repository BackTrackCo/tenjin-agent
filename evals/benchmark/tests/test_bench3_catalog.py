"""Bench-3 catalog: what the delivery hook reads out of a work order."""
import json
from pathlib import Path

import pytest

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
