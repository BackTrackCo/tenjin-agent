# Experimental Jevgrep retrieval

Tenjin can discover repository search from a prompt, a Claude Code `Grep` call, or a recognized
read-only Bash `rg`/recursive `grep` search. Like paid WebSearch routing, the hook classifies
using the latest human task, bounded prior user/assistant conversation, and the proposed search.
The search pattern is evidence of the agent's next step, not the entire task.

When Jevgrep is selected, the hook tells Claude to make one visible `mcp__x402__request` call
before continuing eligible repository searches. If that deferred tool is not loaded, Claude
first discovers it with `ToolSearch` using `query: "select:mcp__x402__request"`. Claude writes a
focused natural-language repository question using its current task context, supplies the bound
offer id, and waits for the result. The executor receives that question unchanged. The hook does
not generate a query from the human prompt or execute a regex as a semantic question. Prompt
offers use the same request tool but remain a separate optional path; this handoff guard applies
to selected repository tool calls.

Supported compound Bash calls follow the same handoff. The hook explicitly says the entire
original command has not run and asks Claude to reissue that exact tool input, from the same
working directory, after the Jevgrep attempt succeeds or fails. This preserves the intended
`cd`, filters and companion operations without rewriting shell code. The retry stays native and
subject to normal permissions after the request finishes or the handoff is released. The agent
carries out the requested lookup and retry; the hook does not execute either on its behalf.
Literal search flags, bounded `head` filters, and a small allowlist of
read-only companions are recognized. Variables, substitutions, loops, writes, background jobs and
unsupported syntax stay native without routing. Filename-filter pipelines are not treated as
repository-content searches. Unknown subagents or subagents without access to the request tool
remain native.

Exact known lookups, uncommitted changes and no-upload requests should use native tools. Once a
repository-search offer is pending, retrying an eligible `Grep` or Bash search repeats the same
handoff and offer id without reclassification. A retry alone does not release it. Native search
resumes after the visible request returns, including an error or unavailable result, so incomplete
retrieval can fall back to native tools. The handoff also releases if its grant or snapshot changes,
its state cannot be read safely, or its lease expires: two minutes while awaiting the request,
and twenty minutes once it is running. Tool discovery cannot leave native search blocked forever;
if the tool never becomes available, the pending lease expires. Expiry never authorizes a payment
retry or clears an unresolved payment.

This guard covers recognized repository searches; it does not force every possible agent tool
path through Jevgrep or guarantee that the agent obeys the instruction. Unsupported searches and
known-file lookups retain their native behavior. No hook makes a hidden paid call.

For each agent turn, the repository tool hook admits at most three classifications and one offer.
The local executor atomically permits one attempt for that handoff, even when the agent changes
the question or calls concurrently. Main-agent, subagent and prompt offers are not one shared
attempt budget. Repeated identical snapshot/query requests in the session are also guarded.
The offer binds the committed snapshot; a changed commit requires a new offer. Source and wallet
permissions are checked again when the agent actually invokes the request.

This pilot requires Tenjin's matching server branch. [Jevgrep PR #28](https://github.com/dzhng/jevgrep/pull/28)
is merged, and the published `@dzhng/jevgrep@0.7.0` release is qualified for the native custom-provider
transport. Only that exact release is accepted; floating GitHub or npm specs are refused.
Previously reviewed local tarballs remain supported, including the original 0.4.2 pilot and the
0.4.4 custom-auth build. Existing grants retain their selected runtime until explicitly changed.

## Explicit setup

After approving disclosure to the chosen supplier, enable an explicit grant. For Maple:

```sh
tenjin jevgrep enable --root /absolute/repository --release 0.7.0 \
  --supplier maple-jev --max-run 0.05 --share-source --experimental
tenjin jevgrep status
```

This authorizes committed tracked source to `https://base.mapleai.shop/jev`.
Maple uses per-request x402 payments from the existing wallet, with no API key or prepaid account.
The legacy `--supplier jev-x402` remains the default when the option is omitted and authorizes
`https://jev-x402.vercel.app/jev`. Existing grants retain their supplier until explicitly replaced;
changing suppliers invalidates offers made under the previous grant.

A reviewed local artifact can instead use `--artifact /absolute/reviewed-jevgrep.tgz` and
`--sha256 REVIEWED_SHA256` together, without `--release`.

After enabling, run `tenjin install --refresh` and start a fresh Claude Code session at the
approved root so it loads the `Grep|Bash` hook and current MCP build. Ordinary `claude` uses this
hook; no special tool selection or Jevgrep prompt is required. Claude Code displays
“Calling x402” while the hook checks the proposed search, then a visible x402 request when Claude invokes retrieval. The spinner alone does not prove that a paid request occurred.

