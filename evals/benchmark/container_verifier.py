"""Run agent-written source only in the trial's pinned image, without credentials or network."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil

from . import container, database_service, historical_outputs, verifier, vitest_result


def run(spec: verifier.VerifierSpec, repo: Path, run_dir: Path, image: str) -> verifier.Verdict:
    if re.fullmatch(r"sha256:[0-9a-f]{64}", image) is None:
        return verifier.Verdict(spec.name, "invalid", None, "verification requires an immutable image ID")
    digest = hashlib.sha256(str(repo).encode()).hexdigest()[:24]
    identity = f"verify-{digest}"
    name = container.container_name(identity)
    owned = run_dir / "verification-containers" / digest
    target = Path("/benchmark-verify")
    mounts = [container.Mount(repo, target, "ro")]
    if spec.kind == "historical_vitest":
        if spec.support is None:
            return verifier.Verdict(spec.name, "invalid", None, "historical verification support is missing")
        # The controller checkout need not be shared with a local Docker VM.
        # Stage trusted support beside the already-mounted trial artifacts.
        support = owned / "support"
        support.mkdir(parents=True, exist_ok=True)
        config = support / "vitest.config.mjs"
        shutil.copyfile(spec.support / config.name, config)
        mounts.append(container.Mount(config, Path("/benchmark-historical.config.mjs"), "ro"))
        if spec.database:
            shutil.copyfile(spec.support / "database.mjs", support / "database.mjs")
            mounts.append(container.Mount(config.with_name("database.mjs"), Path("/benchmark-database.mjs"), "ro"))
    recipe = container.Recipe(
        name=name, image=image, workdir=target,
        trial_dir=owned / "trial", environment_dir=owned / "environment",
        plan=mounts,
        environment={"HOME": "/tmp", "BENCH2_DAEMON": "", "BENCH2_OUTPUT": "/tmp/benchmark-verifier"},
        egress=container.no_network(),
    )
    project = container.record_project(run_dir, identity, name)
    # Private diagnostics survive container teardown; public reports only receive
    # the bounded verdict facts, never source output or assertion bodies.
    def diagnostic(value):
        owned.mkdir(parents=True, exist_ok=True)
        (owned / "diagnostic.json").write_text(json.dumps(value, indent=2) + "\n")
    verdict = verifier.Verdict(spec.name, "invalid", None, "verification did not complete")
    try:
        with container.Container(recipe=recipe, ledger=container.Ledger(run_dir, identity)) as running, database_service.service(running, spec.database) as database_environment:
            historical = spec.kind == "historical_vitest"
            if historical:
                # Use fresh image dependencies, never model-modified tooling.
                excludes = [f"--exclude=./{name}" for name in historical_outputs.names(repo)]
                for argv in (["tar", "-C", str(target), "--no-wildcards", *excludes, "-cf", "/tmp/historical-source.tar", "."],
                             ["mkdir", "-p", "/tmp/historical-task"],
                             ["tar", "-xf", "/tmp/historical-source.tar", "-C", "/tmp/historical-task"],
                             ["ln", "-s", "/opt/fixture/node_modules", "/tmp/historical-task/node_modules"]):
                    if running.exec(argv, timeout_s=60).returncode != 0:
                        raise ValueError("cannot stage historical verification")
                completed = running.exec(
                    ["node", "/opt/fixture/node_modules/vitest/vitest.mjs", "run", "--config",
                     "/benchmark-historical.config.mjs", "--configLoader", "native", "--reporter=json",
                     "--outputFile=/tmp/historical-result.json"], cwd=Path("/tmp/historical-task"), environment=database_environment, timeout_s=spec.timeout_s)
                report = running.exec(["cat", "/tmp/historical-result.json"], timeout_s=10)
                data = json.loads(report.stdout) if report.returncode == 0 else {}
            else:
                completed = running.exec(
                    [verifier.NODE, str(target / spec.container_test)],
                    cwd=target, timeout_s=spec.timeout_s,
                )
            diagnostic({"exit_code": completed.returncode, "stdout": completed.stdout[-65536:],
                        "stderr": completed.stderr[-65536:], "assertions": data if historical else None})
        detail = (completed.stderr or completed.stdout).strip()[-verifier.OUTPUT_LIMIT:]
        code = completed.returncode
        if spec.kind == "historical_vitest":
            if vitest_result.outcome(data, code) == "invalid":
                code, detail = 2, "historical verifier did not produce complete behavioral assertions"
        if code == 0 and spec.marker is not None:
            problem = spec.marker(repo)
            if problem is not None:
                code, detail = 1, problem
        verdict = verifier.Verdict(spec.name, verifier.outcome_of(code), code, detail, image=image, database_image=database_service.IMAGE if spec.database else None)
    except Exception as error:
        diagnostic({"error_type": type(error).__name__, "detail": str(error)[-65536:]})
        # A broken verifier/container is an invalid measurement, never a task failure.
        verdict = verifier.Verdict(spec.name, "invalid", None, f"container verification failed: {type(error).__name__}")
    finally:
        # Keep a cleanup marker if teardown fails, so the normal run sweep can retry.
        try:
            # False means the context manager already removed every object.
            # Cleanup failures raise; the return value only reports removal.
            container.remove_project(project)
        except container.ImageError:
            verdict = verifier.Verdict(spec.name, "invalid", None, "verification container cleanup failed")
        else:
            container.forget_project(run_dir, identity)
    return verdict
