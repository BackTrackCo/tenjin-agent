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
            return b'{"workflow_id": 5}'
        if route.startswith('actions/workflows/'):
            runs = [dict(id=i, created_at=f'2026-09-{i:02}', head_branch='main', event='schedule', status='completed',
                         head_repository={'full_name': repo}, head_sha=str(i), html_url=f'https://github.com/org/repo/actions/runs/{i}') for i in (1, 2, 3, 4)]
            runs[-1]['event'] = 'pull_request'
            return json.dumps({'workflow_runs': runs}).encode()
        if '/artifacts?' in route:
            i = int(route.split('/')[2])
            return json.dumps({'artifacts': [{'id': i, 'name': 'lane-records', 'expired': False}]}).encode()
        i = int(route.split('/')[2])
        return zipped({'manifest_hash': 'different' if i == 3 else 'same', 'invalid': [{}]})
    report, source = main_regression.latest_main({'manifest_hash': 'same'}, 'org/repo', '99', 'lane-records', fetch)
    assert source['run_id'] == 2
    assert report['invalid']
    assert not any('/runs/1/' in call or '/runs/4/' in call for call in calls)


def test_no_artifact_never_launches_a_baseline_or_calls_it_clean():
    def fetch(repo, route):
        return b'{"workflow_id": 5}' if route == 'actions/runs/99' else b'{"workflow_runs": []}'
    assert main_regression.latest_main({}, 'org/repo', '99', 'lane', fetch) is None
    text = main_regression.render({'status': 'unavailable', 'reason': 'No matching main report'})
    assert 'unavailable' in text
    assert 'clean' not in text