Claude Code can move a main-session MCP call to the background after two minutes. A slow
retrieval then keeps running while the agent continues, and its result can arrive after an answer.
For foreground testing in one repository, set
`env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` to `"0"` in that repository's ignored
`.claude/settings.local.json`, preserving its other keys, then start a fresh Claude session.
This controls timed backgrounding for every MCP tool in that repository, not only Jevgrep;
it does not disable Bash or agent background tasks. Tenjin does not set this globally.
See [Claude's MCP backgrounding documentation](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls).
When the MCP client supplies a progress token, retrieval reports its actual setup stages and
completed provider evaluation count. Cached answers do not count as new provider evaluations.
Progress is best effort: a failed notification cannot change payment or retry behavior.
A headless `claude -p` run normally has backgrounding disabled already; use
`CLAUDE_AUTO_BACKGROUND_TASKS=1` when testing interactive backgrounding behavior.

The personal grant is outside repository configuration. Project config cannot grant source access.
Start the host's MCP session at that exact repository root. Only that startup directory is authorized; other or unmatched roots stay native. The grant covers sessions at that root; it is
not a per-message confirmation. The underlying offer binding expires after 15 minutes; a selected
tool-call handoff must start within its shorter two-minute pending lease. An offer cannot be used
with another root or replacement grant. Calling `request` without a locally bound id cannot invoke
Jevgrep. Before enabling real payments, restart every host or payer sharing this wallet data directory so all MCP processes load the new build. An older running payer can discard the new durable ledger fields.

Only committed, tracked source is searched. Untracked files, working-tree edits, hidden paths,
symlinks, submodules, common generated paths and sensitive filenames/content are excluded.
This conservative filter is not a guarantee that a repository contains no confidential material;
source-sharing approval must cover the selected committed repository. Committed hierarchical `.gitignore` and `.ignore` rules apply. If relevant current rule files differ from the committed policy or cannot be safely checked, the search stays unavailable. Source is copied from Git
blobs to temporary private storage, never followed through live file paths. The standard profile allows 512 files,
128 KiB per file and 8 MiB total; the explicit extended profile raises only the per-file cap to 256 KiB. An oversized repository fails closed rather than searching an
undisclosed subset. Results name the snapshot commit and omitted-file count.

Tenjin runs fixed `npx` commands with isolated config and home. The pinned release downloads through
npm on first use and reuses its cache afterward; no separate global Jevgrep install is required.
Reviewed runtime artifacts and the npm cache persist under the active Tenjin data directory; source snapshots and credentials stay temporary. Auth writes only the
short-lived proxy token, then search uses that config. The normal Jevgrep configuration stays
unchanged. `npx` may download dependencies; it is not a sandbox. The reviewed child executes with
the OS user's privileges. Only trusted artifacts belong in this pilot. No extra skill install is required.

Tenjin also retains validated Jev answer scores across searches in
`jevgrep/answers` under the active Tenjin data directory. Cache identity includes the exact
native request (source, query, questions and model), the approved repository root and committed
snapshot, the exact runtime release or artifact hash, the selected supplier and the versioned
snapshot/transport policy, including the selected retrieval profile. A different proxy port or temporary child directory does not change
this identity. Different source, query, commit, root, runtime, supplier or policy cannot reuse an answer.
Legacy supplier entries are retained and remain readable; Maple uses a separate cache identity.
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

Source and native Jev questions go directly from the local adapter to the selected supplier. Tenjin's router
receives the normal bounded conversation packet, never repository source from this executor.
The legacy jev-x402 model is `jev-1.13.0`, on Base USDC, with recipient
`0xE813d34C0525E0fBb1e6478B86D40B83603C2008` and a maximum of $0.001 per evaluation.
Maple uses `jev-latest` at `https://base.mapleai.shop/jev`, paid per request in Base USDC to
`0x63db6eaf635a31bbc6714fe37bdc85243864f611`. Every live quote must fit the $0.01 per-evaluation
ceiling and the remaining approved search budget; this ceiling is not a fixed charge.
The adapter preserves native question IDs and serializes object or array state as JSON because
Maple requires string state. Although the request names `jev-latest`, the adapter accepts only
responses identifying the qualified model `jev-1.13.0`; a missing model, alias or other version
is rejected. Responses are checked against the original questions before caching or reuse.
The native adapter accepts up to 384 boolean questions, matching the qualified CLI’s
128-declaration batches with relevance, scope and reference questions. Existing byte limits still
apply; local validation errors report a bounded reason such as `question-count` and stop the run
as `invalid-request`, rather than attributing that refusal to the supplier.
Source-sharing consent covers Maple and the model provider processing the submitted source;
this integration does not claim zero retention or change provider privacy terms.
Changing these terms requires a reviewed client update and renewed applicable disclosure consent.
There is no automatic supplier fallback. This is a technical pilot; it adds no Tenjin routing fees.

A grant up to $0.05 retains the standard profile: 16 concurrent evaluations, 60 uncached
evaluations, 128 KiB per request, 2 MiB of uncached request bytes and a 60-second search deadline.
Explicitly granting more than $0.05, up to $1, selects the extended profile: 16 concurrent
evaluations, 1,000 uncached evaluations, 256 KiB per request, 64 MiB total request bytes and a
900-second search deadline. These are ceilings, not targets; the approved money cap may stop
a search earlier. Runtime setup retains a 60-second deadline in either profile. Cached answers consume neither paid-request nor supplier-egress
allowance. Supplier request-byte limits count the adapted outbound JSON, including any extra escaping
needed for Maple's string state. The local child separately stops at 4,096 requests or 64 MiB of loopback input, including
cache hits, and the per-request bound still applies before lookup. Its exposure cap is the lower of the approved search budget and `maxAutoSpend`, at most $1.
Each evaluation also uses the existing shared daily wallet policy, so concurrent searches cannot
spend the same remaining allowance. Returned source is bounded to 16 KiB; total output is 16 KiB
for the standard profile and 32 KiB for the extended profile. Changing the retrieval grant does
not raise the normal wallet limits. In-flight payments are aborted and drained before the final
summary; an undrained operation cannot be reported as fulfilled. A stopped search reports partial/failed/cancelled
with its reason. It must never be interpreted as proof that no matches exist.

Repeated identical evaluations within the same run reuse validated responses or join an active
attempt. An unresolved attempt cannot sign a replacement. A failure before any signature (a dropped
connection, a supplier 408, 429 or 5xx, or an unreadable balance) left no money in flight, so the
loopback proxy answers Jevgrep with 429 and the child retries after its own back-off; the same
evaluation is admitted again under its existing journal entry. After 32 such failures in one search
the stop is reported as `provider`. A failure after signing (for example a supplier 429 on the paid
request) keeps its `uncertain` record and never gets a replacement payment. The proxy answers that
one request with 429 and `Retry-After: 2`, the child's retry of the same request is refused as
unresolved with 503, and the child narrows or drops that batch while other evaluations continue.
After 16 uncertain failures in one search, or at the first settlement refusal that names the
supplier's own facilitator billing or an empty wallet, the stop is reported as `payment_uncertain`.
Every evaluation in a run shares one wallet balance read, refreshed after thirty seconds; the
ledger bounds spending, the read only refuses signing against an empty wallet. The shared spend ledger retains
reserved and signed exposure across restarts and rolling-window expiry. A signed evaluation that
the supplier answers with a valid response settles at that moment: its money joins the current
daily window like any other payment and expires with it, and the result reports it as
`settledAtomic`. A signed evaluation with no validated response stays `unknownAtomic` and charges
every later window until it is resolved. `confirmedAtomic` remains zero because this pilot does
not independently reconcile chain settlement; a provider's answer is the evidence, not the chain.
No automatic refund or recovery is claimed. Private payment records hold hashes, terms and
bounded answers, not source, signatures or wallet keys.

The journal refuses more than 256 saved runs or 4,096 durable entries. Settled records older than
the window fold into one record per run, keeping their total and count; unresolved money is never
evicted or folded to regain availability. A ledger written before settlement tracking holds every
answered evaluation as unresolved, which consumes the daily budget permanently: `tenjin jevgrep
reconcile` reports how many of those have a validated response in the journal, and
`tenjin jevgrep reconcile --apply` settles exactly those into the current window. Reconciliation and retention are release gates, as are supplier
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

The [published-release qualification](./jevgrep-release-qualification.json) records actual pinned
`npx` auth and search on macOS with Node 24.18.0. After warming npm's isolated cache with lifecycle
scripts disabled, both commands ran with npm offline and child fetch restricted to loopback.
Search completed in 1.862 seconds with seven mock evaluations; both returned TypeScript source
blocks exactly matched the two-file committed fixture. The 25 focused grant/runner tests and
TypeScript checking passed. This proves packaging, transport and source formatting only; no model,
wallet or payment calls occurred, and synthetic scores do not measure retrieval quality.

Published `@dzhng/jevgrep@0.7.0` uses the native `{model,state,questions}` request and matching
`noul` response through a custom provider. Its custom-provider requests have a 15-second upstream
timeout and do not enable the token-aware pacing reserved for upstream's `typesafe` provider.
Tenjin passes Jevgrep 16 concurrent evaluations, and the loopback proxy answers 429 above that; every evaluation is still reserved against the search cap before dispatch, so concurrency changes wall-clock time, not exposure. Measured against the Maple supplier on 2026-09-30, 16 in flight gave a 2.5 s median evaluation and 3.3 evaluations per second, while Jevgrep's own default of 32 gave a 7.6 s median, dropped paid connections and lower throughput. The reviewed 0.4.4 local build retains its explicit
`tenjin-x402` pacing profile and 60-second request timeout; that fork-specific auth option is
omitted for the published release. Search deadlines and payment caps remain Tenjin's own bounds.

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
