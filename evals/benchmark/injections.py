"""Hook delivery attribution and optional, explicit task-relevance judgments.

Delivery is a ledger fact; relevance is a separate review. Neither task success,
seed identity nor a search hit establishes relevance. Only exact consumer fires
are counted, and a source is named only when its winning leg is unambiguous.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from . import canonical_json

REVIEW_SCHEMA = "bench1.injection-review.v1"
LABELS = ("correct", "irrelevant", "uncertain", "unreviewed")
SHELVES = {"team": "team", "keys": "team", "public": "public", "local": "local"}
FORMS = ("pointer", "full_body", "truncated_body", "unknown")


def presentation(emit: str | None, delivered: str | None) -> dict:
    """Classify the exact saved emit, never the leg's artifact-type `form`."""
    unknown = {"delivery_form": "unknown", "emitted_context_chars": None}
    if not isinstance(emit, str) or not isinstance(delivered, str) or not delivered.startswith("inject:"):
        return unknown
    try:
        payload = json.loads(emit)
    except ValueError:
        return unknown
    text = payload.get("context") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.startswith("[Tenjin]"):
        return unknown
    result = {**unknown, "emitted_context_chars": len(text)}
    fences = list(re.finditer(r"^--- tenjin-body ([a-z0-9]{1,8}) ---$", text, re.MULTILINE))
    if len(fences) == 2 and fences[0][1] == fences[1][1]:
        body = text[fences[0].end():fences[1].start()].strip("\n")
        truncated = body.endswith("[truncated; the full piece: tenjin read " + delivered[7:] + "]")
        result["delivery_form"] = "truncated_body" if truncated else "full_body"
    elif not fences and re.search(r"^(?:Read it free: tenjin read |Inspect it free: tenjin inspect )" + re.escape(delivered[7:]) + r"$", text, re.MULTILINE):
        result["delivery_form"] = "pointer"
    return result


class InjectionReviewError(ValueError):
    pass


def identity(trial_id: str, fire: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json([trial_id, fire["fire_id"], fire["delivered"]]).encode()).hexdigest()


def source(fire_id: str, legs: list[dict[str, Any]]) -> str:
    winners = {SHELVES.get(leg.get("shelf"), "unknown") for leg in legs
               if leg.get("fire_id") == fire_id and leg.get("outcome") == "hit" and leg.get("status") != "skipped"}
    return next(iter(winners)) if len(winners) == 1 else "unknown"


def judgments(review: dict | None, manifest_hash: str, schedule_hash: str, ids: set[str]) -> dict[str, dict]:
    if review is None:
        return {}
    if not isinstance(review, dict) or set(review) != {"schema", "manifest_hash", "schedule_hash", "judgments"}:
        raise InjectionReviewError("injection review requires schema, run hashes and judgments only")
    if review["schema"] != REVIEW_SCHEMA or review["manifest_hash"] != manifest_hash or review["schedule_hash"] != schedule_hash:
        raise InjectionReviewError("injection review does not match this run")
    if not isinstance(review["judgments"], list):
        raise InjectionReviewError("injection judgments must be a list")
    indexed: dict[str, dict] = {}
    for item in review["judgments"]:
        if not isinstance(item, dict) or set(item) != {"delivery_id", "relevance", "evidence_sha256"}:
            raise InjectionReviewError("each injection judgment requires delivery_id, relevance and evidence_sha256 only")
        key, evidence = item["delivery_id"], item["evidence_sha256"]
        if not isinstance(key, str) or key not in ids or key in indexed:
            raise InjectionReviewError("injection judgment is foreign or duplicated")
        if item["relevance"] not in LABELS[:-1]:
            raise InjectionReviewError("injection relevance must be correct, irrelevant or uncertain")
        if not isinstance(evidence, str) or len(evidence) != 64 or any(c not in "0123456789abcdef" for c in evidence):
            raise InjectionReviewError("injection judgment requires the SHA-256 of its private review evidence")
        indexed[key] = item
    return indexed


