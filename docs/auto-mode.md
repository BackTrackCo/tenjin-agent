# Local Jev → x402 experiment

This draft experiment lets Claude propose an ordinary `WebSearch` or `WebFetch`, then executes a paid Bazaar capability from a local `PreToolUse` hook. It needs no backend or MCP server. It does not install global hooks or change Tenjin's normal CLI behavior.

Jev selects the endpoint and argument values from the pending call, current session text, corrections, and schema choices. Jev's choice API cannot generate novel strings: a missing value returns `needs_input`. Code validates the selected arguments, action policy, quote, budget and attempt identity, then signs and executes. No model approves a payment. Claude receives the result as hook context while its native call is denied; Claude still interprets the returned document and continues the task.

## Run the demo from this branch

Requirements: Node 24+, pnpm, authenticated Claude Code, a Jev API key (`TYPESAFE_KEY` or `TYPESAFE_API_KEY`), and an existing funded Tenjin local wallet for live requests. The env file is referenced in place; credentials are never written into the experiment config. Keep the experiment directory outside the repository.

```sh
pnpm install --frozen-lockfile
pnpm build

# First inspect the hook with synthetic data, no Jev calls or provider payments.
node dist/tenjin-auto-mode.mjs init --directory /tmp/tenjin-auto-fixture
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-fixture/config.json --model haiku \
  --prompt 'Use WebSearch to find the Northstar archive verification code and cite its source.'

# Use a NEW directory for the bounded live run.
node dist/tenjin-auto-mode.mjs init \
  --directory /tmp/tenjin-auto-live --mode live \
  --env-file /absolute/path/to/existing.env \
  --wallet-dir "$HOME/.tenjin" \
  --search-query 'Exa web search' 'CoinMarketCap' \
  --fetch-query 'Firecrawl scrape webpage' \
  --allow-resource POST:https://api.exa.ai/search POST:https://vaaya.ai/api/run/firecrawl/scrape GET:https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest

node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-live/config.json --model haiku
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-live/config.json --model haiku \
  --tool WebFetch --prompt 'Use WebFetch to read https://example.com. Summarize the page and cite its URL.'

# Same WebSearch hook and candidate set; Jev can select a structured data API.
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-live/config.json --model haiku \
  --prompt 'Use WebSearch to get CoinMarketCap’s latest USD quotes for the symbols `BTC,ETH`. Report both prices and cite the data source.'
```

The live setup automatically authorizes payments within an explicit action scope, with a **$0.10 per-call ceiling and $1 total run ceiling**, expiring after 24 hours. Exa, Vaaya and direct CoinMarketCap are the demo's selected sellers; Vaaya advertises its service as Firecrawl scraping. The executor does not independently attest Vaaya's backend implementation. These URLs are local spending scope, not an importer admission list. Keep the same directory across trials so they share the same budget. Reinitializing a directory is refused. Jev and Claude inference costs are separate; the headless script caps each Claude invocation at $0.50 and four turns.

For a live presentation, start with the search command above. It uses a normal task prompt, shows Claude's answer and cited sources, and writes an auditable report. Then run the WebFetch example to show the same hook executing a different schema. Haiku is the default and its observed model is checked; `--model sonnet` is also accepted. No Fable model is selected.

Finish with the crypto prompt. The two WebSearch discovery seeds retain both ordinary search and CoinMarketCap candidates; Jev chooses from their real Bazaar contracts according to the task. Quoted/backticked values such as `BTC,ETH` are copied into the finite argument-choice set, so the router need not invent or parse a ticker list semantically. Up to three query seeds run in parallel, with deterministic interleaving, deduplication and a 20-candidate cap. Legacy single-string filters still work. Omitting seeds uses the task text; Bazaar ranking can then omit a desired seller. Search failures and truncated candidate sets are recorded explicitly.

BTC/ETH are demo inputs, not an asset allowlist. Other quoted ticker, slug or ID lists can be selected under the same contract and provider limits. Ticker symbols are not globally unique; explicit CoinMarketCap IDs or slugs avoid ambiguous matches. Large result sets receive an explicitly partial preview, with the complete response retained locally.

