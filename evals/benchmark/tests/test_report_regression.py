"""Main comparison uses verified completion metrics and refuses partial evidence."""
import copy
from evals.benchmark import regress


def report():
    return {"schema": "bench1.report.v1", "manifest_hash": "fixed", "isolation": "attested", "automated": True,
            "invalid": [], "excluded": {}, "run_configuration": {"planned_per_arm": 2, "arm_ids": ["off"]},
            "arms": {"off": {"attempts": 2, "accounting": "complete", "outcomes": {"pass": 2},
                             "pass_rate": 1, "consumer_seconds_per_verified_resolution": 30, "tokens_per_verified_resolution": 100}}}


def test_completion_metrics_compare_and_regressions_are_named():
    main, current = report(), report()
    current["arms"]["off"].update(pass_rate=0.5, consumer_seconds_per_verified_resolution=60, tokens_per_verified_resolution=101)
    result = regress.compare_reports(current, main)
    assert len(result["rows"]) == 3
    assert len(result["findings"]) == 2
    assert result["status"] == "regressions found"


def test_missing_or_invalid_evidence_cannot_be_called_clean():
    for mutate in (
        lambda r: r.update(manifest_hash="changed"),
        lambda r: r.update(invalid=[{}]),
        lambda r: r["arms"]["off"].update(attempts=1),
        lambda r: r["arms"]["off"].update(accounting="incomplete"),
        lambda r: r["run_configuration"].update(arm_ids=["other"]),
    ):
        main = report()
        mutate(main)
        assert regress.compare_reports(report(), main)["status"] == "unavailable"


def test_zero_completions_never_fabricate_a_time_or_token_ratio():
    current = report()
    current["arms"]["off"].update(pass_rate=0, consumer_seconds_per_verified_resolution=None, tokens_per_verified_resolution=None)
    result = regress.compare_reports(current, report())
    assert len(result["findings"]) == 1
    assert result["rows"][1]["current"] is None
