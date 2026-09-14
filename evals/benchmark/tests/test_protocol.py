"""Required delegation is proven by native ancestry and positive recorded usage."""
import copy
import dataclasses
import json
from types import SimpleNamespace

import pytest

from evals.benchmark import FIXTURES, codex_usage, executor, manifest, protocol, records, runner, schedule, sha256_json
from . import support
from .test_codex_usage import rollout, write


def session(harness="codex", children=("child",), edges=None, used=None):
    root = (harness, "root", "")
    actors = [root, *((harness, "root", child) for child in children)]
    edges = [(child, "", "native") for child in children] if edges is None else edges
    used = set(children) if used is None else set(used)
    return SimpleNamespace(root_session_id="root", actors=actors,
        records=[SimpleNamespace(actor_key=actor, input_total=10, output_total=5) for actor in actors if actor[2] in used],
        parent_edges=[SimpleNamespace(child=(harness, "root", child), parent=(harness, "root", parent), provenance=kind) for child, parent, kind in edges])


@pytest.mark.parametrize("harness", ["claude", "codex"])
def test_native_nested_descendants_count_with_both_harnesses(harness):
    evidence = session(harness, ("child", "grandchild"), [("child", "", "native"), ("grandchild", "child", "native")])
    assert protocol.observed_descendants(evidence) == 2
    assert protocol.completion_refusal({"required_descendants": 2}, evidence, "pass") is None
    assert protocol.completion_refusal({"required_descendants": 3}, evidence, "pass") == "protocol:missing_descendant"


@pytest.mark.parametrize("evidence", [None, session(children=()), session(used=()),
    session(edges=[("child", "", "inferred")]), session(edges=[("child", "missing", "native")]),
    session(edges=[("child", "child", "native")]),
    session(edges=[("child", "", "native"), ("child", "other", "native")])])
def test_missing_empty_inferred_or_unresolved_descendants_refuse(evidence):
    assert protocol.completion_refusal({"required_descendants": 1}, evidence, "pass") == "protocol:missing_descendant"


@pytest.mark.parametrize("outcome,reason", [("capped", None), ("interrupted", None), ("fail", None), ("invalid", "usage:mismatch"), ("pass", "isolation:sentinel")])
def test_coverage_does_not_replace_existing_outcomes(outcome, reason):
    assert protocol.completion_refusal({"required_descendants": 1}, None, outcome, reason) == reason


def test_permission_alone_does_not_require_delegation():
    assert protocol.completion_refusal({"tools": ["Agent"]}, None, "pass") is None


@pytest.mark.parametrize("count", [-1, True, 1.5, 65])
def test_bad_required_count_is_rejected(count):
    base = FIXTURES / "fake"
    data = json.loads((base / "manifest.json").read_text())
    data["tasks"][0]["required_descendants"] = count
    with pytest.raises(manifest.ManifestError):
        manifest.validate(data, base)


def test_requirement_needs_recursive_and_resolved_task_permission():
    base = FIXTURES / "fake"
    data = json.loads((base / "manifest.json").read_text())
    task = data["tasks"][0]
    task["required_descendants"] = 1
    with pytest.raises(manifest.ManifestError):
        manifest.validate(data, base)
    data["slice"] = {"kind": "recursive"}
    data["pins"]["tools"] = ["Agent"]
    manifest.validate(data, base)
    task["tools"] = ["Read"]
    with pytest.raises(manifest.ManifestError):
        manifest.validate(data, base)
    task["required_descendants"] = 0
    data.pop("slice")
    manifest.validate(data, base)


def test_root_only_verified_codex_success_is_invalid_but_keeps_cost_and_verdict(tmp_path, monkeypatch):
    spec = executor.ExecutorSpec(name="protocol_codex", harness="codex",
        launch=lambda request: executor.Launch([], request.roots.repo, "pending-native-id"), evidence=codex_usage.EVIDENCE)
    monkeypatch.setitem(executor.REGISTRY, spec.name, spec)
    config = support.synthetic_manifest(tmp_path, executor_name=spec.name, arms=("off",))
    data = copy.deepcopy(config.data)
    data["harness"] = "codex"
    data["pins"].update(model=codex_usage.MODEL, harness_version=codex_usage.VERSION)
    data["tasks"][0]["required_descendants"] = 1
    config = dataclasses.replace(config, data=data, hash=sha256_json(data))
    def spawn(launch, roots, timeout_s):
        (roots.repo / "answer.txt").write_text("42\n")
        directory = roots.output / "sessions"; directory.mkdir()
        write(directory, rollout())
        roots.stream.write_text(json.dumps({"type": "thread.started", "thread_id": "root"}) + "\n")
        return runner.Completed(0, "", False, agent_time_s=1.5)
    trial = schedule.expand(config)[0]
    result = runner.run_trial(config, trial, tmp_path / "run", "sha256:schedule", runner.Runtime(spawn=spawn))
    records.validate(result)
    assert (result["outcome"], result["invalid_reason"]) == ("invalid", "protocol:missing_descendant")
    assert result["verifier"]["exit_code"] == 0
    assert result["agent_time_s"] == 1.5 and result["usage"][0]["input_total"] > 0
