"""Bench-2 local-reuse experiment selections over the shared Bench-1 library."""
from . import FIXTURES

REAL_MANIFEST = FIXTURES / "live" / "real-manifest.json"
LOCAL_ARMS_MANIFEST = FIXTURES / "live" / "local-arms-manifest.json"
CANARY_MANIFEST = FIXTURES / "live" / "canary-manifest.json"
HIGH_DISCOVERY_MANIFEST = FIXTURES / "live" / "high-discovery-manifest.json"
CORPUS_MANIFEST = FIXTURES / "live" / "corpus-manifest.json"
SLICE_MANIFESTS = {"recursive": FIXTURES / "live" / "recursive-manifest.json"}
MANIFESTS = (REAL_MANIFEST, LOCAL_ARMS_MANIFEST, CANARY_MANIFEST, HIGH_DISCOVERY_MANIFEST, CORPUS_MANIFEST, *SLICE_MANIFESTS.values())
