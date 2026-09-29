# Experimental Jevgrep retrieval

Tenjin can discover repository search from a prompt or an eligible Claude Code `Grep` call.
The prompt path offers the existing MCP `request` tool. The `tenjin hook repository` tool hook
asks the same router to classify the proposed search, then invokes the local executor directly
when Jevgrep is selected. Only completed, validated source can replace the pending grep; partial,
empty, failed or unavailable retrieval leaves native search available. Shell commands remain native.
Exact known lookups, uncommitted changes and no-upload requests should use native tools.
The hook admits at most three classification attempts and one retrieval attempt per human turn.
Durable attempt markers prevent duplicate hook delivery or concurrent calls from paying again.

This pilot requires Tenjin's matching server branch and a reviewed npm tarball built from
[Jevgrep PR #28](https://github.com/dzhng/jevgrep/pull/28). Reviewed local artifacts include the original 0.4.2 pilot and the qualified 0.4.4 custom-auth
build; the npm version alone does not select their code. The release allowlist is empty until a
published artifact with custom auth passes qualification. Do not use a floating GitHub or npm spec.

## Explicit setup

After reviewing the artifact and approving disclosure to `https://jev-x402.vercel.app/jev`:

```sh
tenjin jevgrep enable --root /absolute/repository --artifact /absolute/reviewed-jevgrep.tgz \
  --sha256 REVIEWED_SHA256 --max-run 0.05 --share-source --experimental
tenjin jevgrep status
```

After enabling, run `tenjin install --refresh` and start a fresh Claude Code session at the
approved root so it loads the `Grep` hook and current MCP build.

The personal grant is outside repository configuration. Project config cannot grant source access.
Start the host's MCP session at that exact repository root. Only that startup directory is authorized; other or unmatched roots stay native. The grant covers sessions at that root; it is
not a per-message confirmation. A fresh hook offer expires after 15 minutes and cannot be used
with another root or replacement grant. Calling `request` without a locally bound id cannot invoke
Jevgrep. Before enabling real payments, restart every host or payer sharing this wallet data directory so all MCP processes load the new build. An older running payer can discard the new durable ledger fields.

Only committed, tracked source is searched. Untracked files, working-tree edits, hidden paths,
symlinks, submodules, common generated paths and sensitive filenames/content are excluded.
This conservative filter is not a guarantee that a repository contains no confidential material;
source-sharing approval must cover the selected committed repository. Committed hierarchical `.gitignore` and `.ignore` rules apply. If relevant current rule files differ from the committed policy or cannot be safely checked, the search stays unavailable. Source is copied from Git
blobs to temporary private storage, never followed through live file paths. The standard profile allows 512 files,
128 KiB per file and 8 MiB total; the explicit extended profile raises only the per-file cap to 256 KiB. An oversized repository fails closed rather than searching an
undisclosed subset. Results name the snapshot commit and omitted-file count.

Tenjin runs fixed `npx` commands with isolated config and home. Reviewed runtime artifacts and their npm cache persist under the active Tenjin data directory; source snapshots and credentials stay temporary. Auth writes only the
short-lived proxy token, then search uses that config. The normal Jevgrep configuration stays
unchanged. `npx` may download dependencies; it is not a sandbox. The reviewed child executes with
the OS user's privileges. Only trusted artifacts belong in this pilot. No extra skill install is required.

Tenjin also retains validated Jev answer scores across searches in
`jevgrep/answers` under the active Tenjin data directory. Cache identity includes the exact
native request (source, query, questions and model), the approved repository root and committed
snapshot, the exact runtime release or artifact hash, the fixed supplier and the versioned
snapshot/transport policy, including the selected retrieval profile. A different proxy port or temporary child directory does not change
this identity. Different source, query, commit, root, runtime or policy cannot reuse an answer.
Current grants and source/ignore-policy checks still run before cache access.

This answer cache stores only hashes, timestamps and numeric scores in private files; even question
IDs are reconstructed from the matching request rather than saved. It retains at most 2,048 entries
and 32 MiB, expires answers after seven days, and validates each bounded record before reuse.
Corrupt, mismatched, expired, unsafe or unavailable records are cache misses. Atomic writes and a
short shared write lock keep concurrent publication and retention bounded. A crashed writer lock
disables new cache writes until recovery but does not block valid reads or authorize payment.
Simultaneous misses in separate processes may each use their own approved search budget; this
cache does not change payment-journal recovery or promise cross-run payment deduplication.

The upstream CLI still receives `--no-cache`: its cache lives in temporary storage and keys on the
changing proxy URL. Tenjin owns persistent answer reuse before paid admission. Result `requests`
counts evaluations admitted to the payer; `cacheHits` counts answers served from this cache.
Removing disposable answer files loses reuse only; never remove payment records to clear a cache.

## Provider and spending

Source and native Jev questions go directly from the local adapter to jev-x402. Tenjin's router
receives the normal bounded conversation packet, never repository source from this executor.
The fixed model is `jev-1.13.0`, on Base USDC, with recipient
`0xE813d34C0525E0fBb1e6478B86D40B83603C2008` and a maximum of $0.001 per evaluation.
Changing these terms requires a reviewed client update and renewed applicable disclosure consent.
There is no automatic supplier fallback. This is a technical pilot; it adds no Tenjin routing fees.

A grant up to $0.05 retains the standard profile: two concurrent evaluations, 60 uncached
evaluations, 128 KiB per request, 2 MiB of uncached request bytes and a 60-second search deadline.
Explicitly granting more than $0.05, up to $1, selects the extended profile: two concurrent
evaluations, 1,000 uncached evaluations, 256 KiB per request, 64 MiB total request bytes and a
900-second search deadline. These are ceilings, not targets; the approved money cap may stop
a search earlier. Runtime setup retains a 60-second deadline in either profile. Cached answers consume neither paid-request nor supplier-egress
allowance. The local child separately stops at 4,096 requests or 64 MiB of loopback input, including
cache hits, and the per-request bound still applies before lookup. Its exposure cap is the lower of the approved search budget and `maxAutoSpend`, at most $1.
Each evaluation also uses the existing shared daily wallet policy, so concurrent searches cannot
spend the same remaining allowance. Returned source is bounded to 16 KiB; total output is 16 KiB
for the standard profile and 32 KiB for the extended profile. Changing the retrieval grant does
not raise the normal wallet limits. In-flight payments are aborted and drained before the final
summary; an undrained operation cannot be reported as fulfilled. A stopped search reports partial/failed/cancelled
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

Exact-symbol, no-upload and native Grep controls stayed native. Those earlier pilot results used the standard profile; raising an explicit grant does not
retroactively turn partial results into complete retrieval. Local trials must still demonstrate
useful evidence and task outcomes within their approved budget. Do not interpret partial leads as proof that no other matches exist.
