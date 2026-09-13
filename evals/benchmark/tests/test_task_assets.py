"""Historical experiment seams preserve isolation and task/knowledge identity."""
import copy
import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from evals.benchmark import cli, container, manifest, sha256_dir, task_assets, verifier


@pytest.fixture
def historical(tmp_path):
    data = json.loads(cli.FAKE_MANIFEST.read_text())
    task = data['tasks'][0]
    fixture = tmp_path / 'fixture'
    shutil.copytree(cli.FAKE_MANIFEST.parent / task['fixture'], fixture)
    (fixture / 'src').mkdir(exist_ok=True)
    (fixture / 'src/product.ts').write_text('export const value = 1;\n')
    hidden = tmp_path / 'hidden' / 'src'
    hidden.mkdir(parents=True)
    (hidden / 'benchmark-independent.test.ts').write_text('// independently controlled oracle\n')
    task.update(fixture='fixture', fixture_hash=manifest.fixture_hash(fixture), verifier='historical_vitest',
                hidden={'path':'hidden', 'hash':'sha256:'+sha256_dir(hidden.parent)}, allowed_changes=['src/product.ts'])
    data['tasks'] = [task]
    return data, tmp_path


def config(data, base):
    manifest.validate(data, base)
    return manifest.Manifest(data, base / 'manifest.json', 'test')


def test_prior_fixture_is_hashed_and_built_but_not_a_scheduled_consumer(historical):
    data, base = historical
    prior = copy.deepcopy(data['tasks'][0]); prior['id']='prior'
    shutil.copytree(base/'fixture', base/'prior')
    prior['fixture']='prior'
    data['tasks'][0]['producer_task']=prior
    loaded=config(data,base)
    assert [t['id'] for t in loaded.image_tasks] == [data['tasks'][0]['id'],'prior']
    assert len(loaded.tasks)==1
    (base/'prior/src/product.ts').write_text('changed')
    with pytest.raises(manifest.ManifestError,match='hash'):
        config(data,base)


def test_hidden_body_drift_or_model_visible_assets_refuse_before_launch(historical):
    data,base=historical
    config(data,base)
    (base/'hidden/src/benchmark-independent.test.ts').write_text('changed')
    with pytest.raises(manifest.ManifestError,match='hash'):
        config(data,base)
    data['tasks'][0]['hidden']={'path':'fixture','hash':data['tasks'][0]['fixture_hash']}
    with pytest.raises(manifest.ManifestError,match='outside'):
        config(data,base)


def test_hidden_assets_cannot_follow_links_to_host_files(historical):
    data,base=historical
    (base/'hidden/linked').symlink_to(base/'fixture/src/product.ts')
    with pytest.raises(manifest.ManifestError,match='links'):
        config(data,base)


def test_flat_knowledge_uses_exact_bound_seed_bodies(historical):
    data,base=historical
    knowledge=base/'knowledge';knowledge.mkdir()
    body='# Earlier fact\n\nA fact that predates the task.\n'
    (knowledge/'prior.md').write_text(body)
    (knowledge/'prior.json').write_text(json.dumps({'id':'prior','title':'Earlier fact','commands':[]}))
    task=data['tasks'][0]
    task['knowledge']={'path':'knowledge','hash':'sha256:'+sha256_dir(knowledge),'lessons':['prior'],'background':[]}
    arm=data['arms'][0];arm['flat_knowledge']=True
    loaded=config(data,base)
    actual=loaded.trial_arm(task,arm)
    assert actual['settings']['overlay']['LESSONS.md']==body
    assert 'LESSONS.md' in actual['settings']['overlay']['AGENTS.md']
    assert 'overlay' not in arm.get('settings',{})
    receipt = task_assets.knowledge_facts(loaded, task, arm)
    assert receipt['available'] == ['prior']
    assert receipt['corpus_hash'] == task['knowledge']['hash']
    assert task_assets.knowledge_facts(loaded, task, {})['available'] == []
    assert receipt['body_hashes']['prior'].startswith('sha256:')
    (knowledge/'prior.md').write_text(body+'later solution')
    with pytest.raises(manifest.ManifestError,match='hash'):
        config(data,base)


def test_hidden_verifier_replaces_model_tooling_and_classifies_assertions(historical,monkeypatch):
    data,base=historical;loaded=config(data,base);spec=loaded.verifier_spec(data['tasks'][0])
    repo=base/'run/verify';shutil.copytree(base/'fixture',repo);shutil.copytree(spec.hidden_layer,repo,dirs_exist_ok=True)
    seen=[]
    class Running:
        def __init__(self,recipe): seen.append(recipe)
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def exec(self,argv,**kwargs):
            seen.append(argv)
            output=json.dumps({'numTotalTests':2,'numPassedTests':1,'numFailedTests':1,'success':False,'testResults':[{'assertionResults':[{'status':'passed'},{'status':'failed'}]}]}) if argv[0]=='cat' else ''
            return SimpleNamespace(returncode=1 if argv[0]=='node' else 0,stdout=output,stderr='')
    monkeypatch.setattr(container,'Container',Running)
    monkeypatch.setattr(container,'remove_project',lambda _:True)
    result=verifier.run(spec,repo,base/'run',image='sha256:'+'ab'*32)
    assert result.outcome=='fail'
    assert ['ln','-s','/opt/fixture/node_modules','/tmp/historical-task/node_modules'] in seen
    assert seen[0].egress.mode==container.NO_NETWORK and not seen[0].forward
    # Changed oracle is measurement corruption, not an accepted assertion pass.
    (repo/task_assets.ORACLE).write_text('forged')
    assert verifier.run(spec,repo,base/'run',image='sha256:'+'ab'*32).outcome=='invalid'


def test_unrequested_source_or_tooling_edit_fails_contract(historical):
    data,base=historical;loaded=config(data,base);spec=loaded.verifier_spec(data['tasks'][0])
    repo=base/'run/verify';shutil.copytree(base/'fixture',repo)
    (repo/'src/product.ts').write_text('fixed')
    assert task_assets.changed_outside_contract(spec,repo) is None
    (repo/'unexpected.ts').write_text('shadow dependency')
    assert 'added file' in task_assets.changed_outside_contract(spec,repo)


def test_linked_source_parent_is_refused_before_reading_its_files(historical):
    data, base = historical
    loaded = config(data, base)
    spec = loaded.verifier_spec(data['tasks'][0])
    repo = base / 'run/verify'
    shutil.copytree(base / 'fixture', repo)
    shutil.rmtree(repo / 'src')
    (repo / 'src').symlink_to(base / 'fixture/src', target_is_directory=True)
    assert task_assets.changed_outside_contract(spec, repo) == 'submitted source contains a symlink'
