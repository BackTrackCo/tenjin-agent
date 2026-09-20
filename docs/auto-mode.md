# Local Jev → x402 experiment

This draft experiment lets Claude propose an ordinary `WebSearch` or `WebFetch`, then executes a paid Bazaar capability from a local `PreToolUse` hook. It needs no backend or MCP server. It does not install global hooks or change Tenjin's normal CLI behavior.

Jev selects the endpoint and argument values from the pending call, current session text, corrections, and schema choices. Jev's choice API cannot generate novel strings: a missing value returns `needs_input`. Code validates the selected arguments, action policy, quote, budget and attempt identity, then signs and executes. No model approves a payment. Claude receives the result as hook context while its native call is denied; Claude still interprets the returned document and continues the task.

## Run the prepared demo

Preparation and presentation are separate. Use the demo directory and resolved launch command supplied by the agent that prepared this run. Do not rerun setup or initialize a new policy merely to start a fresh Claude conversation: the existing ledger preserves cumulative spending. The setup recipe for other machines appears later in this guide.

Open your own terminal and launch a **fresh, empty interactive Claude Code session**. For an already prepared directory at `/tmp/tenjin-auto-live`:

```sh
cd /tmp/tenjin-auto-live
claude --model haiku \
  --tools 'WebSearch,WebFetch' \
  --permission-mode dontAsk \
  --settings /tmp/tenjin-auto-live/settings.json \
  --setting-sources '' --strict-mcp-config \
  --disable-slash-commands --no-chrome
```

