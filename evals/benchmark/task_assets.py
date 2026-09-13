"""Bound experiment assets for the shared runner; no manifest-supplied commands."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import re
from typing import Any

from . import sha256_dir, sha256_file, verifier

HISTORICAL = "historical_vitest"
ORACLE = "src/benchmark-independent.test.ts"
CONFIG = "hidden-tests/historical.config.mjs"


def may_change(relative: str, allowed: tuple[str, ...] | list[str]) -> bool:
    path = Path(relative)
    # Broader source roots avoid handing the model the reference patch's file
    # list. Their tests, fixtures and dependency/tooling configuration stay fixed.
    if (relative == ORACLE or any(part in {"tests", "__tests__", "fixtures", "__fixtures__", "_support", "node_modules", "hidden-tests"} for part in path.parts)
            or re.search(r"(?:\.(?:test|spec)\.|(?:^|-)test-utils\.)", path.name)
            or path.name in {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs"}
            or path.name.startswith(("tsconfig", "vitest.config", "vite.config", ".env"))):
        return False
    return any(relative == rule or (rule.endswith("/") and relative.startswith(rule)) for rule in allowed)


def confined(base: Path, relative: str) -> Path:
    target = (base / relative).resolve()
    if not target.is_relative_to(base.resolve()):
        raise ValueError("experiment asset escapes the manifest directory")
    if not target.is_dir() or any(p.is_symlink() for p in target.rglob("*")):
        raise ValueError("experiment asset must be a directory without links")
    return target


def validate(data: dict[str, Any], base: Path) -> None:
    from .manifest import ManifestError, fixture_hash
    try:
        for consumer in data["tasks"]:
            for task in (consumer, *([consumer["producer_task"]] if "producer_task" in consumer else [])):
                fixture = confined(base, task["fixture"])
                if fixture_hash(fixture) != task["fixture_hash"]:
                    raise ValueError("producer or consumer fixture hash differs")
                for key in ("hidden", "knowledge", "verification"):
                    if key not in task:
                        continue
                    asset = confined(base, task[key]["path"])
                    if asset.is_relative_to(fixture) or fixture.is_relative_to(asset):
                        raise ValueError("hidden/knowledge/verification assets must be outside the model fixture")
                    if "sha256:" + sha256_dir(asset) != task[key]["hash"]:
                        raise ValueError(f"{key} asset hash differs")
                if task["verifier"] == HISTORICAL:
                    if not task.get("hidden") or not task.get("verification") or not task.get("allowed_changes"):
                        raise ValueError("historical verifier needs hidden, verification assets and allowed changes")
                    hidden = confined(base, task["hidden"]["path"])
                    if not (hidden / ORACLE).is_file():
                        raise ValueError("historical behavioral oracle is missing")
                    support = confined(base, task["verification"]["path"])
                    source_facts_from(support)
                    receipt = json.loads((support / "source-receipt.json").read_text())
                    if receipt["oracle_sha256"] != sha256_file(hidden / ORACLE):
                        raise ValueError("historical source receipt names a different oracle")
                    if any(not (support / name).is_file() for name in ("vitest.config.mjs", "database.mjs")):
                        raise ValueError("historical verifier support is missing")
                    if any(not Path(path).parts or Path(path).is_absolute() or ".." in Path(path).parts or path.startswith(("node_modules/", "hidden-tests/")) or path == ORACLE or "*" in path for path in task["allowed_changes"]):
                        raise ValueError("allowed changes must name confined product source files")
                elif any(key in task for key in ("hidden", "verification", "allowed_changes", "database")):
                    raise ValueError("custom hidden assets require the historical verifier")
                if "knowledge" in task:
                    from .tenjin_arm import lesson_named
                    knowledge = task["knowledge"]
                    if not set(knowledge["background"]).issubset(knowledge["lessons"]):
                        raise ValueError("background knowledge must be a subset of the flat/seeded corpus")
                    for name in knowledge["lessons"]:
                        if lesson_named(name, confined(base, knowledge["path"])) is None:
                            raise ValueError("knowledge names a missing lesson")
        if any(arm.get("flat_knowledge") for arm in data["arms"]) and any("knowledge" not in t for t in data["tasks"]):
            raise ValueError("flat knowledge needs a bound corpus for every consumer")
    except (ValueError, OSError, KeyError) as error:
        raise ManifestError(str(error)) from error


def verifier_spec(manifest: Any, task: dict[str, Any]) -> verifier.VerifierSpec:
    if task["verifier"] != HISTORICAL:
        return verifier.lookup(task["verifier"])
    return verifier.VerifierSpec(
        name=HISTORICAL, argv=lambda repo: [], timeout_s=120,
        hidden_layer=manifest.asset_path(task["hidden"]), container_test=ORACLE,
        database=task.get("database") == "postgres",
        support=manifest.asset_path(task["verification"]), support_hash=task["verification"]["hash"],
        kind=HISTORICAL, fixture=manifest.fixture_path(task),
        allowed_changes=tuple(task["allowed_changes"]),
    )


def source_facts_from(support: Path) -> dict[str, Any]:
    receipt = json.loads((support / "source-receipt.json").read_text())
    fields = ("task", "revision", "commit", "tree", "source_hash", "lock_sha256", "oracle_sha256", "catalog_sha256", "task_sha256")
    facts = {key: receipt[key] for key in fields}
    if any(not isinstance(value, str) for value in facts.values()) or facts["revision"] != "before" or any(re.fullmatch(r"[0-9a-f]{40}", facts[key]) is None for key in ("commit", "tree")) or any(re.fullmatch(r"[0-9a-f]{64}", facts[key]) is None for key in fields[4:]):
        raise ValueError("historical source provenance is malformed or not a before revision")
    return facts


def source_facts(manifest: Any, task: dict[str, Any]) -> dict[str, Any] | None:
    if task["verifier"] != HISTORICAL:
        return None
    return {**source_facts_from(manifest.asset_path(task["verification"])), "verification_hash": task["verification"]["hash"]}


def trial_arm(manifest: Any, task: dict[str, Any], arm: dict[str, Any]) -> dict[str, Any]:
    if not arm.get("flat_knowledge"):
        return arm
    from .tenjin_arm import lessons_for
    result = copy.deepcopy(arm)
    knowledge = task["knowledge"]
    lessons = lessons_for(task, manifest.asset_path(knowledge), knowledge["lessons"]) if knowledge["lessons"] else []
    body = "\n\n".join(lesson.body.read_text() for lesson in lessons)
    overlay = result.setdefault("settings", {}).setdefault("overlay", {})
    overlay["LESSONS.md"] = body
    instruction = "Before starting, read LESSONS.md for findings retained from earlier work. Treat them as fallible evidence; the current task's requirements take precedence.\n"
    for name in ("CLAUDE.md", "AGENTS.md"):
        overlay[name] = overlay.get(name, "") + instruction
    return result


def knowledge_facts(manifest: Any, task: dict[str, Any], arm: dict[str, Any]) -> dict[str, Any] | None:
    """Name the source bodies, independently of per-run publication stamps/IDs."""
    if "knowledge" not in task:
        return None
    from . import sha256_file
    from .tenjin_arm import lessons_for
    knowledge = task["knowledge"]
    lessons = lessons_for(task, manifest.asset_path(knowledge), knowledge["lessons"]) if knowledge["lessons"] else []
    selected = (knowledge["background"] if arm.get("producer") else knowledge["lessons"]) if arm.get("provision") or arm.get("flat_knowledge") else []
    return {"corpus_hash": knowledge["hash"], "available": selected,
            "body_hashes": {lesson.id: "sha256:" + sha256_file(lesson.body) for lesson in lessons}}


def changed_outside_contract(spec: verifier.VerifierSpec, repo: Path) -> str | None:
    assert spec.fixture is not None
    # Refuse linked parent directories before reading any submitted file.
    # node_modules is discarded and restored from the image before execution.
    for actual in repo.rglob("*"):
        if actual.is_symlink() and actual.relative_to(repo).parts[0] not in {"node_modules", ".git", ".bench1"}:
            return "submitted source contains a symlink"
    for original in spec.fixture.rglob("*"):
        if not original.is_file():
            continue
        relative = original.relative_to(spec.fixture).as_posix()
        if may_change(relative, spec.allowed_changes):
            continue
        actual = repo / relative
        if actual.is_symlink() or not actual.is_file() or actual.read_bytes() != original.read_bytes():
            return "changed file outside allowed source paths"
    for relative in spec.allowed_changes:
        if relative.endswith("/"):
            continue
        actual = repo / relative
        if actual.is_symlink() or ((spec.fixture / relative).is_file() and not actual.is_file()):
            return "allowed source path is absent or a symlink"
    for actual in repo.rglob("*"):
        relative = actual.relative_to(repo).as_posix()
        # Dependencies are replaced from the immutable image before execution.
        if relative.startswith("node_modules/") or relative.split("/")[0] in {".git", ".bench1"}:
            continue
        if not actual.is_file() and not actual.is_symlink():
            continue
        if (spec.fixture / relative).exists() or may_change(relative, spec.allowed_changes) or relative in {ORACLE, "CLAUDE.md", "AGENTS.md", "LESSONS.md"}:
            continue
        return "added file outside allowed source paths"
    return None


def verify(spec: verifier.VerifierSpec, repo: Path, run_dir: Path, image: str | None) -> verifier.Verdict:
    from . import container_verifier
    if image is None:
        return verifier.Verdict(spec.name, "invalid", None, "historical verification requires a pinned image")
    problem = changed_outside_contract(spec, repo)
    if problem:
        return verifier.Verdict(spec.name, "fail", 1, problem)
    if not (repo / ORACLE).is_file() or spec.hidden_layer is None:
        return verifier.Verdict(spec.name, "invalid", None, "historical hidden oracle is missing")
    # The hidden copy must still contain the bound controller oracle.
    if (repo / ORACLE).read_bytes() != (spec.hidden_layer / ORACLE).read_bytes():
        return verifier.Verdict(spec.name, "invalid", None, "historical oracle changed")
    if spec.support is None or spec.support_hash != "sha256:" + sha256_dir(spec.support):
        return verifier.Verdict(spec.name, "invalid", None, "historical verification support changed")
    return container_verifier.run(spec, repo, run_dir, image)


def materialize(context: Path, out: Path, *, catalog: Path) -> dict[str, Any]:
    """Convert proven source preparation to a normal runner fixture + hidden layer."""
    import json
    import shutil
    from . import historical
    from .manifest import fixture_hash
    receipt = historical.validate_context(context, catalog=catalog)
    task = historical.task_named(receipt["task"], catalog)
    if out.exists():
        raise ValueError("historical model assets need a new directory")
    if receipt["revision"] != "before":
        raise ValueError("models must start from the historical before revision")
    if not task.get("prompt") or not task.get("allowed_changes"):
        raise ValueError("experiment must declare its work order and allowed source paths")
    fixture = out / "fixture"
    shutil.copytree(context / "source", fixture, ignore=shutil.ignore_patterns("AGENTS.md", "CLAUDE.md", "node_modules", ".npmrc", ".pnpmfile.cjs"))
    hidden = out / "hidden" / "src"
    hidden.mkdir(parents=True)
    shutil.copyfile(context / "oracle.test.ts", hidden / "benchmark-independent.test.ts")
    support = out / "verification"
    support.mkdir()
    for name in ("vitest.config.mjs", "database.mjs"):
        shutil.copyfile(context / name, support / name)
    (support / "source-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    result = {"id": task["id"], "family": task.get("family", task["id"]),
              "transfer_distance": task.get("transfer_distance", "none"),
              "fixture": f"{out.name}/fixture", "fixture_hash": fixture_hash(fixture),
              "verifier": HISTORICAL, "prompt": task["prompt"],
              "hidden": {"path": f"{out.name}/hidden", "hash": "sha256:" + sha256_dir(hidden.parent)},
              "allowed_changes": task["allowed_changes"],
              "verification": {"path": f"{out.name}/verification", "hash": "sha256:" + sha256_dir(support)}}
    if task.get("database") == "postgres":
        result["database"] = "postgres"
    (out / "task.json").write_text(json.dumps(result, indent=2) + "\n")
    (out / "source-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return result