def project(accepted: dict[str, dict], manifest_hash: str, schedule_hash: str, review: dict | None = None) -> dict:
    deliveries: dict[str, dict] = {}
    hooks: dict[tuple[str, str, str], dict] = {}
    observed = unavailable = 0
    for trial_id, record in sorted(accepted.items()):
        delivery = record["delivery"]
        observed += int(delivery.get("status") == "joined")
        unavailable += int(delivery.get("status") != "joined")
        # loop_join has already separated producer phases and unmatched actors.
        seen: set[str] = set()
        for fire in delivery.get("fires", []):
            if fire["fire_id"] in seen:
                raise InjectionReviewError("duplicate consumer fire in injection evidence")
            seen.add(fire["fire_id"])
            hook, event = fire.get("hook_arm") or "unknown", fire.get("event") or "unknown"
            key = (record["arm_id"], hook, event)
            row = hooks.setdefault(key, {"arm_id": key[0], "hook_arm": hook, "event": event, "fires": 0, "delivered": 0})
            row["fires"] += 1
            sent = fire.get("delivered")
            if not isinstance(sent, str) or not sent.startswith("inject:") or not sent[7:]:
                continue
            row["delivered"] += 1
            delivery_id = identity(trial_id, fire)
            deliveries[delivery_id] = {"delivery_id": delivery_id, "trial_id": trial_id, "task_id": record["task_id"],
                                       "arm_id": record["arm_id"], "hook_arm": hook, "event": event,
                                       "shelf": source(fire["fire_id"], delivery.get("legs", [])), "relevance": "unreviewed",
                                       "delivery_form": fire.get("delivery_form", "unknown"),
                                       "emitted_context_chars": fire.get("emitted_context_chars")}
            if deliveries[delivery_id]["delivery_form"] not in FORMS:
                raise InjectionReviewError("unsupported injection delivery form")
    reviewed = judgments(review, manifest_hash, schedule_hash, set(deliveries))
    rows: dict[tuple[str, ...], dict] = {}
    for key, item in sorted(deliveries.items()):
        if key in reviewed:
            item.update({field: reviewed[key][field] for field in ("relevance", "evidence_sha256")})
        fields = ("arm_id", "hook_arm", "event", "shelf", "delivery_form")
        group = tuple(item[field] for field in fields)
        row = rows.setdefault(group, {**dict(zip(fields, group)), "delivered": 0, **dict.fromkeys(LABELS, 0)})
        row["delivered"] += 1
        row[item["relevance"]] += 1
    return {"observed_attempts": observed, "unavailable_attempts": unavailable,
            "review_sha256": None if review is None else hashlib.sha256(canonical_json(review).encode()).hexdigest(),
            "hooks": [hooks[key] for key in sorted(hooks)], "by_hook_shelf": [rows[key] for key in sorted(rows)],
            "deliveries": [deliveries[key] for key in sorted(deliveries)]}


def render(data: dict | None, *, markdown: bool = False, show_empty_hooks: bool = False) -> list[str]:
    if data is None:
        return []
    lines = ["", "Hook injections: consumer deliveries; relevance is separately reviewed.",
             f"Ledger coverage: {data['observed_attempts']} attempts observed; {data['unavailable_attempts']} unavailable or hooks disabled."]
    rows = data["by_hook_shelf"]
    if rows:
        columns = ["Experiment", "Hook", "Event", "Shelf", "Delivery form", "Delivered", "Correct", "Irrelevant", "Uncertain", "Unreviewed"]
        values = [[str(row[key]) for key in ("arm_id", "hook_arm", "event", "shelf", "delivery_form", "delivered", *LABELS)] for row in rows]
        if markdown:
            lines += ["", "| " + " | ".join(columns) + " |", "| " + " | ".join("---" for _ in columns) + " |"]
            lines += ["| " + " | ".join(row) + " |" for row in values]
        else:
            lines += [" | ".join(columns), *[" | ".join(row) for row in values]]
    else:
        lines.append("No recorded consumer injections; this does not establish zero false injections when ledger coverage is unavailable.")
    for row in data["hooks"]:
        if show_empty_hooks and not row["delivered"]:
            lines.append(f"{row['arm_id']} {row['hook_arm']} ({row['event']}): {row['fires']} fires, 0 injections.")
    lines.append("Unreviewed is not correct. Counts include accepted invalid attempts for diagnosis; relevance does not establish a causal token/time effect. No dispatch row means no observed dispatch coverage.")
    return lines
