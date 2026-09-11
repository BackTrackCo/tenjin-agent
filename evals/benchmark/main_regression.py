"""Read the latest matching completed main artifact; never launch a baseline run."""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import zipfile

from . import regress


def api(repository: str, route: str) -> bytes:
    return subprocess.run(["gh", "api", f"repos/{repository}/{route}"], check=True, capture_output=True, timeout=60).stdout


def latest_main(current: dict, repository: str, run_id: str, artifact_name: str, fetch=api) -> tuple[dict, dict] | None:
    """Newest matching report among the 100 most recent completed main runs.

    A failed run may still have a complete report. An invalid latest matching
    report is returned too: comparison must expose that, not silently pick an
    older healthier run. No archive is extracted or executed.
    """
    run = json.loads(fetch(repository, f"actions/runs/{run_id}"))
    workflow = run["workflow_id"]
    runs = json.loads(fetch(repository, f"actions/workflows/{workflow}/runs?branch=main&status=completed&per_page=100"))["workflow_runs"]
    for candidate in sorted(runs, key=lambda item: (item["created_at"], item["id"]), reverse=True):
        if (str(candidate["id"]) == str(run_id) or candidate["head_branch"] != "main"
                or candidate["event"] == "pull_request" or candidate["status"] != "completed"
                or candidate["head_repository"]["full_name"] != repository):
            continue
        artifacts = json.loads(fetch(repository, f"actions/runs/{candidate['id']}/artifacts?per_page=100"))["artifacts"]
        artifacts = [item for item in artifacts if item["name"] == artifact_name and not item["expired"]]
        if not artifacts:
            continue
        artifact = max(artifacts, key=lambda item: item["id"])
        archive = fetch(repository, f"actions/artifacts/{artifact['id']}/zip")
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            reports = [info for info in zipped.infolist() if info.filename == "report.json" or info.filename.endswith("/report.json")]
            if len(reports) != 1 or reports[0].file_size > 10_000_000:
                raise ValueError("main artifact must contain exactly one bounded report.json")
            baseline = json.loads(zipped.read(reports[0]))
        if baseline.get("manifest_hash") == current.get("manifest_hash"):
            return baseline, {"run_id": candidate["id"], "sha": candidate["head_sha"], "url": candidate["html_url"], "artifact_id": artifact["id"]}
    return None


def render(result: dict) -> str:
    lines = [f"## Main regression: {result['status']}", ""]
    if result.get("source"):
        source = result["source"]
        lines += [f"Baseline: [main run {source['run_id']}]({source['url']}) at `{source['sha']}`.", ""]
    if result.get("reason"):
        lines += [result["reason"], ""]
    if result.get("rows"):
        lines += ["Informational comparison; increases above 25% in completion costs are flagged. No significance claim.", "",
                  "| Arm | Metric | Last main | This run |", "| --- | --- | ---: | ---: |"]
        for row in result["rows"]:
            values = ["unavailable" if row[key] is None else f"{row[key]:.4g}" for key in ("main", "current")]
            lines.append(f"| {row['arm']} | {row['metric']} | {values[0]} | {values[1]} |")
        lines.append("")
    lines.extend(f"- {finding}" for finding in result.get("findings", []))
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("--artifact", required=True)
    args = parser.parse_args()
    if not (args.run / "report.json").is_file():
        return 0
    current = json.loads((args.run / "report.json").read_text())
    result = {"status": "unavailable", "reason": "No matching retained main report in the last 100 completed main runs; no baseline was launched."}
    try:
        match = latest_main(current, os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_RUN_ID"], args.artifact)
        if match:
            baseline, source = match
            result = {**regress.compare_reports(current, baseline), "source": source}
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, subprocess.SubprocessError):
        result = {"status": "unavailable", "reason": "Main artifact lookup failed; inspect Actions access and artifact availability. No comparison was made."}
    text = render(result)
    print(text)
    (args.run / "regression.json").write_text(json.dumps(result, indent=2) + "\n")
    (args.run / "regression.md").write_text(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
            stream.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
