import pytest
from evals.benchmark import report

STAMP = {"provider": "neon", "project_id": "project", "branch_id": "target", "parent_id": "source",
         "origin": "bench.example", "api_origin": "console.neon.tech", "reset_at": "2026-09-11T01:00:00Z",
         "baseline_id": "sha256:" + "a" * 64, "source_lsn": "0/123ABC"}

def accepted(*stamps):
    return {str(i): {"isolation": {"corpus": stamp}} for i, stamp in enumerate(stamps)}

def test_same_revision_retains_each_actual_reset_epoch():
    later = {**STAMP, "reset_at": "2026-09-11T02:00:00Z"}
    result = report.corpus_stamp(accepted(STAMP, later))
    assert result["source_lsn"] == STAMP["source_lsn"]
    assert result["reset_epochs"] == [STAMP["reset_at"], later["reset_at"]]

@pytest.mark.parametrize("change", [{"source_lsn": "0/456"}, {"baseline_id": "sha256:" + "b" * 64}, {"origin": "other.example"}, {"baseline_id": None}])
def test_different_or_unproven_revision_cannot_be_pooled(change):
    later = {**STAMP, "reset_at": "2026-09-11T02:00:00Z", **change}
    with pytest.raises(report.ReportError, match="more than one corpus"):
        report.corpus_stamp(accepted(STAMP, later))

def test_legacy_different_reset_times_still_refuse():
    old = {key: value for key, value in STAMP.items() if key not in {"baseline_id", "source_lsn"}}
    with pytest.raises(report.ReportError):
        report.corpus_stamp(accepted(old, {**old, "reset_at": "later"}))
