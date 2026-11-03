<!-- Generated from tenjin-workspace/tooling/policy/tenjin-agent-contributor.md -->
<!-- Source-SHA256: 245fae0778be99ae59072ace06bccda5a1017243b98416193edfb9e10b860c4d -->

# tenjin-agent contributor guidance

This is the public, standalone Tenjin CLI and skill package. It builds, tests,
releases, installs, and runs without access to a private workspace,
organization secrets, or sibling repositories.

Commands, the changeset requirement, and the release flow are in
[RELEASING.md](./RELEASING.md) and [CONTRIBUTING.md](./CONTRIBUTING.md). The
wallet, scan, spend, and redaction boundaries are in
[docs/safety-model.md](./docs/safety-model.md).

## Workspace behavior

When this clone sits under `tenjin-workspace`, the parent adds coordination and
shared worktree commands. From the workspace root, run `./scripts/status --json`
to start cross-repository work, `./scripts/worktree tenjin-agent USER/topic` to
create a managed worktree, and `./scripts/check --repo tenjin-agent` for the
repository gate. Locally, run the test files you touched; CI runs the full suite.
