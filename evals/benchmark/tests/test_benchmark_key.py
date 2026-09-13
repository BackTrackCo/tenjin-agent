"""Dedicated benchmark keys cannot silently become ordinary team credentials."""
import dataclasses
import hashlib
import json

import pytest

from evals.benchmark import artifact, benchmark_key, report, tenjin_arm
from evals.benchmark.tests import support

SECRET = "benchmark-test-key"
RECEIPT = {"schema": benchmark_key.SCHEMA, "project_id": benchmark_key.PROJECT,
           "origin": benchmark_key.ORIGIN, "key_sha256": hashlib.sha256(SECRET.encode()).hexdigest()}
STAMP = artifact.CorpusStamp("neon", "bench-project", "bench-branch", "bench-parent",
                             benchmark_key.ORIGIN, "console.neon.tech", "2026-09-13T00:00:00Z")
ATTESTED = dataclasses.replace(support.ATTESTED, benchmark_shelf_key=RECEIPT, corpus=STAMP,
                              network_allowlist=(*support.ATTESTED.network_allowlist, benchmark_key.ORIGIN, "console.neon.tech"))


def isolation(**overrides):
    return artifact.require_isolation(**{ "live": True, "publishable": True, "automated": True,
        "attestation": ATTESTED, "shelf_secret_present": True, "shelf_origin": benchmark_key.ORIGIN,
        "benchmark_shelf_key": RECEIPT, **overrides})


def test_benchmark_key_is_attested_but_presence_remains_visible():
    result = isolation()
    assert result["publishable"] and result["shelf_secret_present"]
    assert result["benchmark_shelf_key"] == RECEIPT
    assert benchmark_key.recorded(result)
    assert report.isolation_kind({"isolation": result}) == "attested"
    assert SECRET not in json.dumps(result)
    assert ATTESTED.hash() != dataclasses.replace(ATTESTED, benchmark_shelf_key=None).hash()


@pytest.mark.parametrize("override", [
    {"attestation": None},
    {"attestation": dataclasses.replace(ATTESTED, benchmark_shelf_key=None)},
    {"attestation": dataclasses.replace(ATTESTED, corpus=None)},
    {"attestation": dataclasses.replace(ATTESTED, corpus=dataclasses.replace(STAMP, origin="team.example"))},
    {"attestation": dataclasses.replace(ATTESTED, benchmark_shelf_key={**RECEIPT, "key_sha256": "a" * 64})},
    {"shelf_origin": "team.example"}, {"shelf_secret_present": False},
    {"benchmark_shelf_key": {**RECEIPT, "project_id": "production"}},
])
def test_scope_mismatch_refuses_before_execution(override):
    with pytest.raises(artifact.IsolationError, match="benchmark_shelf_key"):
        isolation(**override)


def test_source_receipt_binds_actual_secret_and_origin(tmp_path):
    source = support.tenjin_source(tmp_path, base_url="https://bench.tenjin.sh", shelf_secret=SECRET)
    (source / benchmark_key.FILE).write_text(json.dumps(RECEIPT))
    loaded = tenjin_arm.load_source(source)
    assert loaded.facts["benchmark_shelf_key"] == RECEIPT
    config = tenjin_arm.seeded_config(loaded, 1234)
    assert config["shelfBypassSecret"] == SECRET
    assert config["publish"]["defaultPrice"] == "0"
    config_path = source / "config.json"
    data = json.loads(config_path.read_text())
    data["shelfBypassSecret"] = "different-key"
    config_path.write_text(json.dumps(data))
    with pytest.raises(tenjin_arm.ProvisionError, match="does not match"):
        tenjin_arm.load_source(source)


@pytest.mark.parametrize("change", [{"origin": "team.example"}, {"project_id": "prod"}, {"secret": SECRET}, {"key_sha256": "oops"}])
def test_bad_receipt_is_refused(change):
    with pytest.raises(ValueError):
        benchmark_key.validate({**RECEIPT, **change})


def test_configure_uses_free_team_mode_and_private_files(tmp_path):
    benchmark_key.configure(tmp_path, SECRET, RECEIPT)
    config = json.loads((tmp_path / "config.json").read_text())
    assert config["publish"] == {"mode": "auto", "defaultPrice": "0"}
    assert config["team"] == {"publicFallback": "on"}
    assert config["shelfBypassSecret"] == SECRET
    assert (tmp_path / "config.json").stat().st_mode & 0o777 == 0o600
    with pytest.raises(ValueError, match="already exists"):
        benchmark_key.configure(tmp_path, SECRET, RECEIPT)


def test_existing_paid_pointer_run_cannot_resume_as_free_team_run(tmp_path):
    (tmp_path / "records").mkdir()
    (tmp_path / "records" / "old.json").write_text("{}")
    with pytest.raises(ValueError, match="predates"):
        benchmark_key.bind_run(tmp_path, RECEIPT, "manifest")


def test_changed_key_or_manifest_cannot_mix_into_a_resume(tmp_path):
    benchmark_key.bind_run(tmp_path, RECEIPT, "manifest")
    benchmark_key.bind_run(tmp_path, RECEIPT, "manifest")
    with pytest.raises(ValueError, match="changed"):
        benchmark_key.bind_run(tmp_path, RECEIPT, "new-manifest")
    with pytest.raises(ValueError, match="changed"):
        benchmark_key.bind_run(tmp_path, {**RECEIPT, "key_sha256": "a" * 64}, "manifest")


def test_receipt_refuses_plain_http_even_on_matching_host(tmp_path):
    source = support.tenjin_source(tmp_path, base_url="http://bench.tenjin.sh", shelf_secret=SECRET)
    (source / benchmark_key.FILE).write_text(json.dumps(RECEIPT))
    with pytest.raises(tenjin_arm.ProvisionError, match="HTTPS"):
        tenjin_arm.load_source(source)
