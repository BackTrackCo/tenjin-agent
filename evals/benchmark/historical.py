"""Prepare pinned historical sources without executing them, then verify in Harbor.

This is task admission evidence, not a competing model runner. The fixed catalog
names public source commits; neither it nor a CLI argument supplies a command.
Dependencies install with lifecycle scripts disabled. Historical source only runs
in the later network-free, credential-free container through the Bench-1 backend.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import re
import shutil
import subprocess
import tarfile
import uuid
from pathlib import Path

from . import vitest_result, container, database_service, images, sha256_dir, sha256_file, sha256_json

ROOT = Path(__file__).parent / "historical"
REVISION = ("before", "after")
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
# Keep source, ordinary docs/tests and dependency configuration. Never copy Git
# metadata, repository automation, installed hooks, or a checkout's dirty files.
OMIT = {".github", ".githooks", ".claude", ".agents", ".codex", ".changeset"}
COMMAND = ["node", "node_modules/vitest/vitest.mjs", "run", "--config", "/opt/benchmark-historical/vitest.config.mjs", "--configLoader", "native", "--reporter=json", "--outputFile=/tmp/benchmark-historical-result.json"]


class ReplayError(ValueError):
    pass


def task_named(name: str, catalog: Path) -> dict:
    tasks = json.loads(catalog.read_text())["tasks"]
    matches = [task for task in tasks if task["id"] == name]
    if len(matches) != 1:
        raise ReplayError("unknown or ambiguous historical task")
    task = matches[0]
    for revision in REVISION:
        if HEX40.fullmatch(task[f"{revision}_commit"]) is None or HEX40.fullmatch(task["trees"][revision]) is None:
            raise ReplayError("historical task requires full commit and tree IDs")
    if task["source_repository"] not in {"https://github.com/BackTrackCo/tenjin-agent.git", "https://github.com/BackTrackCo/tenjin.git"}:
        raise ReplayError("historical source repository is not allowlisted")
    if any(re.fullmatch(r"[0-9a-f]{64}", task.get("source_hashes", {}).get(revision, "")) is None for revision in REVISION):
        raise ReplayError("historical task requires catalog-pinned source hashes")
    if task["oracle"] != name + ".test.ts":
        raise ReplayError("oracle must be the task's code-owned file")
    return task


def unpack(archive: bytes, destination: Path) -> None:
    """Only regular files/directories, with no traversal or symlink extraction."""
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        members = []
        for member in source.getmembers():
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts:
                raise ReplayError("historical archive path escapes its source root")
            if not path.parts or path.parts[0] in OMIT:
                continue
            if not (member.isfile() or member.isdir()):
                raise ReplayError("historical archive contains a link or special file")
            members.append(member)
        source.extractall(destination, members=members, filter="data")


def prepare(repo: Path, task_id: str, revision: str, out: Path, *, catalog: Path) -> dict:
    if revision not in REVISION:
        raise ReplayError("unknown historical revision")
    task = task_named(task_id, catalog)
    commit = task[f"{revision}_commit"]
    tree = images.run_git(repo, "rev-parse", commit + "^{tree}")
    if tree is None or tree.strip() != task["trees"][revision]:
        raise ReplayError("historical commit/tree is absent or mismatched")
    if out.exists():
        raise ReplayError("preparation requires a new output directory")
    result = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", commit], capture_output=True, timeout=30, check=False)
    if result.returncode:
        raise ReplayError("cannot archive historical commit")
    out.mkdir(parents=True)
    try:
        source = out / "source"
        unpack(result.stdout, source)
        if sha256_dir(source) != task["source_hashes"][revision]:
            raise ReplayError("historical source differs from the catalog-pinned tree content")
        lock = source / "pnpm-lock.yaml"
        if not lock.is_file() or sha256_file(lock) != task["lock_sha256"]:
            raise ReplayError("historical dependency lock differs from admission evidence")
        shutil.copyfile(catalog.parent / "oracles" / task["oracle"], out / "oracle.test.ts")
        shutil.copyfile(ROOT / "vitest.config.mjs", out / "vitest.config.mjs")
        shutil.copyfile(ROOT / "Dockerfile", out / "Dockerfile")
        shutil.copyfile(ROOT / "database.mjs", out / "database.mjs")
        receipt = {"schema": "bench1.historical-source.v1", "task": task_id, "revision": revision, "catalog_sha256": sha256_file(catalog), "task_sha256": sha256_json(task),
                   "commit": commit, "tree": tree.strip(), "source_hash": sha256_dir(source),
                   "lock_sha256": sha256_file(lock), "oracle_sha256": sha256_file(out / "oracle.test.ts"),
                   "omitted_roots": sorted(OMIT), "model_executed": False}
        (out / "source-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        return receipt
    except BaseException:
        shutil.rmtree(out)
        raise


def build_args() -> dict[str, str]:
    return {"NODE_IMAGE": f"{images.BASE_IMAGE}@{images.BASE_DIGEST}", "PNPM_VERSION": images.PNPM_VERSION}


def validate_context(context: Path, *, catalog: Path) -> dict:
    receipt = json.loads((context / "source-receipt.json").read_text())
    task = task_named(receipt["task"], catalog)
    if receipt.get("task_sha256") != sha256_json(task):
        raise ReplayError("experiment task changed after preparation")
    revision = receipt["revision"]
    if revision not in REVISION or receipt["commit"] != task[f"{revision}_commit"] or receipt["tree"] != task["trees"][revision]:
        raise ReplayError("context does not name the catalog's historical source")
    source_root = context / "source"
    if source_root.is_symlink() or not source_root.is_dir() or any(path.is_symlink() or not (path.is_file() or path.is_dir()) for path in source_root.rglob("*")):
        raise ReplayError("historical source contains links or special files")
    if receipt["source_hash"] != task["source_hashes"][revision] or sha256_dir(context / "source") != task["source_hashes"][revision] or sha256_file(context / "source" / "pnpm-lock.yaml") != task["lock_sha256"]:
        raise ReplayError("historical source or dependency lock changed after preparation")
    for source, staged in [(catalog.parent / "oracles" / task["oracle"], context / "oracle.test.ts"), (ROOT / "Dockerfile", context / "Dockerfile"), (ROOT / "vitest.config.mjs", context / "vitest.config.mjs"), (ROOT / "database.mjs", context / "database.mjs")]:
        if not source.is_file() or not staged.is_file() or sha256_file(source) != sha256_file(staged):
            raise ReplayError("code-owned verifier or build recipe changed after preparation")
    return receipt


def build(context: Path, *, catalog: Path) -> str:
    validate_context(context, catalog=catalog)
    api = images.harbor()
    return str(asyncio.run(api.ensure(
        docker_name="bench-historical", docker_build_context=context,
        dockerfile_path=context / "Dockerfile",
        build_args=build_args(),
        platform=asyncio.run(api.platform()), timeout_sec=images.BUILD_TIMEOUT_S,
    )))


def verify(context: Path, run_dir: Path, image: str, *, catalog: Path) -> dict:
    if re.fullmatch(r"sha256:[0-9a-f]{64}", image) is None:
        raise ReplayError("verification requires an immutable image ID")
    receipt = validate_context(context, catalog=catalog)
    api = images.harbor()
    key = api.context_hash(context=context, dockerfile_path=context / "Dockerfile", build_args=build_args(), platform=asyncio.run(api.platform()))
    if images.image_id(api.name("bench-historical", key)) != image:
        raise ReplayError("image does not match the prepared historical source and oracle")
    identity = "replay-" + receipt["task"] + "-" + receipt["revision"] + "-" + image[7:19] + "-" + uuid.uuid4().hex[:12]
    name = container.container_name(identity)
    project = container.record_project(run_dir, identity, name)
    recipe = container.Recipe(name=name, image=image, workdir=Path("/opt/task"),
                              trial_dir=run_dir / identity / "trial", environment_dir=run_dir / identity / "environment",
                              plan=[container.Mount(context / "database.mjs", Path("/benchmark-database.mjs"), "ro")] if task_named(receipt["task"], catalog).get("database") == "postgres" else [], environment={"HOME": "/tmp"}, egress=container.no_network())
    result = {**receipt, "image": image, "status": "invalid", "cleanup": False, "tests": None}
    try:
        enabled = task_named(receipt["task"], catalog).get("database") == "postgres"
        if enabled:
            result["database_image"] = database_service.IMAGE
        with container.Container(recipe=recipe) as running, database_service.service(running, enabled) as database_environment:
            completed = running.exec(COMMAND, cwd=recipe.workdir, environment=database_environment, timeout_s=120)
            report = running.exec(["cat", "/tmp/benchmark-historical-result.json"], timeout_s=10)
        if report.returncode == 0:
            data = json.loads(report.stdout)
            total, failed = data.get("numTotalTests", 0), data.get("numFailedTests", 0)
            result["tests"] = {"total": total, "passed": data.get("numPassedTests", 0), "failed": failed}
            # Import/setup/collection failures cannot masquerade as fail-before.
            assertions = [a for suite in data.get("testResults", []) for a in suite.get("assertionResults", [])]
            result["status"] = vitest_result.outcome(data, completed.returncode)
            result["assertions"] = [{"title": a.get("fullName"), "status": a.get("status"), "failures": a.get("failureMessages", [])} for a in assertions]
        result["detail"] = (completed.stderr or completed.stdout)[-1600:]
    except Exception as error:
        result["status"] = "invalid"
        result["detail"] = f"verification infrastructure failed: {type(error).__name__}"
    finally:
        try:
            container.remove_project(project)
        except images.ImageError:
            result["status"] = "invalid"
            result["detail"] = "verification container cleanup failed"
        else:
            container.forget_project(run_dir, identity)
            result["cleanup"] = True
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / f"{identity}.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main(catalog: Path | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=catalog is None, default=catalog)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("--repo", type=Path, required=True)
    prep.add_argument("--task", required=True)
    prep.add_argument("--revision", choices=REVISION, required=True)
    prep.add_argument("--out", type=Path, required=True)
    model = commands.add_parser("materialize")
    model.add_argument("--context", type=Path, required=True)
    model.add_argument("--out", type=Path, required=True)
    image = commands.add_parser("build")
    image.add_argument("--context", type=Path, required=True)
    check = commands.add_parser("verify")
    check.add_argument("--context", type=Path, required=True)
    check.add_argument("--run", type=Path, required=True)
    check.add_argument("--image", required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.repo, args.task, args.revision, args.out, catalog=args.catalog)
    elif args.command == "materialize":
        from . import task_assets
        result = task_assets.materialize(args.context, args.out, catalog=args.catalog)
    elif args.command == "build":
        name = build(args.context, catalog=args.catalog)
        result = {"name": name, "id": images.image_id(name)}
    else:
        result = verify(args.context, args.run, args.image, catalog=args.catalog)
    print(json.dumps(result, indent=2))
    return int(result.get("status") == "invalid")


if __name__ == "__main__":
    raise SystemExit(main())
