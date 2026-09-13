"""Disposable pgvector on a verifier's private, network-free loopback.

The controller owns Docker; no socket, host port, real credential or persistent
volume reaches source execution. The database shares the verifier's existing
NO_NETWORK namespace and its cleanup project label.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import time
from typing import Any, Iterator

from . import container, images

IMAGE = 'pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb'
ENVIRONMENT = {'BENCHMARK_DATABASE_URL': 'postgresql://postgres@127.0.0.1:5432/benchmark'}


def service(running: Any, enabled: bool, **kwargs):
    """Hidden verification: source gets no credentials or outside network."""
    return _service(running, enabled, model_session=False, **kwargs)


def model_service(running: Any, enabled: bool, **kwargs):
    """Live model tools: retain the existing provider/shelf allowlist unchanged."""
    return _service(running, enabled, model_session=True, **kwargs)


@contextmanager
def _service(running: Any, enabled: bool, *, model_session: bool, docker=None, clock=time.monotonic, sleep=time.sleep) -> Iterator[dict[str, str]]:
    if not enabled:
        yield {}
        return
    expected = container.ALLOWLIST if model_session else container.NO_NETWORK
    if running.recipe.egress.mode != expected or (not model_session and running.recipe.forward):
        raise ValueError('model database requires an owned allowlist' if model_session else 'benchmark database requires credential-free NO_NETWORK verification')
    call = images._docker(docker)
    project = container.compose_project(running.recipe.name)
    found = call(['ps', '--all', '--quiet', '--filter', f'label={container.COMPOSE_PROJECT_LABEL}={project}', '--filter', f'label=com.docker.compose.service={container.MAIN_SERVICE}'], 10)
    if found.returncode != 0:
        raise ValueError('cannot inspect owned verifier container')
    ids = found.stdout.split()
    if len(ids) != 1:
        raise ValueError('database attachment requires exactly one owned verifier container')
    inspected = call(['inspect', ids[0]], 10)
    facts = json.loads(inspected.stdout) if inspected.returncode == 0 else []
    if len(facts) != 1:
        raise ValueError('verifier network is not isolated')
    network = facts[0].get('HostConfig', {}).get('NetworkMode', '')
    if network.startswith('container:'):
        # Current Harbor implements NO_NETWORK through its own deny-all sidecar.
        inspected_sidecar = call(['inspect', network.split(':', 1)[1]], 10)
        sidecars = json.loads(inspected_sidecar.stdout) if inspected_sidecar.returncode == 0 else []
        config = sidecars[0].get('Config', {}) if len(sidecars) == 1 else {}
        labels = config.get('Labels', {})
        if labels.get(container.COMPOSE_PROJECT_LABEL) != project or labels.get('com.docker.compose.service') != 'harbor-docker-egress-control-sidecar' or f'EGRESS_CONTROL_INITIAL_NETWORK_MODE={expected}' not in config.get('Env', []):
            raise ValueError('verifier network is not isolated')
    elif model_session or network != 'none':
        raise ValueError('verifier network is not isolated')
    name = project + '-postgres'
    argv = ['run', '--detach', '--name', name, '--network', 'container:' + ids[0],
            '--label', f'{container.COMPOSE_PROJECT_LABEL}={project}', '--read-only',
            '--tmpfs', '/var/lib/postgresql/data:rw,size=1073741824',
            '--tmpfs', '/var/run/postgresql:rw', '--tmpfs', '/tmp:rw',
            '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_DB=benchmark',
            '--env', 'POSTGRES_INITDB_ARGS=--locale=C.UTF-8', IMAGE,
            'postgres', '-c', 'listen_addresses=127.0.0.1']
    try:
        if call(argv, 30).returncode != 0:
            raise ValueError('disposable benchmark database failed to start')
        end = clock() + 30
        while call(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'benchmark'], 5).returncode != 0:
            if clock() >= end:
                raise ValueError('disposable benchmark database did not become ready')
            sleep(0.2)
        yield dict(ENVIRONMENT)
    finally:
        removed = call(['rm', '--force', name], 15)
        if removed.returncode != 0:
            listing = call(['ps', '--all', '--format', '{{.Names}}', '--filter', f'label={container.COMPOSE_PROJECT_LABEL}={project}'], 10)
            if listing.returncode != 0 or name in listing.stdout.split():
                raise images.ImageError('cleanup_failed', 'disposable benchmark database remains or cannot be inspected')
