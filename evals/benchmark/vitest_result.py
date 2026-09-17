"""Accept only complete, internally consistent behavioral assertion reports."""
from typing import Any


def outcome(data: dict[str, Any], code: int) -> str:
    assertions = [a for suite in data.get("testResults", []) for a in suite.get("assertionResults", [])]
    statuses = [a.get("status") for a in assertions]
    failed = statuses.count("failed")
    if (not statuses or len(statuses) != data.get("numTotalTests")
            or any(status not in {"passed", "failed"} for status in statuses)
            or data.get("numRuntimeErrorTestSuites", 0) != 0
            or data.get("numFailedTests") != failed
            or data.get("numPassedTests") != len(statuses) - failed):
        return "invalid"
    if code == 0 and data.get("success") is True and failed == 0:
        return "pass"
    if code == 1 and data.get("success") is False and failed > 0:
        return "fail"
    return "invalid"
