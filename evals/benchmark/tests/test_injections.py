"""Winning-hook attribution and independently reviewed relevance, never guessed."""
import copy
import json

import pytest

from evals.benchmark import injections, report


@pytest.mark.parametrize("context,expected", [
    ("[Tenjin] A finding\nRead it free: tenjin read piece", "pointer"),
    ("[Tenjin] A finding\nInspect it free: tenjin inspect piece", "pointer"),
    ("[Tenjin] A finding\n--- tenjin-body abc ---\nThe answer\n--- tenjin-body abc ---", "full_body"),
    ("[Tenjin] A finding\n--- tenjin-body abc ---\nThe start\n[truncated; the full piece: tenjin read piece]\n--- tenjin-body abc ---", "truncated_body"),
    ("[Tenjin] A finding\n--- tenjin-body abc ---\nUnclosed body", "unknown"),
    ("[Tenjin] A finding\n--- tenjin-body abc ---\nBody\n--- tenjin-body xyz ---", "unknown"),
    ("[Tenjin] A finding\nInspect it free: tenjin inspect other-piece", "unknown"),
    ("ordinary model prose", "unknown"),
])
def test_delivery_form_comes_from_exact_emit_boundaries(context, expected):
    result = injections.presentation(json.dumps({"context": context}), "inject:piece")
    assert result["delivery_form"] == expected
    assert "context" not in result and context not in str(result)


@pytest.mark.parametrize("emit", [None, "broken JSON", "null", "[]", '{"context":42}'])
def test_missing_emit_never_implies_pointer_or_body(emit):
    assert injections.presentation(emit, "inject:piece") == {"delivery_form": "unknown", "emitted_context_chars": None}


def test_pointers_and_bodies_have_separate_relevance_denominators():
    accepted = evidence()
    fires = accepted["trial-a"]["delivery"]["fires"]
    fires[0]["delivery_form"] = "pointer"
    fires[1]["delivery_form"] = "full_body"
    data = injections.project(accepted, "manifest", "schedule", review_for(accepted))
    assert {(x["delivery_form"], x["irrelevant"], x["unreviewed"]) for x in data["by_hook_shelf"]} == {("pointer", 1, 0), ("full_body", 0, 1)}
    assert "Delivery form" in "\n".join(injections.render(data, markdown=True))


def evidence():
    return {"trial-a": {"arm_id": "natural", "task_id": "actor", "outcome": "pass", "delivery": {
        "status": "joined",
        "fires": [
            {"fire_id": "prompt-fire", "hook_arm": "prompt", "event": "prompt", "delivered": "inject:wrong-piece"},
            {"fire_id": "failure-fire", "hook_arm": "failure", "event": "tool.after", "delivered": "inject:right-piece"},
            {"fire_id": "context-fire", "hook_arm": "context", "event": "tool.before", "delivered": None},
        ],
        "legs": [
            {"fire_id": "prompt-fire", "shelf": "team", "status": "ok", "outcome": "miss"},
            {"fire_id": "prompt-fire", "shelf": "public", "status": "ok", "outcome": "hit"},
            {"fire_id": "failure-fire", "shelf": "keys", "status": "ok", "outcome": "hit"},
            {"fire_id": "failure-fire", "shelf": "public", "status": "ok", "outcome": "shadowed"},
        ],
        "unmatched_fires": [{"fire_id": "sibling", "delivered": "inject:foreign"}],
        "phase_fires": {"producer": 4},
    }}}


def review_for(accepted):
    fire = accepted["trial-a"]["delivery"]["fires"][0]
    return {"schema": injections.REVIEW_SCHEMA, "manifest_hash": "manifest", "schedule_hash": "schedule",
            "judgments": [{"delivery_id": injections.identity("trial-a", fire), "relevance": "irrelevant", "evidence_sha256": "a" * 64}]}


