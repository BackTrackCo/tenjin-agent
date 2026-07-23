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
the two-job `workflow_dispatch`-only `.github/workflows/release.yml`. Nothing
auto-fires from a push or a tag: a maintainer clicks Run workflow at each step.

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
   provenance and creates the GitHub release. Prereleases use Changesets' pre
   mode (`pnpm changeset pre enter alpha`) and publish to the `alpha` dist-tag;
   stable goes to `latest`.

Auth is npm Trusted Publishing (OIDC): each publish mints a short-lived, per-run
token, so there is **no `NPM_TOKEN`** to store or rotate.

## One-time owner setup

Credentials are already configured and `tenjin-cli` is published to npm, so
releases run without further setup. This is kept as a reference for re-setup or a
fork:

1. **Install the release-bot GitHub App**, then set repo **variable**
   `RELEASE_APP_CLIENT_ID` and repo **secret** `RELEASE_APP_PRIVATE_KEY`.
   Required because Changesets' version PR must be opened by an App identity to
   trigger CI (the default `GITHUB_TOKEN` cannot, by GitHub's anti-recursion
   rule).
2. **Add a Trusted Publisher** to `tenjin-cli` on npmjs.com: provider GitHub
   Actions, organization `BackTrackCo`, repository `tenjin-agent`, workflow
   filename `release.yml`, environment `npm-publish`.
3. **Create a GitHub Environment named `npm-publish`** (Settings ->
   Environments), optionally with required reviewers to gate each publish.
