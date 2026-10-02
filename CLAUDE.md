<!-- Generated from tenjin-workspace/tooling/policy/tenjin-agent-contributor.md -->
<!-- Source-SHA256: 45335070120f7c62345d6725556aa706130c76e8b8e890ee87d14dfff821b459 -->

# tenjin-agent contributor guidance

This is the public, standalone Tenjin CLI and skill package. It must build,
test, release, install, and run without access to a private workspace,
organization secrets, or sibling repositories.

## Development workflow

- Use Node 24 and the `pnpm` version declared in `package.json`.
- Install with `pnpm install --frozen-lockfile`.
- Work on a branch and open a pull request; never push directly to `main`.
- Use conventional commits and keep unrelated changes out of the same PR.
- Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm pack-smoke` before merging.

Preserve stable JSON envelopes, documented exit codes, the packed CLI shape,
and public fork CI. Wallet keys and consent state stay local; never weaken the
scan, spend, redaction, or ownership boundaries to simplify a test. Keep tests
beside the code they cover and update public docs when a command contract moves.

## Workspace behavior

When this clone sits under `tenjin-workspace`, the parent adds coordination and
shared worktree commands. Start cross-repository work with
`../scripts/status --json`, create managed worktrees with
`../scripts/worktree tenjin-agent USER/topic`, and run the repository gate with
`../scripts/check --repo tenjin-agent`.

This file is generated identically as `AGENTS.md` and `CLAUDE.md`, so Claude
Code, Codex, and OpenCode receive the same public contract. It remains the
complete standalone fallback; this repository's release, CI, security, and
package rules remain authoritative.
