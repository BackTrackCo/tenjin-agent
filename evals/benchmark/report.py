"""Publishable projection and its redaction guard.

The report carries counts, enums, opaque ids, hashes, and reason codes only.
The guard is structural: every string must be an opaque token, so a host
path, prompt, transcript line, or credential cannot ride along in any field.
"""

from __future__ import annotations

import re
from typing import Any

REPORT_SCHEMA = "bench1.report.v0"
OPAQUE = re.compile(r"^[A-Za-z0-9_.:+-]{0,128}$")
FORBIDDEN_KEYS = frozenset({"prompt", "transcript", "path", "body", "home", "cwd", "argv", "env", "detail", "stderr"})


class ReportError(ValueError):
    pass


def guard(value: Any, trail: str = "report") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in FORBIDDEN_KEYS:
                raise ReportError(f"{trail}.{key} is a private field")
            guard(item, f"{trail}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            guard(item, f"{trail}[{index}]")
    elif isinstance(value, str):
        if not OPAQUE.match(value):
            raise ReportError(f"{trail} is not an opaque token")
    elif value is not None and not isinstance(value, (int, float, bool)):
        raise ReportError(f"{trail} has an unpublishable type")


def project(manifest_data: dict[str, Any], manifest_hash: str, schedule_hash: str, reduction: dict[str, Any], accepted: dict[str, dict[str, Any]]) -> dict[str, Any]:
    excluded: dict[str, int] = {}
    for item in reduction["excluded"]:
        reason = item["reason"].split(":", 1)[0]
        excluded[reason] = excluded.get(reason, 0) + 1
    report = {
        "schema": REPORT_SCHEMA,
        "benchmark_version": manifest_data["benchmark_version"],
        "manifest_hash": manifest_hash,
        "schedule_hash": schedule_hash,
        "arms": reduction["arms"],
        "invalid": reduction["invalid"],
        "excluded": excluded,
        "trials": [
            {
                "trial_id": record["trial_id"],
                "task_id": record["task_id"],
                "arm_id": record["arm_id"],
                "outcome": record["outcome"],
                "stop_reason": record.get("stop_reason"),
                "actors": len(record.get("actors", [])),
                "requests": len(record["usage"]),
                "tokens": sum(item["input_total"] + item["output_total"] for item in record["usage"]),
            }
            for record in sorted(accepted.values(), key=lambda item: item["position"])
        ],
    }
    guard(report)
    return report
