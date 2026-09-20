# Local Jev → x402 experiment

This draft routes ordinary research, page-reading and price requests through a local `PreToolUse` hook. Jev selects a capability and its arguments; code validates the request, authorization, quote and budget, then pays and executes. A tiny local stdio MCP bridge returns the saved result as a successful tool response. It has no hosted backend and cannot route, sign or call a provider itself.

The prepared demo uses three hand-selected, unchanged CDP Bazaar listings: Exa search, Firecrawl scraping advertised by Vaaya, and direct CoinMarketCap quotes. Claude sees only generic `search` and `fetch` tools. Provider selection still happens in Jev. This demonstrates routing within that catalog, not automatic discovery across the entire Bazaar.

Jev receives the pending request and bounded user/assistant text from the current session, including prior answers and corrections. Its choice API selects exact available values and bounded list compositions; it cannot generate arbitrary new arguments. A missing value returns `needs_input`. Payment authorization is deterministic and automatic within the local policy. Claude interprets the returned content and decides how to continue.

## Run the prepared demo

Use the directory and resolved launch command supplied by the setup agent. Preserve its existing policy and ledger; starting a new conversation does not require initializing another payment budget.

For an already prepared directory at `/tmp/tenjin-auto-live`, open your terminal and run:

```sh
cd /tmp/tenjin-auto-live
claude --model sonnet \
  --permission-mode auto --tools '' \
  --settings /tmp/tenjin-auto-live/bridge-settings.json \
  --mcp-config /tmp/tenjin-auto-live/mcp.json \
  --setting-sources '' --strict-mcp-config \
  --disable-slash-commands --no-chrome
```

