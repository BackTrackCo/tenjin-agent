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

**Version grammar.** Versions must be `X.Y.Z` or `X.Y.Z-alpha.N`, the only
shapes installed runtimes read on `latest` (`VERSION_RE` in
`src/lib/version-order.ts`). Any other version there strands every one of
them: their daily update throws on it and installs refuse it, and tenjin.sh
serves no installer for it. So never hand-edit the version PR to another
prerelease (`-beta.1`, `-rc.1`); to leave alpha, run `changeset pre exit`,
which makes the next version a plain `X.Y.Z`. `src/lib/version-order.test.ts`
fails CI on any other version. It checks the version against a frozen copy of
the shipped grammar, not `VERSION_RE` itself, because widening `VERSION_RE`
helps only once a build carrying it has reached users; widen the copy only
then.

**Updater contract.** Every installed copy fetches the next version with its own
code, not the new release's. So the update side must stay compatible once
shipped: `src/lib/auto-update.ts`, the runtime branch of
`src/commands/update.ts`, `src/lib/runtime.ts` (`checkReleaseProvenance`,
`stageTarball`, `readNodePin`, `ensureNode`, `placeVersion`),
`src/lib/runtime-layout.ts`, `src/lib/runtime-fetch.ts`,
`src/lib/version-order.ts`, and the `install --refresh` entry the old build
spawns the new one with. So must what the old build reads from the new
release: `package.json` `tenjinRuntime.node` (an `X.Y.Z` Node version and a
sha256 for every platform key shipped builds support; never drop a key or
change the shape), the `dist/index.js` entry, and `state.json`, which the new
build writes and the old one reads back to confirm the switch. A release that
breaks any of it strands users until they reinstall by hand. That is also why
the Claude Code session-start leg starts the update in a `finally`: a build
whose leg throws still starts the update that can replace it.

**Hooks and server across versions.** Claude Code and Codex both start the
auto-update as a session starts. An open session's MCP server stays on the old
version while the launcher moves to the new one, so with two sessions open the
old and new versions run side by side. Whatever a hook hands the server (offer files
under the data dir, the `request` tool's fields the hook line tells the model to
fill) should stay readable across adjacent versions. `config.json` and
`spend.json` must stay readable by the previous release: new fields optional,
no `schemaVersion` bump. The offer files under `progress/specs` are read with
strict schemas, so even a new field makes the previous release reject the
file; add one only after a release whose schema accepts it has shipped.

To cut a release (two clicks):

1. **Dispatch (click 1)**: Actions -> Release -> Run workflow -> `main`. The
   `version` job runs `changeset version` (consumes `.changeset/*.md`, bumps
   `package.json`, regenerates `CHANGELOG.md`) and opens the
   **"chore(release): version packages"** PR. Nothing is published yet.
2. **Review and merge** that PR (its final state is what ships; edit the
   changelog directly if needed, and the version only within the grammar
   above). Its CI fails on any high `pnpm audit` advisory, the same check the
   publish gate runs: merge the `bot/audit-fix` PR that the daily `audit`
   workflow opens (or dispatch that workflow to open one), then update the
   version PR from `main`.
3. **Dispatch (click 2)**: same path. With no pending changesets, the `publish`
   job builds, runs the check suite plus `pnpm audit` plus the packed-artifact
   and installer smokes as a pre-publish gate, then `changeset publish` ships
   `tenjin-cli` with provenance and creates the GitHub release, which carries
   the release notes only. Publishes land on the `latest` dist-tag only because
   every version published so far is an alpha. In pre mode, the pinned
   changesets (`getReleaseTag` in `@changesets/cli`) publishes to `latest`
   while every published version's prerelease id equals `.changeset/pre.json`'s
   `"tag"`, and to that tag otherwise. So `changeset pre enter beta` would
   publish to a `beta` tag, and once a plain `X.Y.Z` has shipped, a later
   `changeset pre enter alpha` publishes to `alpha`, not `latest`. The CLI
   updater resolves against `latest` alone, so publish tagging and
   `src/lib/update-check.ts` must change together.

**Installers.** tenjin.sh builds `install.sh` and `install.ps1` from npm's
`latest`, with no copy of its own: it requires that version's npm provenance to
name `release.yml` on `refs/heads/main`, checks the tarball against its sha512,
reads the templates at `package/scripts/installers`, and takes the Node pins
from the tarball's own `package.json`, never from the registry's version
document. It fills the templates exactly as `scripts/build-installers.mjs`
does. The five tokens (`@CLI_VERSION@`, `@CLI_SHA512@`, `@NODE_VERSION@`,
`@NODE_CHECKSUM_CASES@`, `@NODE_POWERSHELL_HASHES@`) are a contract with the
website, which refuses a template carrying any other: a new token lands on the
website first, and in a template only after that has deployed. A release
without templates makes tenjin.sh return 503; the packed-artifact smoke refuses
to publish one. Renaming `release.yml` or releasing from another branch
strands every updater (see What the updater trusts, below) and 503s the
installer.

To inspect a candidate locally, build, pack, then run
`node scripts/build-installers.mjs <candidate.tgz> <output-dir>`. Candidate
packages are fixtures; do not serve their scripts as an already-published npm
version. `node scripts/installer-smoke.mjs` exercises generated scripts with
isolated download fixtures, including corrupt downloads and profile refusal.

Auth is npm Trusted Publishing (OIDC): each publish mints a short-lived, per-run
token, so there is **no `NPM_TOKEN`** to store or rotate.

## Pausing a bad release

**What the updater trusts.** `tenjin update` and the background auto-update
install a release only when its npm provenance names exactly
`BackTrackCo/tenjin-agent`, `.github/workflows/release.yml` and
`refs/heads/main` (`RELEASE_WORKFLOW` in `src/lib/runtime.ts`), whether the
update downloads it into the runtime or has npm install it (an npm mirror the
user configured is outside that check). Every CLI since that check shipped
carries the triple, so a release published any other way (a manual
`npm publish`, a renamed workflow file, another branch) is refused by every
updater that has the check. 0.1.0-alpha.32 and older check neither provenance
nor age, and take a new `latest` at their next daily run. Changing the triple
means shipping the new one first and waiting for adoption. Provenance cannot catch a compromised release workflow, so the
background run also waits until a release is 24 hours old before taking it. A
manual `tenjin update` does not wait.

To pull a bad release inside that day, point `latest` back at the last good
version that ships `scripts/installers` (needs an npm owner of `tenjin-cli`):

```sh
npm dist-tag add tenjin-cli@<last good version> latest
```

- Background updates stop taking the bad version at their next daily check.
  Machines already on it, by a manual `tenjin update` or after the 24 hours,
  stay there until a higher, fixed version ships, because updates never
  downgrade.
- tenjin.sh follows within about an hour, as its cached installer expires. To
  make it immediate, redeploy, or Purge CDN Cache in Vercel. A version without
  `scripts/installers` there makes it return 503.
- Never unpublish: fix forward with a new release through `release.yml`.

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
   filename `release.yml`, environment `npm-publish`. Then set the package's
   **Publishing access** to "Require two-factor authentication and disallow
   tokens"; Trusted Publishing keeps working under it, and no token can
   publish. An owner can still publish by hand with 2FA; updaters refuse that
   release for lack of provenance.
3. **Create a GitHub Environment named `npm-publish`** (Settings ->
   Environments) with its deployment branches limited to `main` and required
   reviewers to gate each publish. Trusted Publishing does not check the
   branch, so this is what keeps a dispatch from another branch from
   publishing.
