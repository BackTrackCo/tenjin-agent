from pathlib import Path
import json
import sqlite3
from types import SimpleNamespace

import pytest

from evals.benchmark import publication, protocol, tenjin_arm
from evals.benchmark.executor import Provision, ProvisionError


def setup(tmp_path):
    data = tmp_path / "trial-data"
    data.mkdir()
    with sqlite3.connect(data / "loop.db") as db:
        db.execute("CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT)")
        for key, session, project in [("mine", "codex:root", "proj"), ("foreign", "codex:other", "proj"), ("wrong-project", "codex:root", "elsewhere")]:
            db.execute("INSERT INTO facts VALUES (?, ?)", ("finding:" + key, json.dumps({"title": "Use the package command", "body": "The actual producer discovery.", "session": session, "project": project})))
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    (source_dir / "wallet.json").write_text("test stand-in")
    source = tenjin_arm.Source(source_dir, {"baseUrl": "https://bench.example", "publicShelfUrl": "https://public.example"}, {})
    provision = Provision(stop_state={"source": source, "pieces": []})
    return SimpleNamespace(data_dir=data), provision


def test_exact_owned_draft_published_without_wallet_in_artifacts_and_state_removed(tmp_path, monkeypatch):
    roots, provision = setup(tmp_path)
    states = []
    def cli(argv, env, secrets):
        state = Path(env["TENJIN_DATA_DIR"])
        states.append(state)
        assert state != provision.stop_state["source"].path
        assert not state.is_relative_to(roots.data_dir)
        assert (state / "wallet.json").is_symlink()
        assert Path(argv[2]).read_text() == "# Use the package command\n\nThe actual producer discovery."
        assert "--key" not in argv and argv[-2:] == ["--price", "0"]
        return 0, {"data": {"resourceId": "piece-1", "status": "published"}}, ""
    monkeypatch.setattr(tenjin_arm, "_run_cli", cli)
    facts, reason = publication.publish(roots, provision, "codex:root", "proj")
    assert reason is None and facts["status"] == "complete"
    assert len(facts["pieces"]) == 1 and facts["pieces"][0]["published"]
    assert provision.stop_state["pieces"] == ["piece-1"]
    assert all(not state.exists() for state in states)
    assert not (roots.data_dir / "wallet.json").exists()


@pytest.mark.parametrize("code,payload", [(0, {}), (0, {"data": {"resourceId": "missing-status"}}), (0, {"data": {"resourceId": "unknown-status", "status": "pending"}}), (1, {}), (1, {"data": {"resourceId": "possibly-written"}}), (0, {"data": {"resourceId": "draft", "status": "draft"}})])
def test_ambiguous_publish_stops_admission_and_retains_known_cleanup_ids(tmp_path, monkeypatch, code, payload):
    roots, provision = setup(tmp_path)
    monkeypatch.setattr(tenjin_arm, "_run_cli", lambda *args: (code, payload, "private diagnostic"))
    facts, reason = publication.publish(roots, provision, "codex:root", "proj")
    assert reason == "isolation:seed_cleanup"
    assert facts["status"] == "unavailable"
    assert "private diagnostic" not in json.dumps(facts)
    assert provision.stop_state["pieces"] == ([payload["data"]["resourceId"]] if payload.get("data") else [])


def test_no_capture_is_valid_and_does_not_publish(tmp_path, monkeypatch):
    roots, provision = setup(tmp_path)
    monkeypatch.setattr(tenjin_arm, "_run_cli", lambda *args: pytest.fail("no draft, no publish"))
    facts, reason = publication.publish(roots, provision, "codex:absent", "proj")
    assert reason is None and facts["pieces"] == []


def test_invalid_draft_refuses_before_any_publication(tmp_path, monkeypatch):
    roots, provision = setup(tmp_path)
    with sqlite3.connect(roots.data_dir / "loop.db") as db:
        db.execute("UPDATE facts SET value = ? WHERE key = 'finding:mine'", (json.dumps({"session": "codex:root", "project": "proj", "title": "bad\ntitle", "body": "body"}),))
    monkeypatch.setattr(tenjin_arm, "_run_cli", lambda *args: pytest.fail("invalid draft"))
    facts, reason = publication.publish(roots, provision, "codex:root", "proj")
    assert reason == "producer:capture_publication" and facts["pieces"] == []


def test_capture_instruction_applies_only_to_opted_in_producer():
    request = SimpleNamespace(phase="producer", arm={"capture_publication": "host"})
    assert protocol.HOST_CAPTURE_BRIEF in protocol.phase_prompt(request, "Fix it.")
    request.phase = None
    assert protocol.phase_prompt(request, "Fix it.") == "Fix it."
    request.phase, request.arm = "producer", {}
    assert protocol.phase_prompt(request, "Fix it.") == "Fix it."


def test_producer_capture_counts_only_its_own_drafts_without_pairings(tmp_path):
    from evals.benchmark import producer
    from evals.benchmark.tests.support import loop_ddl
    roots, _ = setup(tmp_path)
    path = roots.data_dir / 'loop.db'
    with sqlite3.connect(path) as db:
        db.executescript(loop_ddl())
        db.execute('DROP TABLE IF EXISTS pairings')
        db.execute("INSERT INTO fires (id, at, session, agent, arm, harness, event, cwd, wait, deadline_ms, elapsed_ms, reason) VALUES ('stop', 123, 'codex:root', '', 'stop', 'codex', 'turn.end', '', 'sync', 1000, 1, 'no-question')")
    facts = producer.store_facts(path, 'codex:root', 'proj')
    assert facts['findings'] == 1
    assert facts['fires'] == facts['turn_end_fires'] == 1
    assert facts['first_turn_end_at'] == 123
    assert 'pairings' not in facts
    assert producer.store_facts(path, 'codex:absent', 'proj')['findings'] == 0
