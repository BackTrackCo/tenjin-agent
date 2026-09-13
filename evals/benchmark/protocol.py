"""Explicit task protocol requirements, checked against native execution evidence."""
from __future__ import annotations


def observed_descendants(session) -> int:
    if session is None:
        return 0
    actors = set(session.actors)
    roots = [actor for actor in actors if actor[1] == session.root_session_id and actor[2] == ""]
    if len(roots) != 1:
        return 0
    root = roots[0]
    parents = {}
    ambiguous = set()
    for edge in session.parent_edges:
        if edge.provenance != "native":
            continue
        if edge.child in parents and parents[edge.child] != edge.parent:
            ambiguous.add(edge.child)
        parents[edge.child] = edge.parent
    with_usage = {record.actor_key for record in session.records if record.input_total + record.output_total > 0}
    counted = 0
    for actor in (actors & with_usage) - {root}:
        current = actor
        seen = set()
        while current != root:
            if current in seen or current in ambiguous or current not in actors or current[:2] != root[:2]:
                break
            seen.add(current)
            current = parents.get(current)
            if current is None:
                break
        if current == root:
            counted += 1
    return counted


def completion_refusal(task, session, outcome, invalid_reason=None):
    """Never replace earlier invalid/capped/interrupted outcomes with coverage refusal."""
    if invalid_reason is not None or outcome != "pass":
        return invalid_reason
    if observed_descendants(session) < task.get("required_descendants", 0):
        return "protocol:missing_descendant"
    return None


HOST_CAPTURE_BRIEF = """Benchmark capture protocol: this task container has no publishing wallet. If Tenjin asks you to retain a reusable finding, return your own finding in the requested tenjin-finding fence; do not run tenjin publish. The benchmark host will publish captured drafts to its disposable shelf after your task is verified. Do not invent a finding when there is nothing reusable."""


def phase_prompt(request, prompt):
    if request.phase == "producer" and request.arm.get("capture_publication") == "host":
        return prompt + "\n\n" + HOST_CAPTURE_BRIEF
    return prompt
