import json
import subprocess
from pathlib import Path
import pytest
from evals.benchmark import corpus, frozen_corpus

CONFIG = corpus.Corpus("neon", "project", "target", "source", "bench.example")

class Api:
    def __init__(self):
        self.source = {"id": "source", "created_at": "2026-09-01T00:00:00Z", "last_reset_at": None}
        self.target = {"id": "target", "parent_id": "source", "default": False, "protected": False, "parent_lsn": "0/ABC"}
        self.calls = []
        self.head = "0/ABC"
        self.fail = False
    def branch(self, project, branch):
        self.calls.append(("read", branch))
        return dict(self.source if branch == "source" else self.target)
    def reset_to_parent(self, project, target, source, source_lsn=None):
        self.calls.append(("restore", source_lsn))
        if self.fail:
            raise corpus.CorpusError("expired", "retention expired")
        self.target["parent_lsn"] = source_lsn or self.head
        return {"operations": [{"id": "operation-" + str(len(self.calls))}]}

def test_continuation_restores_frozen_lsn_not_new_parent_head(tmp_path):
    api = Api()
    first = frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    api.head = "0/DEF"
    second = frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    assert first.baseline_id == second.baseline_id
    assert first.source_lsn == second.source_lsn == "0/ABC"
    assert [call for call in api.calls if call[0] == "restore"] == [("restore", None), ("restore", "0/ABC")]
    assert len(list((tmp_path / "corpus-epochs").glob("*.json"))) == 2

def test_changed_schedule_refuses_before_provider_calls(tmp_path):
    api = Api()
    frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    api.calls.clear()
    with pytest.raises(corpus.CorpusError, match="baseline_mismatch"):
        frozen_corpus.reset(CONFIG, api, tmp_path, "different")
    assert api.calls == []

def test_source_generation_change_refuses_before_reset(tmp_path):
    api = Api()
    frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    api.source["last_reset_at"] = "2026-09-11T00:00:00Z"
    api.calls.clear()
    with pytest.raises(corpus.CorpusError, match="source_changed"):
        frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    assert not any(call[0] == "restore" for call in api.calls)

def test_expired_revision_never_falls_back_to_head(tmp_path):
    api = Api()
    frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    original = (tmp_path / frozen_corpus.BASELINE).read_bytes()
    api.fail = True
    with pytest.raises(corpus.CorpusError, match="expired"):
        frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    assert api.calls[-1] == ("restore", "0/ABC")
    assert (tmp_path / frozen_corpus.BASELINE).read_bytes() == original

def test_unconfirmed_lsn_does_not_mint_a_baseline(tmp_path):
    api = Api(); api.head = ""
    with pytest.raises(corpus.CorpusError, match="revision_unconfirmed"):
        frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    assert not (tmp_path / frozen_corpus.BASELINE).exists()

def test_retained_records_without_baseline_refuse(tmp_path):
    (tmp_path / "records").mkdir(); (tmp_path / "records" / "one.json").write_text("{}")
    api = Api()
    with pytest.raises(corpus.CorpusError, match="baseline_missing"):
        frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    assert api.calls == []

def test_cli_uses_structured_argument_and_has_no_auth_fallback(monkeypatch):
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, '{"branch":{"id":"target"}}', '')
    monkeypatch.setattr(subprocess, "run", run)
    api = corpus.CliApi()
    assert api.branch("project", "target")["id"] == "target"
    api._call("POST", "/projects/project/branches/target/restore", {"source_branch_id": "source"})
    assert calls[-1][-1] == '--data={"source_branch_id": "source"}'
    assert all("--api-key" not in argv for argv in calls)


def test_reporting_refuses_missing_or_changed_epoch_receipts(tmp_path):
    from dataclasses import asdict
    api = Api()
    stamp = frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    accepted = {"trial": {"isolation": {"corpus": asdict(stamp)}}}
    frozen_corpus.verify_records(tmp_path, accepted)
    receipt = next((tmp_path / "corpus-epochs").glob("*.json"))
    evidence = json.loads(receipt.read_text())
    evidence["operation_ids"] = ["other-operation"]
    receipt.write_text(json.dumps(evidence))
    with pytest.raises(corpus.CorpusError, match="epoch_unconfirmed"):
        frozen_corpus.verify_records(tmp_path, accepted)
    receipt.unlink()
    with pytest.raises(corpus.CorpusError, match="epoch_unconfirmed"):
        frozen_corpus.verify_records(tmp_path, accepted)


def test_changed_runtime_refuses_before_provider_calls(tmp_path, monkeypatch):
    api = Api()
    frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    api.calls.clear()
    monkeypatch.setattr(frozen_corpus, "RUNTIME_REVISION", "sha256:changed")
    with pytest.raises(corpus.CorpusError, match="baseline_mismatch"):
        frozen_corpus.reset(CONFIG, api, tmp_path, "manifest")
    assert api.calls == []
