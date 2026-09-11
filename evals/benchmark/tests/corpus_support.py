"""Helpers for the shipped Bench-1 corpus and its run configuration contracts."""
from __future__ import annotations

import json
import re

from evals.benchmark import signature, tenjin_arm, verifier


def actor_failure_key() -> str:
    """The `sig_v1_test` key the actor fixture's own failing case yields.

    Unfixed, `actorKey` interpolates a missing agent, so the hidden case
    that passes no agent is the one vitest names in its FAIL header. The
    file, the title template and the case index all come off the fixture,
    and the product's own console rule turns the header into the key, so a
    regenerated fixture moves the lesson and this expectation together.
    """
    test_file = tenjin_arm.FIXTURES / "live" / "actor" / "tests" / "actor.test.mjs"
    template = re.search(r"test\.each\(cases\)\('([^']+)'", test_file.read_text(encoding="utf-8"))
    hidden = json.loads((verifier.HIDDEN / "actor" / "cases.json").read_text(encoding="utf-8"))
    assert template is not None
    index = next(position for position, case in enumerate(hidden) if len(case["args"]) == 1)
    identity = signature.identity_from_console(f" FAIL  tests/{test_file.name} > {template.group(1).replace('%#', str(index))}")
    assert identity is not None
    return f"sig_v1_test:{signature.sig_v1_test(identity)}"
