"""Reusable framework smoke configurations. Experiment selections live separately."""
from . import FIXTURES

SMOKE_MANIFEST = FIXTURES / "live" / "smoke-manifest.json"
HOOKS_SMOKE_MANIFEST = FIXTURES / "live" / "hooks-smoke-manifest.json"
KEYS_SMOKE_MANIFEST = FIXTURES / "live" / "keys-smoke-manifest.json"
MANIFESTS = (SMOKE_MANIFEST, HOOKS_SMOKE_MANIFEST, KEYS_SMOKE_MANIFEST)
