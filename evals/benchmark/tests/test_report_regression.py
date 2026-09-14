"""Main comparison uses verified completion metrics and refuses partial evidence."""
import copy
from evals.benchmark import regress


def report():
    return {"schema": "bench1.report.v1", "manifest_hash": "fixed", "regression_protocol_hash": "protocol", "isolation": "attested", "automated": True,
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
        lambda r: r.update(regression_protocol_hash="changed"),
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


def test_product_revisions_can_change_but_measurement_inputs_cannot():
    manifest = {"pins": {"model": "model-1"}, "arms": [{"id": "off", "product_version": "v1"}]}
    new = copy.deepcopy(manifest)
    new["arms"][0]["product_version"] = "v2"
    assert regress.protocol_hash(new) == regress.protocol_hash(manifest)
    new["pins"]["model"] = "model-2"
    assert regress.protocol_hash(new) != regress.protocol_hash(manifest)
    current = report()
    current["manifest_hash"] = "new-product-version"
    assert regress.compare_reports(current, report())["status"] == "compared"


def test_harness_update_signal_keeps_other_inputs_frozen_and_labels_attribution():
    manifest = {"pins": {"model": "same", "harness_version": "1.0.0"}, "arms": []}
    update = copy.deepcopy(manifest)
    update["pins"]["harness_version"] = "1.1.0"
    update["pins"]["harness_integrity"] = "new-release-integrity"
    assert regress.protocol_hash(update) != regress.protocol_hash(manifest)
    assert regress.protocol_hash(update, harness_update=True) == regress.protocol_hash(manifest, harness_update=True)
    update["pins"]["model"] = "different"
    assert regress.protocol_hash(update, harness_update=True) != regress.protocol_hash(manifest, harness_update=True)
    old, new = report(), report()
    for item, version in ((old, "1.0.0"), (new, "1.1.0")):
        item["harness_update_protocol_hash"] = "update"
        item["run_configuration"]["harness_version"] = version
    new["regression_protocol_hash"] = "new"
    new["arms"]["off"]["tokens_per_verified_resolution"] = 200
    result = regress.compare_harness_updates(new, old)
    assert result["status"] == "regressions found"
    assert "mixed or unknown" in result["attribution"]
    assert result["harness_versions"] == {"main": "1.0.0", "current": "1.1.0"}
    old["invalid"] = [{}]
    assert regress.compare_harness_updates(new, old)["status"] == "unavailable"
    old["harness_update_protocol_hash"] = "other"
    assert regress.compare_harness_updates(new, old)["status"] == "unavailable"
