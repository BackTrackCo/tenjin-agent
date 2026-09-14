"""Historical experiment seams preserve isolation and task/knowledge identity."""
import copy
import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from evals.benchmark import cli, container, manifest, sha256_dir, sha256_file, task_assets, verifier


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
    support = tmp_path / 'verification'; support.mkdir()
    (support/'vitest.config.mjs').write_text("export default { test: { include: ['" + task_assets.ORACLE + "'] } };\n")
    (support/'database.mjs').write_text('// controlled support\n')
    receipt = {'task': task['id'], 'revision': 'before', 'commit': 'a'*40, 'tree': 'b'*40,
               'source_hash': 'c'*64, 'lock_sha256': 'd'*64, 'oracle_sha256': sha256_file(hidden/'benchmark-independent.test.ts'), 'catalog_sha256': 'e'*64, 'task_sha256': 'f'*64}
    (support/'source-receipt.json').write_text(json.dumps(receipt))
    task['verification'] = {'path': 'verification', 'hash': 'sha256:'+sha256_dir(support)}
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
    from evals.benchmark import claude_live
    # Both live adapters validate this exact contract before overlay delivery.
    assert claude_live.settings_of(actual, {'permission_mode': 'dontAsk'}) == actual['settings']
    assert actual['settings_hash'] != arm['settings_hash']
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
    for name in ("dist", ".next", ".pnpm-store", "node_modules"):
        (repo/name).mkdir()
        (repo/name/'generated.js').write_text('throw new Error("must never run")')
    (repo/'tsconfig.tsbuildinfo').write_text('cache')
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
    assert ['tar','-C','/benchmark-verify','--no-wildcards','--exclude=./.next','--exclude=./.pnpm-store','--exclude=./dist','--exclude=./node_modules','--exclude=./tsconfig.tsbuildinfo','-cf','/tmp/historical-source.tar','.'] in seen
    assert seen[0].egress.mode==container.NO_NETWORK and not seen[0].forward
    support_mount = seen[0].plan[1]
    assert support_mount.host.is_relative_to(base/'run')
    assert support_mount.host.read_bytes() == (spec.support/'vitest.config.mjs').read_bytes()
    diagnostics = list((base/'run/verification-containers').glob('*/diagnostic.json'))
    assert len(diagnostics) == 1
    assert json.loads(diagnostics[0].read_text())['assertions']['numFailedTests'] == 1
    # Changed oracle is measurement corruption, not an accepted assertion pass.
    (repo/task_assets.ORACLE).write_text('forged')
    assert verifier.run(spec,repo,base/'run',image='sha256:'+'ab'*32).outcome=='invalid'


def test_unrequested_source_or_tooling_edit_fails_contract(historical):
    data,base=historical;loaded=config(data,base);spec=loaded.verifier_spec(data['tasks'][0])
    repo=base/'run/verify';shutil.copytree(base/'fixture',repo)
    (repo/'src/product.ts').write_text('fixed')
    assert task_assets.changed_outside_contract(spec,repo) is None
    cache = repo/'.pnpm-store/v11'; cache.mkdir(parents=True)
    (cache/'index.db').write_bytes(b'package-manager-generated cache')
    (repo/'tsconfig.tsbuildinfo').write_text('compiler-generated cache')
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


@pytest.mark.parametrize("path", ["src/product.test.ts", "src/other.spec.mjs", "src/__tests__/case.ts", "src/fixtures/data.json", "src/lib/read-test-utils.ts", "src/package.json", "src/vitest.config.mjs", "src/.env", "src/benchmark-independent.test.ts"])
def test_broad_product_root_keeps_tests_and_tooling_protected(historical, path):
    data, base = historical
    data['tasks'][0]['allowed_changes'] = ['src/']
    original = base / 'fixture' / path
    original.parent.mkdir(parents=True, exist_ok=True)
    original.write_text('trusted')
    data['tasks'][0]['fixture_hash'] = manifest.fixture_hash(base/'fixture')
    spec = config(data,base).verifier_spec(data['tasks'][0])
    repo = base/'run/verify'
    shutil.copytree(base/'fixture',repo)
    (repo/path).write_text('forged')
    assert task_assets.changed_outside_contract(spec,repo) == 'changed file outside allowed source paths'
    original.unlink()
    assert task_assets.changed_outside_contract(spec,repo) == ('added file outside allowed source paths' if path != task_assets.ORACLE else None)


def test_broad_product_root_permits_localization_and_new_source_helpers(historical):
    data, base = historical
    data['tasks'][0]['allowed_changes'] = ['src/']
    spec = config(data,base).verifier_spec(data['tasks'][0])
    repo = base/'run/verify'
    shutil.copytree(base/'fixture',repo)
    (repo/'src/product.ts').write_text('fixed')
    (repo/'src/helper.ts').write_text('new implementation helper')
    assert task_assets.changed_outside_contract(spec,repo) is None
    (repo/'src-neighbor').mkdir()
    (repo/'src-neighbor/product.ts').write_text('outside source root')
    assert task_assets.changed_outside_contract(spec,repo) == 'added file outside allowed source paths'


@pytest.mark.parametrize('file', ['vitest.config.mjs', 'database.mjs', 'source-receipt.json'])
def test_verifier_support_and_provenance_drift_refuse_before_launch(historical, file):
    data, base = historical
    loaded = config(data, base)
    source = task_assets.source_facts(loaded, data['tasks'][0])
    assert source['commit'] == 'a'*40
    assert source['verification_hash'] == data['tasks'][0]['verification']['hash']
    spec = loaded.verifier_spec(data['tasks'][0])
    assert spec.support == base/'verification'
    (base/'verification'/file).write_text('changed')
    with pytest.raises(manifest.ManifestError, match='hash'):
        config(data, base)


