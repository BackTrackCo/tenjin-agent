# Experimental Jevgrep retrieval

The hook can offer semantic source discovery when the relevant files or symbols are unknown.
A fresh offer's `id` lets the existing MCP `request` tool execute it. Native grep and reads remain
available. Exact symbols, known files, uncommitted changes and no-upload requests should use them.

This pilot requires Tenjin's matching server branch and a reviewed npm tarball built from
[Jevgrep PR #28](https://github.com/dzhng/jevgrep/pull/28). That branch still identifies itself as
0.4.2, so the npm version alone does not select its code. The release allowlist is empty until a
published artifact with custom auth passes qualification. Do not use a floating GitHub or npm spec.

## Explicit setup

After reviewing the artifact and approving disclosure to `https://jev-x402.vercel.app/jev`:

```sh
tenjin jevgrep enable --root /absolute/repository --artifact /absolute/reviewed-jevgrep.tgz \
  --sha256 REVIEWED_SHA256 --max-run 0.05 --share-source --experimental
tenjin jevgrep status
```

The personal grant is outside repository configuration. Project config cannot grant source access.
Start the host's MCP session at that exact repository root. Only that startup directory is authorized; other or unmatched roots stay native. The grant covers sessions at that root; it is
not a per-message confirmation. A fresh hook offer expires after 15 minutes and cannot be used
with another root or replacement grant. Calling `request` without a locally bound id cannot invoke
Jevgrep. Before enabling real payments, restart every host or payer sharing this wallet data directory so all MCP processes load the new build. An older running payer can discard the new durable ledger fields.

Only committed, tracked source is searched. Untracked files, working-tree edits, hidden paths,
symlinks, submodules, common generated paths and sensitive filenames/content are excluded.
This conservative filter is not a guarantee that a repository contains no confidential material;
source-sharing approval must cover the selected committed repository. Committed hierarchical `.gitignore` and `.ignore` rules apply. If relevant current rule files differ from the committed policy or cannot be safely checked, the search stays unavailable. Source is copied from Git
blobs to temporary private storage, never followed through live file paths. Limits are 512 files,
128 KiB per file and 8 MiB total. An oversized repository fails closed rather than searching an
undisclosed subset. Results name the snapshot commit and omitted-file count.

Tenjin runs fixed `npx` commands with isolated config, home and caches. Auth writes only the
short-lived proxy token, then search uses that config. The normal Jevgrep configuration stays
unchanged. `npx` may download dependencies; it is not a sandbox. The reviewed child executes with
the OS user's privileges. Only trusted artifacts belong in this pilot. No extra skill install is required.

## Provider and spending

Source and native Jev questions go directly from the local adapter to jev-x402. Tenjin's router
receives the normal bounded conversation packet, never repository source from this executor.
The fixed model is `jev-1.13.0`, on Base USDC, with recipient
`0xE813d34C0525E0fBb1e6478B86D40B83603C2008` and a maximum of $0.001 per evaluation.
Changing these terms requires a reviewed client update and renewed applicable disclosure consent.
There is no automatic supplier fallback. This is a technical pilot; it adds no Tenjin routing fees.

A search admits at most two concurrent evaluations, 60 evaluations, 128 KiB per request and
2 MiB total request bytes. Its exposure cap is the lower of the approved search budget and `maxAutoSpend`, at most $0.05. Each evaluation also uses the existing shared daily wallet policy, so concurrent searches cannot spend the same remaining allowance. Setup and search each have a 60-second
limit; returned source is bounded to 16 KiB. A stopped search reports partial/failed/cancelled
with its reason. It must never be interpreted as proof that no matches exist.

Repeated identical evaluations within the same run reuse validated responses or join an active
attempt. An unresolved attempt cannot sign a replacement. The shared spend ledger retains
reserved and signed exposure across restarts and rolling-window expiry. `confirmedAtomic`
currently remains zero because this pilot does not independently reconcile chain settlement;
`unknownAtomic` reports signed exposure, including successful provider responses. The result
reports these separately. No automatic refund or recovery is claimed. Private payment records
hold hashes, terms and bounded answers, not source, signatures or wallet keys.

The journal refuses more than 256 saved runs or 4,096 durable entries. It never evicts unresolved
money to regain availability. Reconciliation and retention are release gates, as are supplier
source terms, completed retrieval value and a qualified upstream release. This is not a production
activation path for private code without that review.

## Rollback

```sh
tenjin jevgrep disable
```

This withdraws offers and blocks future searches while retaining the payment journal and native
tools. Disabling during a search does not retract requests already admitted; cancellation ends
the active child and stops new admissions. Do not erase the ledger/journal or run an older payer
against it after a real payment. Older binaries cannot preserve this new durable exposure model.
If no retrieval payments occurred, restoring a saved prior CLI package is safe.

## Recorded upstream compatibility

The [sanitized qualification record](./jevgrep-qualification.json) covers PR #28 at commit
`aae1f7ee91f6cfe408e1cca5c50bd4c9ddc81164`, built with Bun 1.3.14 and tested with
Node 24.21.0 in an isolated Linux arm64 environment. Actual offline `npx` auth, doctor,
TypeScript/Python searches, token handling, repeated 402 errors and SIGINT cleanup passed
against a synthetic provider. This is packaging and transport evidence, not a live paid
retrieval benchmark or permission to execute an unmerged artifact on another host.

## Live local pilot

The [sanitized live record](./jevgrep-live-pilot.json) covers an explicitly approved public
`tenjin-agent` checkout through the actual installed prompt hook and stdio MCP tool, with a local
branch backend and isolated local database. The third trial offered retrieval in 698 ms, validated
50 paid evaluations, and stopped after 51.531 seconds at the unchanged $0.05 search cap. The
414-file repository query returned partial file leads, not a completed or quality-qualified answer.

An earlier trial exposed an intermittent balance-read failure on the default Base RPC. The local
pilot switched the existing `rpcUrl` setting to the repository-documented PublicNode Base endpoint;
no balance check or spending limit was bypassed. Terminal proxy failures now return 409 instead of
misleading authentication errors, and the private journal retains only allowlisted diagnostic codes,
HTTP status and execution phase. All three trials retained $0.063 total signed exposure and zero
outstanding reservations. Chain settlement remains unreconciled.

Exact-symbol, no-upload and native Grep controls stayed native. Before treating this pilot as useful
for repository-wide discovery, narrow its search scope and demonstrate completed retrieval within
the approved budget. Do not interpret partial leads as proof that no other matches exist.