This opens an **empty interactive conversation**: no initial prompt, `-p`, `--continue`, or `--resume`. Complete any startup trust/login screen and verify Sonnet and auto mode in the UI. [Native auto mode requires a supported model and account configuration](https://code.claude.com/docs/en/permission-modes#eliminate-permission-prompts-with-auto-mode); Haiku is unsupported. If auto is unavailable, report that limitation rather than silently calling manual mode “auto.” Native permission mode and the x402 spending policy are separate controls.

Only the two local x402 tools and their hook are configured. Normal user/project settings, other MCP servers, slash commands and skills are excluded by these flags. Managed settings still apply. Do not use safe/bare mode or disable hooks: the bridge needs the hook to obtain a result. Keep normal session persistence enabled so Jev can read the transcript. Exiting Claude closes the child stdio bridge; no server is left running.

### What to say in the empty session

First:

```text
Compare BTC and ETH for someone new to crypto
```

After the answer:

```text
Check price for both now
```

The second request relies on the conversation for “both,” asks for current prices, and names no service or tool. The comparison can be answered from Claude’s existing knowledge; it establishes context, so a paid call is not required on that turn. A hook can only run when Claude requests a tool. The earlier market-cap → “their prices” pair sometimes led Claude to reuse prices already returned in the first answer; that was not a second routing demonstration. The comparison opener avoids asking for market data before the price follow-up. It does not hide fields in the first response to manufacture a reason for another call.

If you use the market-cap opener instead, “Check fresh quotes for both now” makes a new observation explicit when the first answer already contains prices. Check the saved outcomes to establish that a new request actually occurred. A new HTTP fetch does not guarantee the provider updated its market data after the user asked; show the provider's quote timestamps honestly.

Additional natural tasks:

```text
Find two authoritative explanations of how x402 payments work. Link both sources and briefly explain what each covers.
```

```text
Summarize this page in two sentences and link to it: https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works
```

A successful tool response starts with a short receipt identifying the actual supplying service/host, selected parameters and USDC amount. Long parameters are abbreviated there; full arguments remain in local outcomes. The bounded result envelope includes provider provenance and marks provider content as untrusted. Vaaya's listing advertises Firecrawl; that does not independently attest its backend implementation. Failed, refused or unresolved calls remain errors.

The legacy hook-only transport denied Claude's native search/fetch after fulfilling the paid request; Claude rendered that as red `Error`. The bridge instead lets a local result carrier complete successfully. [PreToolUse supports input updates and permission decisions](https://code.claude.com/docs/en/hooks#pretooluse-decision-control), not successful native-tool result replacement. PostToolUse replacement runs after the original tool has already executed, so it would duplicate work here.

Tested provider prices were $0.007 Exa, $0.01 Vaaya and $0.01 CoinMarketCap per call. Every live quote must still pass the current listing and policy checks. Jev and Claude inference are separate costs. The interactive session does not inherit the headless runner's inference/turn caps. The local policy caps payments at $0.10/call and $1/run, with a 24-hour expiry established at initialization.

### Inspect after the demo

Ask the separate setup-agent conversation:

```text
Inspect the latest demo's saved outcomes in /tmp/tenjin-auto-live without
making new provider requests. Show each selected service, exact arguments,
amount, result status and settlement status. For the fresh-quotes follow-up,
verify a new tool-use ID, uncached provider response, quote timestamps and
prices matching the final answer. Distinguish fresh retrieval from the age
of the provider data. Report missing evidence, citations or errors honestly.
Do not print credentials, receipt tokens or signed payment payloads.
```

Interactive calls write `state/outcomes/`, `state/events.jsonl`, `state/bridge-receipts/` and the payment ledger. Claude keeps its session transcript. `runs/<session>/` belongs to headless validation only. These files may contain private task data and stay local. Receipt files are private, expire after ten minutes, and are bound to the tool and request arguments; the bridge returns an error for a missing, altered or expired receipt. A failed/missing hook cannot cause the bridge to make a payment. Retain the ledger for reconciliation; never clear it to renew spending authority.

## Agent-assisted preparation (separate from presentation)

Paste this into a separate coding-agent conversation. The agent performs setup and hands you the empty-session launch command; none of this goes into the presentation conversation.

```text
Prepare the local Jev → x402 demo from BackTrackCo/tenjin-agent draft PR #369,
branch codex/local-jev-x402-auto-mode. Read docs/auto-mode.md and repository
instructions. Reuse the owned checkout if available; otherwise use an isolated
worktree/clone and preserve other work. Build frozen dependencies and check
Node, pnpm, Claude Code and the existing Claude login. Use Sonnet with native
auto mode; no Fable. Verify auto is actually active in the fixture preflight.

Use the existing Jev env file and funded Tenjin wallet. In the Tenjin workspace,
look for tenjin/.env.local; the default wallet directory is ~/.tenjin. Check
presence only. Never print/copy credentials, export the entire env file, create
a new wallet, or change global Claude settings. Ask only for an unresolved
path, login or funding prerequisite.

Run the synthetic bridge preflight below headlessly, without provider payments.
Preserve a valid existing demo's policy and ledger. For an explicitly new run,
initialize a directory outside the repository with automatic payments limited
to $0.10/call, $1 total, 24 hours, and exactly these resources:
- POST https://api.exa.ai/search
- POST https://vaaya.ai/api/run/firecrawl/scrape
- GET https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest

Create catalog.json from the unchanged resources in
src/experimental/auto-mode/fixtures/cdp-demo-resources.json and the resource in
cdp-cmc-resource.json. Preserve source/capture provenance. Pass --catalog-file
and leave discoveryQueries empty. This is a hand-selected Bazaar catalog.
Reference the env and wallet in place. Never reset a ledger or silently renew
an expired policy. Run bridge-setup on the config to create only isolated
bridge settings and MCP configuration. Verify paths, scope, caps and expiry.

Finish with ONE copy-paste command using real absolute paths to open a fresh,
empty interactive Sonnet session in auto mode, using the flags above. No -p,
resume/continue or initial prompt; do not open the actual demo yourself. Give
me the natural dialogue above. Keep setup and test evidence separate from what
I should type in that empty session. Do not run paid presentation prompts
unless I have asked you to validate them.
```

Requirements: Node 24+, pnpm, authenticated Claude Code supporting Sonnet auto mode, a Jev credential (`TYPESAFE_KEY` or `TYPESAFE_API_KEY`) and a funded Tenjin local wallet. An existing login or wallet funding may need human action; the agent should identify the exact missing prerequisite.

### Commands for the setup agent

Run from the PR checkout with resolved paths. New initialization refuses to overwrite an existing config.

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/tenjin-auto-mode.mjs init --directory /tmp/tenjin-auto-fixture
node dist/tenjin-auto-mode.mjs bridge-setup --config /tmp/tenjin-auto-fixture/config.json
node scripts/auto-mode-demo.mjs --transport bridge --model sonnet \
  --config /tmp/tenjin-auto-fixture/config.json \
  --prompt 'This is a synthetic transport test. Search for the Northstar archive verification code, then quote the synthetic code and link its supplied fixture URL. Do not treat it as real research.'
```

Create the local catalog before initializing a new authorized live run:

```js
// Run as an ES module from the checkout; replace the directory as needed.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const directory = '/tmp/tenjin-auto-live';
const base = 'src/experimental/auto-mode/fixtures/';
const demo = JSON.parse(await readFile(base + 'cdp-demo-resources.json', 'utf8'));
const cmc = JSON.parse(await readFile(base + 'cdp-cmc-resource.json', 'utf8'));
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(
  `${directory}/catalog.json`,
  JSON.stringify(
    {
      source: demo.source,
      fetchedAt: demo.fetchedAt,
      resources: [...demo.resources, cmc.resource],
    },
    null,
    2,
  ),
  { flag: 'wx', mode: 0o600 },
);
```

```sh
node dist/tenjin-auto-mode.mjs init \
  --directory /tmp/tenjin-auto-live --mode live \
  --env-file /absolute/path/to/existing.env --wallet-dir /absolute/path/to/existing/wallet \
  --catalog-file /tmp/tenjin-auto-live/catalog.json \
  --allow-resource POST:https://api.exa.ai/search POST:https://vaaya.ai/api/run/firecrawl/scrape GET:https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest
node dist/tenjin-auto-mode.mjs bridge-setup --config /tmp/tenjin-auto-live/config.json
```

For an existing prepared run, use **only `bridge-setup`** to add/update the bridge configuration. It does not change config, policy, ledger, catalog or the legacy native settings. The bridge starts as Claude's child process and reads config without importing credentials from the env file. The hook separately loads only the required Jev/wallet credential keys.

## Validation

The bridge harness checks actual auto mode and model identity, absence of native search/fetch, one to eight distinct MCP calls, successful corresponding tool results, current-event fulfilled outcomes, HTTP 200, valid amounts, receipt provenance/parameters and a final citation to a returned URL or supplying endpoint. It saves streams/reports and closes the Claude process group. Missing citations remain failed checks. Optional `--session-id <uuid>` then `--resume <same-uuid>` supports two-turn headless validation; the actual presentation starts empty without either flag.

```sh
node scripts/auto-mode-demo.mjs --transport bridge --model sonnet \
  --config /tmp/tenjin-auto-live/config.json \
  --prompt 'Find two authoritative explanations of how x402 payments work. Link both sources and briefly explain what each covers.'
```

This opt-in live command can make multiple paid calls. It uses a 180-second timeout, eight-turn limit and $0.50 Claude inference cap per invocation, plus the shared payment policy. It does not impose those inference limits on the interactive launch. The legacy native harness remains available with `--transport native --model haiku --tool auto`; it deliberately expects tool denials and uses `dontAsk` plus native `ask` rules for fallback protection.

Focused local checks:

```sh
pnpm exec vitest run src/experimental/auto-mode --maxWorkers 2
pnpm test:auto-mode-harness
# In a managed workspace, use its scripts/check --path . for static/package checks.
```

### Bridge validation on 2026-09-20

Claude Code 2.1.278 initialized `claude-sonnet-5` with `permissionMode: auto`. The synthetic fixture passed all 20 bridge gates without provider payment. The exact x402 research prompt made one Exa and two Vaaya calls, all returned successful tool results, and both final source links matched returned URLs: all 20 gates passed, $0.027 USDC. The first run of the checker mishandled an omitted `cached` flag; saved streams were regraded offline after fixing that test harness, without new paid calls.

The two-turn network-comparison → fresh-quotes dialogue used one persisted Sonnet session. The first turn made two Exa and two Vaaya calls ($0.034); the follow-up made two new, uncached CoinMarketCap requests, both with exactly `symbol=BTC,ETH` ($0.02). Both turns used normal successful MCP results. The first passed all 20 gates. The follow-up passed all 18 execution/receipt gates but failed the two citation gates: Sonnet named CoinMarketCap and printed its endpoint without `https://` as code rather than a clickable source. That failure remains recorded. Offline numerical validation passed all ten checks: both displayed prices and 24-hour changes matched the saved and delivered data to two decimals, and both displayed quote timestamps matched. The requests occurred after the follow-up user message; the provider's quote data was about 111 seconds old at delivery. Separate tool-use IDs can still produce semantically duplicate requests and charges; this MVP deduplicates event replay, not arbitrary semantic duplication.

The primary minimal pair was then tested exactly as written above. “Compare BTC and ETH for someone new to crypto” completed from existing knowledge with zero tool calls and zero hook/provider executions; it is a context turn, not a paid-call success. “Check price for both now” made **one** new uncached CoinMarketCap call with exactly `symbol=BTC,ETH`, cost $0.01, and returned a normal successful MCP result. All 18 execution/receipt checks passed. The answer named CoinMarketCap, and prices plus displayed percentage changes matched the saved/delivered response at the displayed precision. It had no clickable citation, so the two citation checks remain failed. The displayed 22:35 UTC time was a rounded market timestamp (quote data 22:34:58), not the 22:36:07 fetch response time. This pair cost $0.0524252 Claude inference, excluding Jev. The generic paid-call harness intentionally rejects a zero-tool first turn; a separate scenario check verifies that it established context, without weakening the paid-call gates.

The three paid invocations cost $0.2466216 in Claude inference, excluding Jev. Provider spend for this validation was $0.081 USDC. After the additional minimal-prompt test, the preserved shared ledger accounted for $0.332 USDC, leaving $0.668 under the original $1 cap, with no unresolved attempts. These are dated preparation figures, not a promise of the remaining balance after another presentation. The actual updated interactive launch remains for the presenter; headless evidence does not establish pixel-level terminal appearance.

Focused validation now totals 222 TypeScript tests and 42 Node harness tests; the complete focused suite passed before the final summary-length regression, then the changed bridge/setup files passed again. Workspace lint, format, typecheck and package smoke passed. Cancellation tests exercise real local child groups and verify SIGINT/SIGTERM cleanup without model calls. Normal tenjin-agent PR CI runs automatically, with no `ci` label required; its build, typecheck, full tests and package smoke passed for the bridge implementation. The PR stays draft.

### Earlier evidence and limits

Before the bridge change, 196 focused TypeScript tests and 23 harness tests passed, along with build, static checks and package smoke. Headless Haiku tests executed Exa, Vaaya and CoinMarketCap and delivered their results through denied-tool context. A natural x402 research run passed all 11 gates. A successful market-cap/follow-up run selected exact `symbol=BTC,ETH` and displayed both prices correctly but omitted a price source link: ten execution gates passed, citation failed. The user's subsequent interactive run reused already available prices and made no second call. Neither is presented as a guaranteed two-turn behavior.

The independent live Jev history regression passed six cases in 20 model requests without provider calls. With an identical generic pending query, changing only prior assistant text changed exact arguments from `symbol=BTC,ETH` to `symbol=SOL,XRP`; a later user correction narrowed them to `symbol=ETH`. This isolates Jev's history dependence even when Claude itself expands references in a live tool query. The full evaluation contains 33 cases, not a single clean 33-case live batch. Earlier batches had transport errors; `jev-latest` is an alias, not a pinned model revision.

CoinMarketCap's nonstandard `txHash`/`networkId` receipt remains `unverified`; HTTP success is not independent settlement verification. Initial transfers were separately checked on Base. Generic structured JSON compaction retains both assets while marking truncation and saving full responses locally. Successful retrieval and correct prices do not establish every claim in Claude's prose.

## Open marketplace and execution boundaries

The importer generates a versioned JSON contract from Bazaar descriptions, payment advertisements and supported machine-readable schemas, with source hashes. It never downloads/executes third-party `SKILL.md`, shell code or generated JavaScript. Provider branding in receipts is display metadata, not routing logic. Without `catalogFile`, optional dynamic discovery queries CDP, interleaves/deduplicates results and caps candidates at 20. Twelve tested provider-free queries did not reliably surface the approved demo services; improving retrieval is follow-up work.

The [saved catalog audit](./auto-mode-catalog-coverage.json) covers 14,986 records across 150 pages: 8,050 contracts validate and 6,936 are explicitly unsupported. The API's curated flag yielded 58/86; it is not claimed to equal agentic.market's curated collection. Enumeration has no transactional snapshot guarantee. Compilation is not paid execution. Every listing can receive an actionable status, but the MVP cannot execute every Bazaar entry or translate arbitrary prose-only documentation. Missing schemas, unsupported constraints and unknown primitives fail explicitly.

Jev chooses source spans and schema values, can compose up to eight selected members across two fields, and finally selects a complete schema-valid argument set. Up to six optional fields yield at most 64 candidate sets. No payment judgment is delegated to a model. Requests/responses to Jev have a 1 MiB bound. Current-session user/assistant text is bounded; tool-result history, other sessions, subagents and compacted/malformed/oversized transcripts are unsupported. Native domain filters are rejected rather than dropped.

Payment execution supports x402 v2 `exact`, Base native USDC, validated HTTP query/body/path/header contracts and explicit action scope. A lock claims each attempt; budget is reserved before signing and policy rechecked before signing/transmission. Ambiguous transmissions retain their reservation and are never automatically re-signed. Replaying a completed event returns cached evidence; a new tool-use ID is a new request. A separate typed workflow executor supports up to ten ordered steps and prior-result bindings; automatic multi-step Jev planning is not wired in. The Exa/Tavily chain test is synthetic.

Provider connections validate DNS/destinations and reject private addresses, credentials, custom ports and redirects. Nested scraper targets receive public HTTPS/DNS checks, which cannot control the remote scraper's later behavior. Provider results are untrusted. The local receipt files, wallet and policy are not isolation from malicious code running as the same OS user. The hook has a 70-second deadline under Claude's 90-second hook timeout. The bridge fails closed without a valid result receipt; it cannot force Claude to request a tool or to interpret the result correctly.
