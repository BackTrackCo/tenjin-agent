<!-- Generated from tenjin-workspace/tooling/policy/tenjin-agent-contributor.md -->
<!-- Source-SHA256: 3a952dee5b068e69f97f92944f8922e353059de368ba0efe5a32617eff7d19f6 -->

# tenjin-agent contributor guidance

This is the public, standalone Tenjin CLI and skill package. It builds, tests,
releases, installs, and runs without access to a private workspace,
organization secrets, or sibling repositories.

Commands, the changeset requirement, and the release flow are in
[RELEASING.md](./RELEASING.md) and [CONTRIBUTING.md](./CONTRIBUTING.md). The
wallet, scan, spend, and redaction boundaries are in
[docs/safety-model.md](./docs/safety-model.md). Never weaken scan, spend,
redaction, or ownership to simplify a test.

## Workspace behavior

When this clone sits under `tenjin-workspace`, the parent adds coordination and
shared worktree commands. From the workspace root, run `./scripts/status --json`
to start cross-repository work, `./scripts/worktree tenjin-agent USER/topic` to
create a managed worktree, and `./scripts/check --repo tenjin-agent` for the
repository gate.

Run the test files you touched locally; CI runs the full suite.
