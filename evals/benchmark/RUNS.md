# Benchmark framework configuration

Bench-1 owns smoke configuration, shared hook presets, the container CI runner, and reusable
reporting/artifact plumbing. Local and CI runs use the same Docker Compose execution path.
Colima can provide Docker locally; no host-native live runner is needed.

Pass `--manifest PATH` to `live-run` and `--baseline PATH` to `regress`. The framework smoke
configurations live in `configuration.py`. Bench-2 experiment selections and their callers
live above this layer. Configuration tests are in `tests/test_framework_configuration.py`.

The plumbing smoke runs one control attempt. Hooks smoke (4 consumers) and failure-key smoke
(6 consumers) remain distinct delivery checks. None is a product headline.

PR workflows compare completion rate, consumer seconds per verified completion, and tokens per
verified completion against the last matching completed main run's retained artifact. Matching
requires the same measurement protocol and execution mode, while allowing product revisions
to differ. The protocol hashes the expanded manifest except arm product-version labels; actual
product image/commit receipts are provenance rather than matching inputs. Artifact selection checks the newest 100
completed main runs of the same workflow, completed before the PR run began, and selects the
newest matching artifact, even if its
report is invalid; missing, expired, incomplete or invalid evidence produces an explicit
unavailable comparison. No baseline model run is launched. The plumbing workflow records main
runs after benchmark changes; product lanes use their existing main schedules/manual runs.
The fixed September 7 numerical baseline is removed. Historical evidence stays in tenjin-notes.
Regression is informational, with a 25% cost-increase diagnostic threshold, not a significance test.

For targeted runs, a sibling JSON selection can name `schema: bench1.selection.v1`, `source`
(the full manifest filename), and optional `tasks` and `arms` ID lists. It inherits the source's
pins, repeats and task/arm definitions before hashing. Every command accepting `--manifest`
uses the same selection, including image building, attestation, scheduling and readout.

CI prints the exact experiment matrix before execution. After execution, the check summary and
`report.md` begin with status, matrix coverage, verified completions and consumer time/token costs
for every arm. Detailed accounting and task diagnostics follow in an expandable section. The
artifact includes `experiment.txt`, `report.md` and machine-readable `report.json`. The shared
`describe --manifest PATH`, `summary --run RUN`, and `headline --run RUN` commands expose the
same reading locally. A provisional measurement is explicitly labeled, never called hardened.

Repository writers are trusted with benchmark credentials. Random fork PRs receive no repository
secrets and the credentialed lanes skip; these workflows use `pull_request`, never
`pull_request_target`. Review before merging into main remains required, but does not gate a
same-repository writer's pre-merge workflow execution. CI and benchmark labels control which
experiments run, not secret access. Container isolation applies to trial execution; it does not
isolate the repository-local Python parent from credentials. If writers later need to be
untrusted, move the credentials into a protected environment with required reviewers and remove
the repository-level copies; a label or a job condition alone is not that security boundary.

Shelf experiments share one concurrency group because reset mutates their shared corpus.
`queue: max` retains up to 100 pending runs instead of replacing the previous pending PR;
additional arrivals beyond that GitHub limit are canceled. Queue time is additional to run time.