The command has no `-p`, `-c`/`--continue`, `--resume`, or initial prompt. It opens the normal Claude Code UI with an empty conversation. Complete any startup trust/login screen, then check the displayed model is Haiku. **Do not paste the setup request into this session.** `dontAsk` controls tool permissions; it does not make the session headless. With the generated `ask` rules, native search/fetch fallback is denied if the hook fails. Keep those rules and the launch flags together. No `--allowedTools` override, native auto mode, or bypass mode is needed. Claude documents [interactive startup and CLI flags](https://code.claude.com/docs/en/cli-reference) and [permission modes](https://code.claude.com/docs/en/permissions).

Tell the empty session only the first task below. Then type the next two tasks **one at a time in that same conversation**, waiting for each answer:

1. **Search → Exa**

   ```text
   Use WebSearch to find official x402 protocol documentation. Give two source links with a one-sentence description of each.
   ```

2. **Page extraction → Firecrawl through Vaaya**

   ```text
   Use WebFetch to read https://example.com. Summarize the page and cite its URL.
   ```

3. **Situational WebSearch → direct CoinMarketCap**

   ```text
   Use WebSearch to get CoinMarketCap's latest USD quotes for the symbols `BTC,ETH`. Report both prices and cite the data source.
   ```

The third prompt is the key demonstration: the same WebSearch hook has both search and crypto candidates, and Jev selects the structured price API for the task. Each successful step should produce an answer with sources. A native tool denial can appear in the UI because the hook supplies the fulfilled paid result as context and suppresses the original call. A denial by itself is not a successful demo; check the answer and the saved provider outcome.

Vaaya advertises its service as Firecrawl scraping; the executor does not independently attest its backend implementation. Expected provider costs from the tested runs are $0.007 for Exa, $0.01 for Vaaya and $0.01 for CoinMarketCap. The live quote must still pass the current policy and listing checks. Jev and Claude inference are separate costs. **The interactive session has no headless runner's $0.50/four-turn inference cap**; the local $0.10/call and $1/run payment caps still apply. Exit Claude when the presentation is done.

The two WebSearch seeds retain ordinary search and CoinMarketCap candidates. Quoted/backticked values such as `BTC,ETH` are copied into Jev's finite argument-choice set. Up to three discovery seeds run in parallel, with deterministic interleaving, deduplication and a 20-candidate cap. Legacy single-string filters still work. Omitting seeds uses the task text; Bazaar ranking can then omit a desired seller. Search failures and truncated candidate sets are recorded explicitly.

BTC/ETH are demo inputs, not an asset allowlist. Other quoted ticker, slug or ID lists use the same contract and provider limits. Symbols are not globally unique; explicit CoinMarketCap IDs or slugs avoid ambiguous matches. Large result sets receive an explicitly partial preview, with the complete response retained locally.

### Let the setup agent inspect a run

Keep the coding-agent conversation that prepared the demo available separately. After the presentation, give that agent this request, replacing the directory if needed:

```text
Inspect the local Jev x402 demo artifacts in /tmp/tenjin-auto-live without
making another provider request. For the latest presentation, report the
selected endpoint and arguments, outcome, provider amount and receipt status
for each call. Compare both requested crypto prices with the saved response.
Use outcomes and ledger entries, not just a tool-denied UI message. Report
missing evidence honestly. Do not print credentials or signed payment data.
```

Interactive hook calls write `state/outcomes/`, `state/events.jsonl` and `state/run-*.json`; Claude keeps its normal session transcript. The `runs/<session>/report.json` files belong to the headless validation script and are **not** generated by the interactive launch. Artifacts can contain private task data and stay local. Reuse the same demo directory to preserve cumulative spending. If the policy expires, return to the setup agent for an explicit new run instead of clearing the ledger. If a call is pending or its payment transmission is uncertain, inspect that attempt before retrying.

Keep session persistence enabled: `--no-session-persistence` removes the transcript the hook needs. Managed settings still apply. The presentation exposes only WebSearch/WebFetch; installation, configuration and artifact inspection belong in the separate preparation conversation. The presentation starts fresh without continuing or resuming prior conversation history, while using the existing payment policy and ledger. Registration applies only to those invocations, so exiting Claude is the teardown; retain state for reconciliation.

### What was prepared separately

For the 2026-09-20 preparation, the agent reused the built PR checkout and installed dependencies (Node 24.18.0, pnpm 11.11.0, Claude Code 2.1.278). It verified the existing Claude login, Jev credential presence, wallet-file presence, generated hook, three allowed routes, discovery seeds, payment caps and expiry. The existing live policy and ledger were preserved: $0.071 USDC accounted for, $0.929 remaining, and no unresolved attempts. A separate fixture directory kept validation data out of the presentation session. The clarified synthetic preflight passed all eight report checks with Haiku and no provider payment. The presentation session itself was left unopened, so it starts empty when the presenter launches it. Future preparation should report the current checks and budget rather than reuse these dated values.

The fixture preflight uses headless Claude with synthetic data and no provider payment. The recorded live paid-call evidence below also comes from headless validation. Neither means the full three-prompt interactive presentation has already been tested.

## Optional: reproduce the agent-assisted setup

This is the optional reproducible setup for another machine or an explicitly authorized new run. Skip it when the demo has already been prepared. Paste the request into a separate coding-agent conversation with local terminal access; never paste it into the empty presentation session. The agent handles checkout, dependencies, configuration and a fixture preflight, then supplies the resolved launch command.

Requirements: Node 24+, pnpm, authenticated Claude Code, a Jev API key (`TYPESAFE_KEY` or `TYPESAFE_API_KEY`), and an existing funded Tenjin local wallet. On the Tenjin workspace, the existing `tenjin/.env.local` is the expected env source. Elsewhere, give the agent the env-file path if it cannot find it from your project context; never paste credentials into chat. The file is referenced in place.

```text
Prepare the local Jev → x402 demo from BackTrackCo/tenjin-agent draft PR #369
(branch codex/local-jev-x402-auto-mode). Read docs/auto-mode.md and the
repository instructions, then do the setup for me.

Use the existing PR checkout if available. Otherwise create an isolated
checkout of the PR branch using the workspace's worktree helper where
available, or a separate clone. Preserve other checkouts and uncommitted work.
Install the frozen dependencies and build the branch. Check Node, pnpm and
Claude Code versions and existing Claude authentication. Use Haiku; no Fable.

Use the existing env file and funded Tenjin local wallet. In the Tenjin
workspace, look for tenjin/.env.local; the default wallet directory is
~/.tenjin. Check only whether the required credentials are present. Do not
print env contents, export the whole env file, copy credentials, create a
wallet, or modify global Claude settings. Ask only for a missing path, login
or funding that you cannot resolve from existing setup.

Run the fixture preflight below with Haiku. Headless is fine for this setup
check; do not run the paid presentation prompts during setup.

Use the built tenjin-auto-mode init command to prepare a live demo directory
outside the repository. Automatic payment authorization is approved within
$0.10 per call, $1 total per run and a 24-hour expiry, for exactly these routes:
- POST https://api.exa.ai/search
- POST https://vaaya.ai/api/run/firecrawl/scrape
- GET https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest
Use WebSearch discovery seeds "Exa web search" and "CoinMarketCap", and the
WebFetch seed "Firecrawl scrape webpage". Reference the existing env file and
wallet directory. Preserve a valid existing demo's config, policy and ledger;
do not reset its budget or silently renew an expired run.

Inspect the generated settings/config/policy and confirm the built hook path,
three allowed routes, discovery seeds, payment caps and expiry. Keep native
WebSearch/WebFetch permissions set to ask. Do not change them to allow.

Finish with the demo directory, model, policy expiry, fixture result, and ONE
copy-paste terminal command with real, safely quoted absolute paths to start
a fresh, empty interactive Claude Code session. Use the launch flags in
"Run the prepared demo" above. Do not use -p, -c/--continue, --resume or an
initial prompt. Do not pipe in prompts, start a background process, or launch
the interactive session inside your own tool. Give me the three presentation
prompts above in order; no setup prompt belongs in that session. Wait for me
to run the actual demo.
```

An existing Claude login or wallet funding may need a human action. The setup agent should name the missing prerequisite precisely. Everything else in this recipe can be performed by the agent.

### Commands for the setup agent

Run from the PR checkout. Resolve the example paths before executing; choose new directories when starting a new authorized run. Reinitializing a directory is refused to preserve its budget identity.

```sh
pnpm install --frozen-lockfile
pnpm build

# Synthetic hook preflight: Claude inference, no Jev or provider payment.
node dist/tenjin-auto-mode.mjs init --directory /tmp/tenjin-auto-fixture
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-fixture/config.json --model haiku \
  --prompt 'This is a synthetic hook validation. Use WebSearch once to retrieve the Northstar archive fixture. Report the fixture verification code and its supplied source URL, clearly labeled as synthetic test data.'

node dist/tenjin-auto-mode.mjs init \
  --directory /tmp/tenjin-auto-live --mode live \
  --env-file /absolute/path/to/existing.env \
  --wallet-dir "$HOME/.tenjin" \
  --search-query 'Exa web search' 'CoinMarketCap' \
  --fetch-query 'Firecrawl scrape webpage' \
  --allow-resource POST:https://api.exa.ai/search POST:https://vaaya.ai/api/run/firecrawl/scrape GET:https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest
```

## Validation and evidence

The fixture preflight tests delivery of synthetic hook content and its supplied URL, not factual web search. The earlier prompt did not explicitly state that purpose; Claude returned the fixture code but declined to cite the fictional source, passing seven of eight gates. The setup prompt now labels both the request and expected answer as synthetic test data.

On 2026-09-20, final Haiku runs fulfilled Exa search at $0.007, Vaaya Firecrawl scrape at $0.01, and direct CoinMarketCap BTC/ETH quotes at $0.01. Each made one native tool request, suppressed its execution, fulfilled the paid request, and cited a returned URL or the actual supplying endpoint. Both crypto prices were checked against the saved provider response. The three final runs cost $0.0201938 in Claude inference. Including earlier paid diagnostics, total provider spend was $0.071 USDC; diagnostic/fixture/model-evaluation inference costs are separate. All **154 focused TypeScript tests and 11 harness tests**, the build, static checks, and package smoke passed. These are observed results, not paid CI gates.

Base transaction receipts independently confirmed the initial Exa, Vaaya and CoinMarketCap transfers. CoinMarketCap returned nonstandard `txHash`/`networkId` receipt fields, so the executor conservatively labels its settlement `unverified`; HTTP success does not become an independent settlement claim. The first crypto trial also exposed a raw-text preview that omitted ETH. Generic bounded JSON compaction fixed that, and the final trial delivered both prices while retaining explicit truncation markers and the complete response locally.

An initial generic WebFetch prompt returned `needs_input`. Clarifying that the scraper supplies content while Claude summarizes it fixed routing; the original generic prompt then completed a paid scrape and cited the returned URL. Earlier quote requests timed out when the local network's IPv4 route was unavailable; validated IPv4/IPv6 connection fallback resolved it without retrying a transmitted authorization. Failed pre-signing attempts spent no USDC.

- The hook transport probe checks opaque fixture content and source delivery, native denial, exactly one requested call, and model identity. Haiku passed search and fetch; same-session resume passed with Haiku and Sonnet. These probes use synthetic results and explicitly explain the fixture to Claude.
- The initial live Jev evaluation passed **25/25 fixed-label cases**, making 42 model requests and no provider requests or payments. After adding the generic-fetch regression and clarifying routing, a 26-case batch passed 23 cases with three transport errors; separate retries passed those three. All 26 labels therefore have successful evidence, but there was no clean 26/26 batch. Two additional generic-fetch repetitions hit transport errors, so repeatability is not established. Cases cover provider/argument choice, corrections, missing values, native restrictions, merchant instruction injection, and an unseen synthetic provider. Contexts are fixtures; this is not a real Claude resume semantic benchmark or a universal accuracy claim. `jev-latest` is an alias, not a pinned server revision.
- Four additional crypto-versus-search evaluation cases passed separately, including direct CoinMarketCap with the exact `symbol=BTC,ETH` argument and ordinary documentation requests selecting Exa. The evaluation now contains 30 cases; there is no claim of a single clean 30-case live batch.
- Deterministic tests cover quote substitution, revocation, concurrent claims, budget reservation, ambiguous transmissions, replay without signing again, schema constraints, public destination checks, and a two-step Exa/Tavily-style fixture workflow. Tavily is synthetic in these tests.
- The live report validator requires successful process exit, the requested model, exactly one matching native call denied, a fulfilled current-event provider result, HTTP 200, and a final citation to a returned URL or the actual supplying endpoint. Structured data APIs need not invent a URL field to supply provenance. An unrelated URL or stale prior result cannot pass. These transport gates do not prove factual completeness; the final demo answers were also checked against saved provider results.

The live results above were measured with the headless validation harness. They establish the paid call paths; they are not evidence that the full three-prompt interactive conversation has already been tested. The presentation instructions use interactive CLI flags checked against Claude Code 2.1.278.

For automated revalidation, the agent can run the three paid cases through the existing harness instead of presenting them interactively. These are optional validation commands, sharing the same local payment policy:

```sh
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-live/config.json --model haiku
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-live/config.json --model haiku \
  --tool WebFetch --prompt 'Use WebFetch to read https://example.com. Summarize the page and cite its URL.'
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-live/config.json --model haiku \
  --prompt 'Use WebSearch to get CoinMarketCap latest USD quotes for the symbols `BTC,ETH`. Report both prices and cite the data source.'
```

The harness uses only the requested tool, a persisted session, a 120-second process timeout, a $0.50 Claude inference cap and four turns. It saves Claude's stream and `runs/<session>/report.json`, verifies the observed model, and stops its child processes. `--model sonnet` is also supported; no Fable model is selected.

Repeat focused checks and model evaluation without provider payments:

```sh
pnpm exec vitest run src/experimental/auto-mode
node --test scripts/auto-mode-headless-probe.test.mjs scripts/auto-mode-demo-checks.test.mjs
node scripts/auto-mode-headless-probe.mjs WebSearch --model haiku --resume
node scripts/auto-mode-headless-probe.mjs WebSearch --model haiku --failure broken
node scripts/auto-mode-headless-probe.mjs WebSearch --model haiku --failure timeout
node dist/tenjin-auto-mode-eval.mjs --env-file /absolute/path/to/existing.env \
  --output /tmp/jev-routing-report.json --max-calls 60
pnpm lint
pnpm format:check
pnpm typecheck
```

The 60-call Jev limit is a request-count limit, not a dollar budget. Network and paid demos are opt-in and are not part of CI. A `PAYMENT-RESPONSE` receipt is labeled provider-reported; the executor does not claim independent chain verification.

## Open marketplace, bounded interpreter

CDP facilitator Bazaar supplies endpoint descriptions, payment advertisements, and available machine-readable input schemas. This importer generates a versioned JSON contract directly from those schemas, including provenance/source hashes. It never downloads or executes a third-party `SKILL.md`, shell program, or generated JavaScript. There are no Exa/Firecrawl routing branches or manually edited generated manifests. The public fixtures retain captured catalog records for reproducible testing.

The [catalog audit](./auto-mode-catalog-coverage.json) covers 14,986 endpoint records across 150 pages and 1,996 endpoint origins. **8,050 contracts validate; 6,936 are explicitly unsupported.** This is input-schema compilation, not successful endpoint execution. The API's `curated: true` subset was 58/86; it is not claimed to equal agentic.market's curated collection. Pagination completed but the service offers no transactional snapshot guarantee.

Every entry can be ingested and receive an actionable status. Missing/placeholder schemas, contradictory metadata, unsupported schema constraints, and unknown primitives are not silently guessed. The MVP does **not** yet translate prose-only documentation or support every Bazaar service. In particular, regex constraints are deferred until a bounded matching primitive exists. New metadata or interpreter primitives can make an entry executable without adding a provider-specific registry.

```sh
node dist/tenjin-auto-mode.mjs discover --query 'web search'
node dist/tenjin-auto-mode.mjs audit --output /tmp/catalog-audit.json --pages 200 --duration-ms 200000
```

HTTP request construction supports the validated query/body/path/header contract. Live payments currently support x402 v2 `exact`, Base native USDC. Arbitrary transports, signing schemes, dynamic branches/loops, autonomous installation and prose translation are follow-ups. Automatic routing selects one contract per hook. `executeWorkflow` separately supports up to ten ordered steps with typed references to prior JSON results; it applies the same quote, policy, ledger and total-budget checks per step. Automatic multi-step planning is not wired into Jev yet.

## Operational boundaries

The transcript parser reads bounded user/assistant text from the current session, including persisted resume history. It does not retrieve other sessions, reconstruct arbitrary tool-result history, or support subagents. Missing, oversized, malformed or compacted context returns `needs_input` and asks for a fresh session. Native domain allow/block filters currently return `unsupported` instead of dropping restrictions.

Payment attempts are claimed under a local lock before network work. Budget is reserved before signing; policy is rechecked before signing and transmission. A transmitted authorization remains reserved after timeout and is never automatically signed again. Completed event replay returns saved evidence without rerouting or paying again. A new tool-use ID is a new request: semantic duplicates across IDs are not inferred by a model. The hook tells Claude not to repeat a fulfilled call.

Provider HTTPS connections resolve and validate destinations before connecting; private addresses, credentials, custom ports and redirects are rejected. Nested target URLs receive public HTTPS/DNS preflight checks. Those checks cannot control a remote scraper's own DNS resolution or subsequent redirects. A local file and wallet policy is not an isolation boundary against malicious code running as the same OS user.

The hook has a 70-second internal deadline under Claude's 90-second timeout. Native `ask` permissions protect fallback, and the headless runner uses `dontAsk`. Result context is bounded below Claude's hook limit and labeled untrusted. Full results remain in local state; truncation is explicit. This design forces the local executable operation when the matched hook runs; it cannot force Claude to request a tool or to reason correctly from returned content.
