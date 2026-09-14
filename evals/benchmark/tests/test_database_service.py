import json
from types import SimpleNamespace

import pytest
from evals.benchmark import container, database_service, images


def fake(mode='none', ready=True, remove=True):
    calls=[]
    def docker(argv,timeout_s=0):
        calls.append(argv)
        code=0;output=''
        if argv[0]=='ps': output='verifier-id\n'
        elif argv[0]=='inspect': output=json.dumps([{'HostConfig':{'NetworkMode':mode}}])
        elif argv[0]=='run': output='database-id\n'
        elif argv[0]=='exec' and not ready: code=1
        elif argv[0]=='rm' and not remove: code=1
        if argv[:4]==['ps','--all','--format','{{.Names}}']: output='bench-fixture-postgres\n'
        return SimpleNamespace(returncode=code,stdout=output,stderr='')
    return calls,docker


def running(mode=None,forward=()):
    return SimpleNamespace(recipe=SimpleNamespace(name='bench-fixture',egress=mode or container.no_network(),forward=forward))


def test_db_shares_only_verified_none_namespace_and_cleans_up():
    calls,docker=fake()
    with database_service.service(running(),True,docker=docker) as env:
        assert env==database_service.ENVIRONMENT
        argv=next(call for call in calls if call[0]=='run')
        assert argv[argv.index('--network')+1]=='container:verifier-id'
        assert database_service.IMAGE in argv
        assert not set(argv)&{'--publish','-p','--volume','-v','--privileged','--mount'}
        assert '--read-only' in argv and '--tmpfs' in argv
        # The collation the ordering assertions were written under. An image
        # whose initdb locale differs silently reorders them.
        assert 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8' in argv
    assert calls[-1]==['rm','--force','bench-fixture-postgres']


@pytest.mark.parametrize('mode',['host','bridge','container:other'])
def test_actual_nonisolated_network_refuses_even_if_recipe_claims_none(mode):
    calls,docker=fake(mode=mode)
    with pytest.raises(ValueError,match='not isolated'):
        with database_service.service(running(),True,docker=docker): pass
    assert not any(call[0]=='run' for call in calls)


def test_credentials_refuse_before_docker_and_disabled_service_does_nothing():
    calls,docker=fake()
    with pytest.raises(ValueError,match='credential-free'):
        with database_service.service(running(forward=('MODEL_SECRET',)),True,docker=docker): pass
    with database_service.service(None,False,docker=docker) as env: assert env=={}
    assert calls==[]


def test_readiness_failure_cleans_up_and_cleanup_failure_is_explicit():
    calls,docker=fake(ready=False)
    times=iter([0,31])
    with pytest.raises(ValueError,match='ready'):
        with database_service.service(running(),True,docker=docker,clock=lambda:next(times)): pass
    assert calls[-1][0]=='rm'
    _,docker=fake(remove=False)
    with pytest.raises(images.ImageError,match='remains'):
        with database_service.service(running(),True,docker=docker): pass


def test_harbor_owned_deny_all_sidecar_is_accepted_but_foreign_sidecar_is_not():
    for owner in ('bench-fixture','another-project'):
        calls,base=fake(mode='container:sidecar-id')
        def docker(argv,timeout_s=0):
            if argv==['inspect','sidecar-id']:
                return SimpleNamespace(returncode=0,stderr='',stdout=json.dumps([{'Config':{'Labels':{
                    container.COMPOSE_PROJECT_LABEL:owner,
                    'com.docker.compose.service':'harbor-docker-egress-control-sidecar'},
                    'Env':['EGRESS_CONTROL_INITIAL_NETWORK_MODE=no-network']}}]))
            return base(argv,timeout_s)
        if owner=='bench-fixture':
            with database_service.service(running(),True,docker=docker): pass
        else:
            with pytest.raises(ValueError,match='not isolated'):
                with database_service.service(running(),True,docker=docker): pass


@pytest.mark.parametrize('mode,owner,accepted', [
    ('allowlist', 'bench-fixture', True),
    ('public', 'bench-fixture', False),
    ('no-network', 'bench-fixture', False),
    ('allowlist', 'foreign-project', False),
])
def test_model_service_requires_its_owned_allowlist_sidecar(mode, owner, accepted):
    calls, base = fake(mode='container:sidecar-id')
    def docker(argv, timeout_s=0):
        if argv == ['inspect', 'sidecar-id']:
            return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps([{'Config': {
                'Labels': {container.COMPOSE_PROJECT_LABEL: owner, 'com.docker.compose.service': 'harbor-docker-egress-control-sidecar'},
                'Env': ['EGRESS_CONTROL_INITIAL_NETWORK_MODE=' + mode],
            }}]))
        return base(argv, timeout_s)
    model = running(container.plan_egress(('chatgpt.com',)), forward=('MODEL_SECRET',))
    if accepted:
        with database_service.model_service(model, True, docker=docker) as env:
            assert env == database_service.ENVIRONMENT and 'MODEL_SECRET' not in env
            argv = next(call for call in calls if call[0] == 'run')
            assert not set(argv) & {'--publish', '-p', '--mount', '--privileged'}
            assert argv[-1] == 'listen_addresses=127.0.0.1'
        assert calls[-1][0] == 'rm'
    else:
        with pytest.raises(ValueError, match='not isolated'):
            with database_service.model_service(model, True, docker=docker): pass
        assert not any(call[0] == 'run' for call in calls)


@pytest.mark.parametrize('mode', ['none', 'host', 'bridge'])
def test_model_service_rejects_non_sidecar_network(mode):
    calls, docker = fake(mode=mode)
    with pytest.raises(ValueError, match='not isolated'):
        with database_service.model_service(running(container.plan_egress(('chatgpt.com',))), True, docker=docker): pass
    assert not any(call[0] == 'run' for call in calls)


def test_model_launch_failure_tears_down_database():
    calls, base = fake(mode='container:sidecar-id')
    def docker(argv, timeout_s=0):
        if argv == ['inspect', 'sidecar-id']:
            return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps([{'Config': {
                'Labels': {container.COMPOSE_PROJECT_LABEL: 'bench-fixture', 'com.docker.compose.service': 'harbor-docker-egress-control-sidecar'},
                'Env': ['EGRESS_CONTROL_INITIAL_NETWORK_MODE=allowlist'],
            }}]))
        return base(argv, timeout_s)
    with pytest.raises(RuntimeError, match='model launch failed'):
        with database_service.model_service(running(container.plan_egress(('chatgpt.com',))), True, docker=docker):
            raise RuntimeError('model launch failed')
    assert calls[-1] == ['rm', '--force', 'bench-fixture-postgres']