def test_only_consumer_injections_count_and_only_winning_shelf_is_attributed():
    data = injections.project(evidence(), "manifest", "schedule")
    assert len(data["deliveries"]) == 2
    assert {(x["hook_arm"], x["shelf"]) for x in data["deliveries"]} == {("prompt", "public"), ("failure", "team")}
    assert all(x["relevance"] == "unreviewed" for x in data["deliveries"])
    assert sum(x["fires"] for x in data["hooks"]) == 3
    assert data["observed_attempts"] == 1 and data["unavailable_attempts"] == 0
    assert "wrong-piece" not in str(data) and "prompt-fire" not in str(data)
    report.guard(data)


@pytest.mark.parametrize("legs", [[], [
    {"fire_id": "prompt-fire", "shelf": "public", "status": "ok", "outcome": "hit"},
    {"fire_id": "prompt-fire", "shelf": "team", "status": "ok", "outcome": "hit"},
]])
def test_missing_or_ambiguous_winner_does_not_guess_origin(legs):
    accepted = evidence()
    accepted["trial-a"]["delivery"]["legs"] = legs
    data = injections.project(accepted, "manifest", "schedule")
    assert next(x for x in data["deliveries"] if x["hook_arm"] == "prompt")["shelf"] == "unknown"


def test_explicit_review_does_not_turn_unreviewed_or_task_success_into_correct():
    accepted = evidence()
    review = review_for(accepted)
    data = injections.project(accepted, "manifest", "schedule", review)
    assert {x["relevance"] for x in data["deliveries"]} == {"irrelevant", "unreviewed"}
    assert len(data["review_sha256"]) == 64
    prompt = next(x for x in data["by_hook_shelf"] if x["hook_arm"] == "prompt")
    assert prompt["irrelevant"] == 1 and prompt["correct"] == 0
    for markdown in [True, False]:
        rendered = "\n".join(injections.render(data, markdown=markdown))
        assert "Unreviewed" in rendered and "Irrelevant" in rendered and "public" in rendered
        assert "does not establish a causal token/time effect" in rendered
    report.guard(data)


@pytest.mark.parametrize("change", ["manifest", "schedule", "foreign", "duplicate", "label", "missing-evidence", "prose"])
def test_bad_or_stale_review_refuses_instead_of_silently_changing_precision(change):
    accepted = evidence()
    review = review_for(accepted)
    item = review["judgments"][0]
    if change in {"manifest", "schedule"}:
        review[change + "_hash"] = "other-run"
    elif change == "foreign":
        item["delivery_id"] = "b" * 64
    elif change == "duplicate":
        review["judgments"].append(copy.deepcopy(item))
    elif change == "label":
        item["relevance"] = "pass-means-correct"
    elif change == "missing-evidence":
        item.pop("evidence_sha256")
    else:
        item["body"] = "private review prose"
    with pytest.raises(injections.InjectionReviewError):
        injections.project(accepted, "manifest", "schedule", review)


def test_unknown_ledger_coverage_is_visible_and_duplicate_fire_refuses():
    accepted = evidence()
    accepted["trial-b"] = {"arm_id": "off", "task_id": "actor", "delivery": {"status": "unavailable", "fires": []}}
    data = injections.project(accepted, "manifest", "schedule")
    assert data["unavailable_attempts"] == 1
    fires = accepted["trial-a"]["delivery"]["fires"]
    fires.append(copy.deepcopy(fires[0]))
    with pytest.raises(injections.InjectionReviewError, match="duplicate"):
        injections.project(accepted, "manifest", "schedule")


def test_changed_piece_or_trial_cannot_reuse_a_relevance_label():
    accepted = evidence()
    review = review_for(accepted)
    accepted["trial-a"]["delivery"]["fires"][0]["delivered"] = "inject:replacement"
    with pytest.raises(injections.InjectionReviewError, match="foreign"):
        injections.project(accepted, "manifest", "schedule", review)