@pytest.mark.parametrize('config_text', [
    pytest.param("export default { test: { include: ['src/**/*.test.ts'] } };\n", id='whole suite'),
    pytest.param('export default { test: { testTimeout: 15000 } };\n', id='no include list'),
    pytest.param("export default { test: { projects: [{ test: { include: ['src/benchmark-independent.test.ts'] } }] } };\n", id='projects reopen it'),
])
def test_an_oracle_that_does_not_name_its_one_test_file_is_refused_before_launch(historical, config_text):
    # A bare suite costs a worker per core and every service it boots, inside
    # the trial image, so the refusal belongs where the manifest is read.
    data, base = historical
    path = base/'verification/vitest.config.mjs'
    path.write_text(config_text)
    data['tasks'][0]['verification']['hash'] = 'sha256:'+sha256_dir(path.parent)
    with pytest.raises(manifest.ManifestError, match='verifier configuration'):
        config(data, base)


def test_provenance_cannot_name_another_oracle_even_with_new_support_hash(historical):
    data, base = historical
    path = base/'verification/source-receipt.json'
    receipt = json.loads(path.read_text()); receipt['oracle_sha256'] = '0'*64; path.write_text(json.dumps(receipt))
    data['tasks'][0]['verification']['hash'] = 'sha256:'+sha256_dir(path.parent)
    with pytest.raises(manifest.ManifestError, match='different oracle'):
        config(data, base)


def test_database_model_support_is_visible_bound_and_separate_from_oracle(historical, monkeypatch):
    from evals.benchmark import historical as preparation
    data, base = historical
    context = base / 'context'; context.mkdir()
    shutil.copytree(base / 'fixture', context / 'source')
    shutil.copyfile(base / 'hidden' / task_assets.ORACLE, context / 'oracle.test.ts')
    for name in ('vitest.config.mjs', 'database.mjs'):
        shutil.copyfile(base / 'verification' / name, context / name)
    receipt = json.loads((base / 'verification/source-receipt.json').read_text())
    source = {**data['tasks'][0], 'database': 'postgres', 'prompt': 'Implement the historical contract.'}
    monkeypatch.setattr(preparation, 'validate_context', lambda *args, **kwargs: receipt)
    monkeypatch.setattr(preparation, 'task_named', lambda *args: source)
    out = base / 'admitted'
    task = task_assets.materialize(context, out, catalog=base / 'catalog.json')
    visible = out / 'fixture/.bench1'
    assert {p.name for p in visible.iterdir()} == {'model-tests.config.mjs', 'model-test-database.mjs'}
    assert not (out / 'fixture' / task_assets.ORACLE).exists()
    assert (out / 'hidden' / task_assets.ORACLE).read_text() == (context / 'oracle.test.ts').read_text()
    assert task['fixture_hash'] == manifest.fixture_hash(out / 'fixture')
    data['tasks'] = [task]
    loaded = config(data, base)
    spec = loaded.verifier_spec(task)
    repo = base / 'submitted'; shutil.copytree(out / 'fixture', repo)
    (repo / '.bench1/model-test-database.mjs').write_text('forged helper')
    assert task_assets.changed_outside_contract(spec, repo) == 'changed file outside allowed source paths'
    (visible / 'model-tests.config.mjs').write_text('different model environment')
    with pytest.raises(manifest.ManifestError, match='hash'):
        config(data, base)


@pytest.mark.parametrize("path", ["dist/generated.js", ".next/server/generated.js", "build/index.js", "out/index.html", "coverage/index.html", "storybook-static/index.html", ".eslintcache", ".prettiercache", "vitest-report.json", "custom.tsbuildinfo", "npm-debug.log", "package-1.0.tgz"])
def test_generated_outputs_do_not_expand_source_permissions(historical, path):
    data, base = historical
    spec = config(data, base).verifier_spec(data['tasks'][0])
    repo = base/'run/verify'
    shutil.copytree(base/'fixture', repo)
    output = repo/path
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('disposable output')
    assert task_assets.changed_outside_contract(spec, repo) is None
    # A build artifact cannot excuse a protected test/config edit.
    original = base/'fixture/vitest.config.mjs'
    original.write_text('trusted')
    (repo/original.name).write_text('forged')
    assert task_assets.changed_outside_contract(spec, repo) == 'changed file outside allowed source paths'


def test_generated_roots_cannot_hide_original_fixture_source(historical):
    data, base = historical
    (base/'fixture/dist').mkdir()
    (base/'fixture/dist/checked-in.js').write_text('tracked source')
    data['tasks'][0]['fixture_hash'] = manifest.fixture_hash(base/'fixture')
    with pytest.raises(manifest.ManifestError, match='reserved generated outputs'):
        config(data, base)


def test_submitted_ignore_rules_cannot_expand_permissions(historical):
    data, base = historical
    spec = config(data, base).verifier_spec(data['tasks'][0])
    repo = base/'run/verify'
    shutil.copytree(base/'fixture', repo)
    (repo/'.gitignore').write_text('unexpected.ts\n')
    (repo/'unexpected.ts').write_text('shadow source')
    assert task_assets.changed_outside_contract(spec, repo) == 'added file outside allowed source paths'