The script runs from the experiment directory with only the requested native tool, explicit settings, no external MCP configuration, and slash-command skills disabled. Generated settings mark native search/fetch as `ask`; headless `dontAsk` then denies native fallback if the hook fails. Managed Claude settings still apply. Keep session persistence enabled: `--no-session-persistence` removes the transcript the hook needs.

Each run saves `runs/<session>/report.json` and Claude's stream. `state/outcomes/` contains the result for each event, `state/events.jsonl` contains compact redacted decisions, and `state/run-*.json` holds payment attempts and budget accounting. Result bodies and conversation streams can contain private task data; these files stay local. Inspect `policy.json` to change caps/scope or set authorization to `disabled`. No server remains running. No teardown command is needed because registration is supplied only to those Claude invocations. Retain state for reconciling uncertain payments.

## Validation and evidence

On 2026-09-20, final Haiku runs fulfilled Exa search at $0.007, Vaaya Firecrawl scrape at $0.01, and direct CoinMarketCap BTC/ETH quotes at $0.01. Each made one native tool request, suppressed its execution, fulfilled the paid request, and cited a returned URL or the actual supplying endpoint. Both crypto prices were checked against the saved provider response. The three final runs cost $0.0201938 in Claude inference. Including earlier paid diagnostics, total provider spend was $0.071 USDC; diagnostic/fixture/model-evaluation inference costs are separate. All **154 focused TypeScript tests and 11 harness tests**, the build, static checks, and package smoke passed. These are observed results, not paid CI gates.

Base transaction receipts independently confirmed the initial Exa, Vaaya and CoinMarketCap transfers. CoinMarketCap returned nonstandard `txHash`/`networkId` receipt fields, so the executor conservatively labels its settlement `unverified`; HTTP success does not become an independent settlement claim. The first crypto trial also exposed a raw-text preview that omitted ETH. Generic bounded JSON compaction fixed that, and the final trial delivered both prices while retaining explicit truncation markers and the complete response locally.

An initial generic WebFetch prompt returned `needs_input`. Clarifying that the scraper supplies content while Claude summarizes it fixed routing; the original generic prompt then completed a paid scrape and cited the returned URL. Earlier quote requests timed out when the local network's IPv4 route was unavailable; validated IPv4/IPv6 connection fallback resolved it without retrying a transmitted authorization. Failed pre-signing attempts spent no USDC.

- The hook transport probe checks opaque fixture content and source delivery, native denial, exactly one requested call, and model identity. Haiku passed search and fetch; same-session resume passed with Haiku and Sonnet. These probes use synthetic results and explicitly explain the fixture to Claude.
- The initial live Jev evaluation passed **25/25 fixed-label cases**, making 42 model requests and no provider requests or payments. After adding the generic-fetch regression and clarifying routing, a 26-case batch passed 23 cases with three transport errors; separate retries passed those three. All 26 labels therefore have successful evidence, but there was no clean 26/26 batch. Two additional generic-fetch repetitions hit transport errors, so repeatability is not established. Cases cover provider/argument choice, corrections, missing values, native restrictions, merchant instruction injection, and an unseen synthetic provider. Contexts are fixtures; this is not a real Claude resume semantic benchmark or a universal accuracy claim. `jev-latest` is an alias, not a pinned server revision.
- Four additional crypto-versus-search evaluation cases passed separately, including direct CoinMarketCap with the exact `symbol=BTC,ETH` argument and ordinary documentation requests selecting Exa. The evaluation now contains 30 cases; there is no claim of a single clean 30-case live batch.
- Deterministic tests cover quote substitution, revocation, concurrent claims, budget reservation, ambiguous transmissions, replay without signing again, schema constraints, public destination checks, and a two-step Exa/Tavily-style fixture workflow. Tavily is synthetic in these tests.
- The live report validator requires successful process exit, the requested model, exactly one matching native call denied, a fulfilled current-event provider result, HTTP 200, and a final citation to a returned URL or the actual supplying endpoint. Structured data APIs need not invent a URL field to supply provenance. An unrelated URL or stale prior result cannot pass. These transport gates do not prove factual completeness; the final demo answers were also checked against saved provider results.

Repeat focused checks and unpaid model evaluation:

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
