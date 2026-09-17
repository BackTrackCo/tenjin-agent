"""Selections preserve the source's execution identity without copied experiments."""
import json
import shutil

import pytest

from evals.benchmark import cli, manifest, schedule


@pytest.fixture
def source(tmp_path):
    shutil.copytree(cli.FAKE_MANIFEST.parent, tmp_path / "fixture")
    return tmp_path / "fixture" / cli.FAKE_MANIFEST.name


def test_selection_uses_source_order_and_hashes_the_effective_run(source):
    full = manifest.load(source)
    path = source.with_name("selected.json")
    path.write_text(json.dumps({"schema": "bench1.selection.v1", "source": source.name, "arms": [full.arms[0]["id"]]}))
    selected = manifest.load(path)
    assert selected.tasks == full.tasks
    assert selected.arms == full.arms[:1]
    assert selected.fixture_path(selected.tasks[0]) == full.fixture_path(full.tasks[0])
    assert selected.hash != full.hash
    assert len(schedule.expand(selected)) == len(full.tasks) * full.data["repeats"]
    assert manifest.load(path).hash == selected.hash
    changed = json.loads(source.read_text())
    changed["seed"] += 1
    source.write_text(json.dumps(changed))
    assert manifest.load(path).hash != selected.hash


@pytest.mark.parametrize("change", [
    {"source": "../manifest.json"}, {"source": "selected.json"},
    {"arms": ["unknown"]}, {"tasks": []}, {"arms": ["off", "off"]},
    {"arms": [True]}, {"pins": {}}, {"schema": "other"},
])
def test_invalid_selections_refuse_before_execution(source, change):
    path = source.with_name("selected.json")
    path.write_text(json.dumps({"schema": "bench1.selection.v1", "source": source.name, **change}))
    with pytest.raises(manifest.ManifestError):
        manifest.load(path)


def test_one_arm_run_reports_plumbing_without_a_product_comparison(source, tmp_path):
    full = manifest.load(source)
    path = source.with_name("selected.json")
    path.write_text(json.dumps({"schema": "bench1.selection.v1", "source": source.name, "arms": [full.arms[0]["id"]]}))
    out = tmp_path / "run"
    cli.fake_run(out, manifest_path=path)
    report = json.loads((out / "report.json").read_text())
    assert len(report["arms"]) == 1
    assert report["comparisons"] == {}
    assert report["run_configuration"]["arm_ids"] == [full.arms[0]["id"]]
