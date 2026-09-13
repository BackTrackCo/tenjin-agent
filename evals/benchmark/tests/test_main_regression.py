"""Artifact lookup selects main evidence, never a PR or an older healthier match."""
import io
import json
import zipfile

from evals.benchmark import main_regression


def zipped(report):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("report.json", json.dumps(report))
    return stream.getvalue()


def test_latest_matching_main_and_invalid_latest_are_not_skipped():
    calls = []
    def fetch(repo, route):
        calls.append(route)
        if route == 'actions/runs/99':
            return b'{"workflow_id": 5, "created_at": "2026-09-05T00:00:00Z"}'
        if route.startswith('actions/workflows/'):
            runs = [dict(id=i, workflow_id=5, created_at=f'2026-09-{i:02}T00:00:00Z', updated_at=f'2026-09-{i:02}T01:00:00Z', head_branch='main', event='schedule', status='completed',
                         head_repository={'full_name': repo}, head_sha=str(i), html_url=f'https://github.com/org/repo/actions/runs/{i}') for i in (1, 2, 3, 4, 5, 6, 7)]
            runs[3]['event'] = 'pull_request'
            runs[4]['head_repository'] = {'full_name': 'fork/repo'}
            runs[5]['updated_at'] = '2026-09-07T00:00:00Z'
            runs[6]['workflow_id'] = 6
            return json.dumps({'workflow_runs': runs}).encode()
        if '/artifacts?' in route:
            i = int(route.split('/')[2])
            return json.dumps({'artifacts': [{'id': i, 'name': 'lane-records', 'expired': False}]}).encode()
        i = int(route.split('/')[2])
        return zipped({'regression_protocol_hash': 'different' if i == 3 else 'same', 'invalid': [{}]})
    report, source = main_regression.latest_main({'regression_protocol_hash': 'same'}, 'org/repo', '99', 'lane-records', fetch)
    assert source['run_id'] == 2
    assert report['invalid']
    assert not any(f'/runs/{i}/' in call for i in (1, 4, 5, 6, 7) for call in calls)
    assert source['age_hours_at_run_start'] == 71
    assert len(source['report_hash']) == 64


def test_no_artifact_never_launches_a_baseline_or_calls_it_clean():
    def fetch(repo, route):
        return b'{"workflow_id": 5, "created_at": "2026-09-05T00:00:00Z"}' if route == 'actions/runs/99' else b'{"workflow_runs": []}'
    assert main_regression.latest_main({}, 'org/repo', '99', 'lane', fetch) is None
    text = main_regression.render({'status': 'unavailable', 'reason': 'No matching main report'})
    assert 'unavailable' in text
    assert 'clean' not in text


def test_update_lookup_uses_latest_protocol_match_even_when_version_is_unchanged():
    def fetch(repo, route):
        if route == 'actions/runs/99':
            return b'{"workflow_id": 5, "created_at": "2026-09-05T00:00:00Z"}'
        if route.startswith('actions/workflows/'):
            return json.dumps({'workflow_runs': [dict(id=i, workflow_id=5, created_at=f'2026-09-0{i}T00:00:00Z', updated_at=f'2026-09-0{i}T01:00:00Z', head_branch='main', event='schedule', status='completed', head_repository={'full_name': repo}, head_sha=str(i), html_url='https://github.com/org/repo/actions/runs/' + str(i)) for i in (1, 2)]}).encode()
        if '/artifacts?' in route:
            return json.dumps({'artifacts': [{'id': int(route.split('/')[2]), 'name': 'lane', 'expired': False}]}).encode()
        return zipped({'harness_update_protocol_hash': 'same', 'regression_protocol_hash': 'old-version', 'run_configuration': {'harness_version': '2.0.0'}})
    current = {'harness_update_protocol_hash': 'same', 'regression_protocol_hash': 'new-version'}
    assert main_regression.latest_main(current, 'org/repo', '99', 'lane', fetch) is None
    previous, source = main_regression.latest_main(current, 'org/repo', '99', 'lane', fetch, harness_update=True)
    assert source['run_id'] == 2
    assert previous['run_configuration']['harness_version'] == '2.0.0'


def test_update_readout_names_both_versions_and_mixed_attribution():
    result = {'status': 'regressions found', 'harness_versions': {'main': '1.0.0', 'current': '2.0.0'},
              'attribution': 'mixed product/server identities', 'product_commits': {'main': ['a'], 'current': ['b']},
              'server_deployments': {'main': 'dpl_a', 'current': 'dpl_b'}}
    text = main_regression.render(result, harness_update=True)
    assert 'Harness update diagnostic' in text and '1.0.0' in text and '2.0.0' in text
    assert 'mixed product/server identities' in text and 'dpl_a' in text
