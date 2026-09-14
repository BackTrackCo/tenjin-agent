"""Bench-2 local-reuse experiment selections over the shared Bench-1 library."""
from __future__ import annotations

import json
import re

from . import FIXTURES
from .manifest import Manifest

REAL_MANIFEST = FIXTURES / "live" / "real-manifest.json"
LOCAL_ARMS_MANIFEST = FIXTURES / "live" / "local-arms-manifest.json"
CANARY_MANIFEST = FIXTURES / "live" / "canary-manifest.json"
HIGH_DISCOVERY_MANIFEST = FIXTURES / "live" / "high-discovery-selection.json"
CORPUS_MANIFEST = FIXTURES / "live" / "corpus-selection.json"
SLICE_MANIFESTS = {"recursive": FIXTURES / "live" / "recursive-manifest.json"}
MANIFESTS = (REAL_MANIFEST, LOCAL_ARMS_MANIFEST, CANARY_MANIFEST, HIGH_DISCOVERY_MANIFEST, CORPUS_MANIFEST, *SLICE_MANIFESTS.values())

# Same tasks and treatments, with a separately reported native CLI/model stratum.
CODEX_MANIFESTS = tuple(FIXTURES / "live" / name for name in (
    "codex-preflight-selection.json", "codex-core-selection.json", "codex-recursive-selection.json"))
MANIFESTS = (*MANIFESTS, *CODEX_MANIFESTS)

CATALOG = FIXTURES / "live" / "catalog.json"
# How the hidden oracle enters a fixture: a source path, or the workspace
# package specifier a consumer imports. A prompt that names every one of them
# cannot fail a correct change on the agent's choice of name.
CONTRACT = re.compile(r"@[\w.-]+/[\w.-]+|[\w.-]+(?:/[\w.-]+)*\.(?:mjs|cjs|js|ts|tsx|json)")


def catalog_prompts() -> dict[str, str]:
    """The shared corpus's own prompt per task id, which is where a task's interface contract is stated."""
    return {task["id"]: task["prompt"] for task in json.loads(CATALOG.read_text(encoding="utf-8"))["tasks"]}


def interface_contract(prompt: str) -> set[str]:
    return set(CONTRACT.findall(prompt))


def prompt_violations(manifest: Manifest) -> list[str]:
    """Where an experiment would measure a prompt that drops the corpus's contract.

    The catalog states each task's interface contract, an experiment copies that
    prompt into its manifest, and a slice restates it around its own variation,
    so the rule both shapes keep is that every path the catalog names is named
    again: those are the paths the hidden oracle enters the fixture through, and
    a prompt that left one unsaid fails a correct change on the agent's choice of
    name. The comparison is one-way on purpose. A manifest that states more than
    the catalog is a tightening on its way through the stack and is safe to run;
    a manifest that states less is the underspecified prompt itself.
    """
    catalog = catalog_prompts()
    violations = []
    for task in manifest.tasks:
        stated = catalog.get(task["id"])
        if stated is None:
            violations.append(f"task {task['id']} carries a prompt the shared catalog does not define")
        elif missing := sorted(interface_contract(stated) - interface_contract(task["prompt"])):
            violations.append(f"task {task['id']} drops {', '.join(missing)} from the catalog's interface contract")
    return violations


# An arm that installs no product is a baseline: it starts no loop daemon and
# reads no shelf, so two of them may overlap.
BASELINE_PRODUCT = "none"
DATABASE = "postgres"


def concurrency_violations(manifest: Manifest) -> list[str]:
    """Why an experiment's declared `pins.concurrency` is more than it may use.

    Only baseline may parallelize. A reuse-condition arm installs the product,
    runs its daemon and searches the one shelf this account owns, so two
    overlapping reuse trials answer each other's searches and put two installs
    on one host. `runner.seeds_shelf` is the gate that already admits one of
    them at a time and it reads `provision`, so the rule here is that a reuse
    arm declares one and is covered, rather than a second mechanism beside it.

    A database-backed task is the same rule for the same reason: its pair holds
    the one Docker daemon the host has, and concurrent pairs stall on it, so an
    experiment that selects one runs a single worker whatever its arms are.
    """
    if manifest.concurrency == 1:
        return []
    violations = [f"arm {arm['id']} is a reuse condition without `provision`, so nothing keeps two of it apart"
                  for arm in manifest.arms if arm["product_version"] != BASELINE_PRODUCT and not arm.get("provision")]
    violations += [f"task {task['id']} is database-backed, so the experiment runs one worker"
                   for task in manifest.image_tasks if task.get("database") == DATABASE]
    return violations
