# Contributing and releasing

## Contributing

```bash
pnpm install
pnpm check        # build + test
pnpm lint && pnpm typecheck && pnpm format:check
pnpm pack-smoke   # exercises the packed npm artifact
```

Add a changeset in the same PR as any shippable change:

```sh
pnpm changeset   # pick the bump type, write a summary; commit the .md
```

## Release

Publishing to npm uses Changesets and npm Trusted Publishing (OIDC), driven by
the two-job `workflow_dispatch`-only `.github/workflows/release.yml`, adapted from
the house template (`BackTrackCo/x402r-sdk`). Nothing auto-fires from a push or a
tag: a maintainer clicks Run workflow at each step.

**Moving the Node pin.** Tenjin's runtime downloads the Node that
`package.json` `tenjinRuntime.node` pins, checked against the sha256 recorded
there. To move it, run `node scripts/pin-node.mjs <24.x.y>` and commit the
result before the release PR. It needs `gpg` (for `gpgv`) and refuses, writing
nothing, unless Node's `SHASUMS256.txt` signature verifies against the release
keys it pins. It runs at release time only, never in CI or during install.
Before each release, check nodejs.org for a newer Node 24 security release;
when there is one, run `node scripts/pin-node.mjs <24.x.y>` and commit it
before the release PR. Auto-update then delivers that Node with the release.

**Hooks and server across versions.** Codex starts its auto-update as a session
ends, but with two Codex sessions open, the one still running sees its hooks
move to the new version while its server stays on the old one. Whatever a hook
hands the server (offer files under the data dir, the `request` tool's fields
the hook line tells the model to fill) should stay readable across adjacent
versions.

To cut a release (two clicks):

1. **Dispatch (click 1)**: Actions -> Release -> Run workflow -> `main`. The
   `version` job runs `changeset version` (consumes `.changeset/*.md`, bumps
   `package.json`, regenerates `CHANGELOG.md`) and opens the
   **"chore(release): version packages"** PR. Nothing is published yet.
2. **Review and merge** that PR (its final state is what ships; edit the version
   or changelog directly if needed). Its CI fails on any high `pnpm audit`
   advisory, the same check the publish gate runs: merge the `bot/audit-fix` PR
   that the daily `audit` workflow opens (or dispatch that workflow to open
   one), then update the version PR from `main`.
3. **Dispatch (click 2)**: same path. With no pending changesets, the `publish`
   job builds, runs the check suite plus `pnpm audit` plus the packed-artifact
   smoke as a pre-publish gate, then `changeset publish` ships `tenjin-cli` with
   provenance and creates the GitHub release. Every publish lands on the `latest`
   dist-tag, prerelease or stable (`.changeset/pre.json`'s `"tag": "alpha"` is
   pre-mode bookkeeping and does not decide it); the CLI updater resolves against
   `latest` alone, so publish tagging and `src/lib/update-check.ts` must change
   together.

The same publish job downloads the exact published tarball from npm, verifies
its registry SHA512 integrity, and runs `scripts/build-installers.mjs` to create
`install.sh` and `install.ps1`. The scripts embed that tarball's SHA512 and its
signature-checked Node pins. They are immutable assets on the matching GitHub
release tag `v<version>`. Re-running the workflow skips identical assets and
refuses to replace different bytes. The website resolves npm's latest version,
loads that exact release (including prereleases), and verifies each asset
against GitHub's SHA256 digest before serving it unchanged.

To inspect a candidate locally, build, pack, then run
`node scripts/build-installers.mjs <candidate.tgz> <output-dir>`. Candidate
packages are fixtures; do not serve their scripts as an already-published npm
version. `node scripts/installer-smoke.mjs` exercises generated scripts with
isolated download fixtures, including corrupt downloads and profile refusal.

Auth is npm Trusted Publishing (OIDC): each publish mints a short-lived, per-run
token, so there is **no `NPM_TOKEN`** to store or rotate.

## One-time owner setup

Credentials are configured on this repo (`gh variable list` / `gh secret list` to
verify) and `tenjin-cli` is published to npm, so releases run without further
setup. For a fork or a re-setup, the steps are:

1. **Install the shared `backtrack-release-bot` GitHub App on
   `BackTrackCo/tenjin-agent`** (permissions: Contents write, Pull requests write;
   no webhook; also installed on `BackTrackCo/x402r-sdk`), then set repo
   **variable** `RELEASE_APP_CLIENT_ID` and repo **secret**
   `RELEASE_APP_PRIVATE_KEY`. Required because Changesets' version PR must be
   opened by an App identity to trigger CI (the default `GITHUB_TOKEN` cannot, by
   GitHub's anti-recursion rule).
2. **Add a Trusted Publisher** to `tenjin-cli` on npmjs.com: provider GitHub
   Actions, organization `BackTrackCo`, repository `tenjin-agent`, workflow
   filename `release.yml`, environment `npm-publish`.
3. **Create a GitHub Environment named `npm-publish`** (Settings ->
   Environments), optionally with required reviewers to gate each publish.
