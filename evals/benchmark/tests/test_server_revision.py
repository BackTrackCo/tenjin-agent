"""Deployment changes must stop admission without hiding completed trial evidence."""
import json

import pytest

from evals.benchmark import server_revision as server

HASH = 'a' * 64
ORIGIN = 'bench.example'


@pytest.mark.parametrize('body', [
    '<html data-dpl-id="dpl_one"><script src="/_next/static/a.js?dpl=dpl_one"></script>',
    '<link href="/_next/static/a.css?dpl=dpl_one" rel="stylesheet">',
])
def test_reads_native_deployment_identity(body):
    assert server.parse(body) == 'dpl_one'


@pytest.mark.parametrize('body', [
    'dpl_one', '<script>const text="dpl_one";</script>',
    '<script src="https://other.example/_next/static/a.js?dpl=dpl_one"></script>',
    '<html data-dpl-id="dpl_one"><script src="/_next/static/a.js?dpl=dpl_two"></script>',
    '<html data-dpl-id="../private">', '<html data-dpl-id="">',
])
def test_missing_foreign_conflicting_or_malformed_identity_refuses(body):
    with pytest.raises(server.ServerError):
        server.parse(body)


def test_change_is_sticky_across_continuations(tmp_path):
    server.observe(tmp_path, ORIGIN, HASH, lambda _: 'dpl_one')
    server.observe(tmp_path, ORIGIN, HASH, lambda _: 'dpl_one')
    with pytest.raises(server.ServerError, match='changed'):
        server.observe(tmp_path, ORIGIN, HASH, lambda _: 'dpl_two')
    evidence = server.read(tmp_path)
    assert evidence['deployment_id'] == 'dpl_one'
    assert evidence['observed_id'] == 'dpl_two'
    assert evidence['checks'] == 3
    with pytest.raises(server.ServerError, match='changed'):
        server.observe(tmp_path, ORIGIN, HASH, lambda _: pytest.fail('must not adopt a replacement server'))
    assert server.read(tmp_path) == evidence


def test_failed_observation_is_retained_without_raw_error(tmp_path):
    def unavailable(_):
        raise OSError('private transport diagnostics')
    with pytest.raises(server.ServerError):
        server.observe(tmp_path, ORIGIN, HASH, unavailable)
    assert server.read(tmp_path)['status'] == 'unavailable'
    assert 'private' not in (tmp_path / server.FILE).read_text()


def test_records_without_server_evidence_cannot_silently_start_new_observations(tmp_path):
    (tmp_path / 'records').mkdir()
    (tmp_path / 'records' / 'old.json').write_text('{}')
    with pytest.raises(server.ServerError, match='evidence_missing'):
        server.observe(tmp_path, ORIGIN, HASH, lambda _: pytest.fail('must not probe a new baseline'))


def test_foreign_run_or_origin_cannot_reuse_evidence(tmp_path):
    server.observe(tmp_path, ORIGIN, HASH, lambda _: 'dpl_one')
    for origin, identity in [('other.example', HASH), (ORIGIN, 'b' * 64)]:
        with pytest.raises(server.ServerError, match='evidence_mismatch'):
            server.observe(tmp_path, origin, identity, lambda _: 'dpl_one')


def test_malformed_persisted_state_refuses(tmp_path):
    (tmp_path / server.FILE).write_text(json.dumps({'status': 'stable'}))
    with pytest.raises(server.ServerError, match='evidence_unreadable'):
        server.read(tmp_path)
