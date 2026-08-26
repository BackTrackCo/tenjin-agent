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

To cut a release (two clicks):

1. **Dispatch (click 1)**: Actions -> Release -> Run workflow -> `main`. The
   `version` job runs `changeset version` (consumes `.changeset/*.md`, bumps
   `package.json`, regenerates `CHANGELOG.md`) and opens the
   **"chore(release): version packages"** PR. Nothing is published yet.
2. **Review and merge** that PR (its final state is what ships; edit the version
   or changelog directly if needed).
3. **Dispatch (click 2)**: same path. With no pending changesets, the `publish`
   job builds, runs the check suite plus `pnpm audit` plus the packed-artifact
   smoke as a pre-publish gate, then `changeset publish` ships `tenjin-cli` with
   provenance and creates the GitHub release. Every publish lands on the `latest`
   dist-tag, prerelease or stable (`.changeset/pre.json`'s `"tag": "alpha"` is
   pre-mode bookkeeping and does not decide it); the CLI updater resolves against
   `latest` alone, so publish tagging and `src/lib/update-check.ts` must change
   together.

A publish that actually shipped then files one issue on `BackTrackCo/tenjin`
(`scripts/notify-registry-pin.sh`): its MCP Registry manifest pins `tenjin-cli`
by exact version, and nothing else notices that the pin went stale. Deciding
whether the release is worth advertising, and publishing the manifest, stay
manual on that side.

**If that step fails, re-running the job does not fix it.** The publish already
happened, so a re-run has no changesets left to consume, `published` comes back
`false`, and the notification is skipped for good. Send it by hand instead, with
a PAT that has Issues write on `BackTrackCo/tenjin` (the same one
`RELEASE_CROSSREPO_TOKEN` holds):

```sh
PUBLISHED=true \
  PUBLISHED_PACKAGES='[{"name":"tenjin-cli","version":"0.1.0-alpha.15"}]' \
  GH_TOKEN=<PAT> bash scripts/notify-registry-pin.sh
```

Use the version the failed run actually published. The script skips an open issue
that already asks for that exact bump, so running it twice is safe.

Auth is npm Trusted Publishing (OIDC): each publish mints a short-lived, per-run
token, so there is **no `NPM_TOKEN`** to store or rotate.

## Server-coupled releases

Some releases gate a server-side flag flip in the `tenjin` repo. The flip waits
for the CLI release to reach operators, so the order is: ship here, confirm
adoption, then flip there. Never the reverse.

Open couplings:

- **Ingest scan gate, warn tier (`SCAN_WARN_MODE`).** The gate in
  `BackTrackCo/tenjin` runs the publish scan server-side in the shared write
  path. Its block tier is live; its warn tier ships in `advisory` mode, where a
  warn-bearing publish succeeds and the findings ride the success response. The
  `enforce` value instead rejects with `scan_needs_ack` plus an ack token, which
  only a CLI carrying the ack flow (`src/lib/scan-gate.ts`, first released here)
  can answer. Flipping the env to `enforce` before that release has propagated
  turns every warn-tier publish from an older CLI into an unrecoverable exit-4
  write failure. `tenjin update` also does not rewrite installed hook scripts
  (tenjin-agent#171), so adoption lags a release; wait for it.

  **Team shelves stay advisory.** A team deployment runs the same gate, because
  it sits in the shared write path, and it keeps the block tier on purpose. It
  sets no `SCAN_WARN_MODE`, so its warn tier reports on the success response and
  holds nothing, and this coupling does not ask you to flip it there. Under
  `enforce` a shelf would re-impose exactly the warn findings the team drop
  (`survivesTeamDrop`, `src/lib/scan.ts`) exists to remove, so flipping it is a
  deliberate change of what a team note is allowed to carry, not a rollout step.

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
4. **Add repo secret `RELEASE_CROSSREPO_TOKEN`**: a fine-grained PAT scoped to
   `BackTrackCo/tenjin` with **Issues: read and write**, used only by the
   registry-pin notification. The release-bot App cannot stand in for it: it is
   installed on this repo alone and holds no Issues permission. Without the
   secret the publish succeeds and the notification step fails the run.
