"""Native response receipts, cumulative checkpoints and actor-family adversaries."""
import copy
import json

import pytest

from evals.benchmark import codex_usage as codex, usage


def native(value):
    return {"input_tokens": value, "output_tokens": 10, "total_tokens": value + 10,
            "cached_input_tokens": 0, "cache_write_input_tokens": 0, "reasoning_output_tokens": 0}


def rollout(thread="root", parent=None, terminal=True):
    meta = {"id": thread, "session_id": "root", "cli_version": codex.VERSION}
    if parent:
        meta["parent_thread_id"] = parent
    payloads = [("session_meta", meta),
                ("turn_context", {"turn_id": "turn-1", "model": codex.MODEL}),
                ("event_msg", {"type": "task_started", "turn_id": "turn-1"}),
                ("token_usage_record", {"thread_id": thread, "session_id": "root", "turn_id": "turn-1", "root_turn_id": "turn-1",
                                        "response_id": thread + "-r1", "usage": native(100), "thread_token_usage": native(100), "turn_token_usage": native(100)})]
    if terminal:
        payloads.append(("event_msg", {"type": "task_complete", "turn_id": "turn-1"}))
    return [{"timestamp": "2026-09-11T21:00:00Z", "type": kind, "payload": payload} for kind, payload in payloads]


def write(tmp, content, name="root"):
    path = tmp / (name + ".jsonl")
    path.write_text("".join(json.dumps(row) + "\n" for row in content))
    return path


def parse(tmp):
    return codex.parse_session_dir(tmp, "root", "trial")


def test_native_ids_and_unexposed_zero_categories(tmp_path):
    write(tmp_path, rollout())
    session = parse(tmp_path)
    assert session.reconciliation["status"] == "matched"
    record = session.records[0]
    assert record.native_request_id == "root-r1"
    assert record.actor_key == ("codex", "root", "")
    assert record.total == 110
    assert record.cache_read is record.cache_write is record.reasoning_output_subset is record.uncached_input is None


def test_cumulative_checkpoints_and_duplicate_receipts_are_not_added(tmp_path):
    content = rollout()
    second = copy.deepcopy(content[3])
    second["payload"].update(response_id="root-r2", usage=native(50), thread_token_usage={**native(150), "output_tokens": 20, "total_tokens": 170})
    content[4:4] = [second, copy.deepcopy(second)]
    write(tmp_path, content)
    session = parse(tmp_path)
    assert usage.totals(session.records)["total"] == 170
    assert len(session.records) == 2
    assert session.reconciliation["status"] == "matched"


def test_descendants_have_explicit_native_parents_and_their_own_spend(tmp_path):
    write(tmp_path, rollout())
    write(tmp_path, rollout("child", "root"), "child")
    write(tmp_path, rollout("grandchild", "child"), "grandchild")
    session = parse(tmp_path)
    assert usage.totals(session.records)["total"] == 330
    assert session.reconciliation["status"] == "matched_with_descendants"
    assert session.actor_entries()[1]["parent_provenance"] == "native"
    assert len(session.parent_edges) == 2


@pytest.mark.parametrize("change", ("different_model", "different_version", "foreign_usage", "missing_request_id", "conflicting_duplicate"))
def test_contradictions_cannot_become_product_evidence(tmp_path, change):
    content = rollout()
    if change == "different_model":
        content[1]["payload"]["model"] = "gpt-5.5"
    elif change == "different_version":
        content[0]["payload"]["cli_version"] = "0.1.0"
    elif change == "foreign_usage":
        content[3]["payload"]["thread_id"] = "someone-else"
    elif change == "missing_request_id":
        del content[3]["payload"]["response_id"]
    else:
        duplicate = copy.deepcopy(content[3])
        duplicate["payload"]["usage"] = native(99)
        content.insert(4, duplicate)
    write(tmp_path, content)
    with pytest.raises((codex.CodexUsageError, usage.UsageError)):
        parse(tmp_path)


def test_checkpoint_disagreement_is_invalid(tmp_path):
    content = rollout()
    content[3]["payload"]["thread_token_usage"] = native(101)
    write(tmp_path, content)
    assert parse(tmp_path).invalid_reason == "usage:mismatch"


def test_latest_started_turn_and_each_child_must_finish(tmp_path):
    content = rollout()
    content.append({"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn-2"}})
    write(tmp_path, content)
    write(tmp_path, rollout("child", "root", terminal=False), "child")
    assert set(codex.scan(tmp_path, "root")[1]) == {"", "child"}
    assert parse(tmp_path).reconciliation["status"] == "no_envelope"


def test_truncated_last_write_retains_observed_spend(tmp_path):
    path = write(tmp_path, rollout(terminal=False))
    with path.open("a") as out:
        out.write('{"type":')
    assert usage.totals(parse(tmp_path).records)["total"] == 110


def test_fork_history_does_not_manufacture_a_parent(tmp_path):
    write(tmp_path, rollout())
    content = rollout("child")
    content[0]["payload"]["forked_from_id"] = "root"
    write(tmp_path, content, "child")
    with pytest.raises(codex.CodexUsageError, match="explicit parent"):
        parse(tmp_path)


def test_limit_classification_uses_terminal_native_error_not_task_text(tmp_path):
    content = rollout()
    content[-1]["payload"]["last_agent_message"] = "usage_limit_exceeded"
    write(tmp_path, content)
    assert not codex.provider_limit(tmp_path, "root")
    content[-1]["payload"]["error"] = {"codex_error_info": "usage_limit_exceeded"}
    write(tmp_path, content)
    assert codex.provider_limit(tmp_path, "root")


def test_shared_runner_resolves_native_codex_root_and_verifies_the_task(tmp_path, monkeypatch):
    import dataclasses
    from evals.benchmark import executor, records, runner, schedule, sha256_json
    from evals.benchmark.tests import support
    spec = executor.ExecutorSpec(name='synthetic_codex', harness='codex',
        launch=lambda request: executor.Launch([], request.roots.repo, 'pending-native-id'),
        evidence=codex.EVIDENCE)
    monkeypatch.setitem(executor.REGISTRY, spec.name, spec)
    config = support.synthetic_manifest(tmp_path, executor_name=spec.name, arms=('off',))
    data = {**config.data, 'harness': 'codex', 'pins': {**config.pins, 'model': codex.MODEL, 'harness_version': codex.VERSION}}
    config = dataclasses.replace(config, data=data, hash=sha256_json(data))
    def spawn(launch, roots, timeout_s):
        (roots.repo / 'answer.txt').write_text('42\n')
        directory = roots.output / 'sessions'; directory.mkdir()
        write(directory, rollout())
        roots.stream.write_text(json.dumps({'type':'thread.started', 'thread_id':'root'})+'\n')
        return runner.Completed(0, '', False, agent_time_s=1.5)
    trial = schedule.expand(config)[0]
    result = runner.run_trial(config, trial, tmp_path/'run', 'sha256:schedule', runner.Runtime(spawn=spawn))
    records.validate(result)
    assert result['outcome'] == 'pass'
    assert result['native_root_id'] == 'root'
    assert result['usage'][0]['native_request_id'] == 'root-r1'
    assert result['agent_time_s'] == 1.5
