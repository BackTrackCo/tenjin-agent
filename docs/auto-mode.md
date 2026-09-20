# Local Jev → x402 experiment

This draft experiment lets Claude propose an ordinary `WebSearch` or `WebFetch` from a natural-language task, then executes a paid Bazaar capability from a local `PreToolUse` hook. The prepared MVP uses a user-approved, hand-selected local catalog of three unchanged CDP Bazaar records: Exa search, Vaaya Firecrawl scraping, and direct CoinMarketCap quotes. It needs no backend or MCP server and does not install global hooks.

Jev selects the endpoint and argument values from that catalog using the pending call, current session text, prior answers, corrections, and schema choices. Jev's choice API cannot generate novel strings: it selects exact source values and bounded list compositions; a missing value returns `needs_input`. Code validates the selected arguments, action policy, quote, budget and attempt identity, then signs and executes. No model approves a payment. Claude receives the result as hook context while its native call is denied; Claude still interprets the returned document and continues the task.

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

Start with this natural dialogue. Type the first question into the empty session:

```text
What are the two biggest cryptocurrencies by market cap?
```

Wait for the answer, then ask:

```text
So what are their prices right now?
```

The follow-up deliberately relies on the preceding answer. It does not restate asset symbols, name a provider, or tell Claude which native tool to call. Jev receives the bounded transcript and pending tool request when Claude chooses to use a tool, then selects a catalog contract and available argument values. Code validates and executes that selection. This exact two-turn conversation was validated headlessly with Haiku: the first turn used Exa and Vaaya Firecrawl, and the follow-up selected CoinMarketCap with `symbol=BTC,ETH`. Both prices matched the saved response. Haiku omitted a source link in the price answer, so the strict citation gate remained failed; the ten routing/execution gates passed. The actual interactive presentation is still left for the presenter to run.

To demonstrate other tasks in the same session, enter these separately:

**Research**

```text
Find two authoritative explanations of how x402 payments work. Link both sources and briefly explain what each covers.
```

**Read a page**

```text
Summarize this page in two sentences and link to it: https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works
```

These prompts provide tasks rather than provider or native-tool instructions. Claude chooses whether to use search or fetch; Jev chooses the executable capability. A task may result in more than one paid call. A native tool denial can appear in the UI because the hook supplies the paid result as context and suppresses the original call. A denial by itself is not a successful demo: inspect the answer and all saved provider outcomes.

Vaaya advertises its service as Firecrawl scraping; the executor does not independently attest its backend implementation. Expected provider costs from the tested runs are $0.007 for Exa, $0.01 for Vaaya and $0.01 for CoinMarketCap. The live quote must still pass the current policy and listing checks. Jev and Claude inference are separate costs. **The interactive session has no headless runner's $0.50/four-turn inference cap**; the local $0.10/call and $1/run payment caps still apply. Exit Claude when the presentation is done.

The prepared `config.json` references `catalog.json` through `catalogFile`, with `discoveryQueries: {}`. Every matched hook sees the same three raw Bazaar records, compiled and validated normally. The catalog is hand-selected; the demo tests intent-to-capability routing, transcript-aware argument selection, and deterministic execution. It is **not evidence of automatic discovery across the Bazaar**. The live quote must still agree with the saved listing and payment policy.

The interpreter contains no ticker allowlist or provider-specific routing branches. Its finite argument choices come from available context and schema values; it returns `needs_input` instead of inventing an unavailable value. Symbols can be ambiguous, and explicit provider IDs or slugs may be needed for a precise request. Large result sets receive an explicitly partial preview, with the complete response retained locally.

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

For the 2026-09-20 preparation, the agent reused the built PR checkout and installed dependencies (Node 24.18.0, pnpm 11.11.0, Claude Code 2.1.278). It verified the existing Claude login, Jev credential presence, wallet-file presence, generated hook, three allowed routes, payment caps and expiry. The initial policy and ledger were preserved with $0.071 USDC accounted for and no unresolved attempts at that checkpoint; those are historical figures, not the remaining budget after later validation. A separate fixture directory kept validation data out of the presentation session. The clarified synthetic preflight passed all eight report checks with Haiku and no provider payment. The presentation session itself was left unopened, so it starts empty when the presenter launches it. The current prepared run now references the hand-selected three-record `catalog.json`, with empty discovery queries; the existing payment policy and ledger remain in place. Future preparation should report the current checks and budget rather than reuse dated figures.

The fixture preflight uses headless Claude with synthetic data and no provider payment. The recorded live paid-call evidence below also comes from headless validation. The natural dialogue was subsequently checked in a separate headless session, as detailed below. The interactive presentation remains unopened.

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
Use a local catalog.json with the unchanged resources from
src/experimental/auto-mode/fixtures/cdp-demo-resources.json plus the unchanged
resource from cdp-cmc-resource.json. Preserve their CDP source and capture
provenance; do not rewrite provider descriptions or schemas. Pass its absolute
path through --catalog-file and leave discoveryQueries empty. This is the
approved hand-selected MVP catalog, not automatic discovery from the task.
Reference the existing env file and wallet directory. Preserve a valid
existing demo's policy and ledger when updating its catalog configuration;
do not reset its budget or silently renew an expired run.

Inspect the generated settings/config/policy and confirm the built hook path,
three allowed routes, unchanged three-record catalog, payment caps and expiry. Keep native
WebSearch/WebFetch permissions set to ask. Do not change them to allow.

Finish with the demo directory, model, policy expiry, fixture result, and ONE
copy-paste terminal command with real, safely quoted absolute paths to start
a fresh, empty interactive Claude Code session. Use the launch flags in
"Run the prepared demo" above. Do not use -p, -c/--continue, --resume or an
initial prompt. Do not pipe in prompts, start a background process, or launch
the interactive session inside your own tool. Give me the natural dialogue
and additional task prompts above; no setup prompt belongs in that session. Wait for me
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

# Combine captured CDP records unchanged; never overwrite an existing catalog.
node --input-type=module <<'NODE'
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const directory = '/tmp/tenjin-auto-live';
const base = 'src/experimental/auto-mode/fixtures/';
const demo = JSON.parse(await readFile(`${base}cdp-demo-resources.json`, 'utf8'));
const cmc = JSON.parse(await readFile(`${base}cdp-cmc-resource.json`, 'utf8'));
if (demo.source !== cmc.source) throw new Error('Review differing capture sources.');
const catalog = {
  source: demo.source,
  fetchedAt: [demo.fetchedAt, cmc.fetchedAt].sort()[0],
  resources: [...demo.resources, cmc.resource],
};
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(`${directory}/catalog.json`, JSON.stringify(catalog, null, 2), {
  flag: 'wx', mode: 0o600,
});
NODE

node dist/tenjin-auto-mode.mjs init \
  --directory /tmp/tenjin-auto-live --mode live \
  --env-file /absolute/path/to/existing.env \
  --wallet-dir "$HOME/.tenjin" \
  --catalog-file /tmp/tenjin-auto-live/catalog.json \
  --allow-resource POST:https://api.exa.ai/search POST:https://vaaya.ai/api/run/firecrawl/scrape GET:https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest
```

## Validation and evidence

The fixture preflight tests delivery of synthetic hook content and its supplied URL, not factual web search. The earlier prompt did not explicitly state that purpose; Claude returned the fixture code but declined to cite the fictional source, passing seven of eight gates. The setup prompt now labels both the request and expected answer as synthetic test data.

In the earlier explicit-tool validation on 2026-09-20, Haiku runs fulfilled Exa search at $0.007, Vaaya Firecrawl scrape at $0.01, and direct CoinMarketCap BTC/ETH quotes at $0.01. Each made one native tool request, suppressed its execution, fulfilled the paid request, and cited a returned URL or the actual supplying endpoint. Both crypto prices were checked against the saved provider response. The three final runs cost $0.0201938 in Claude inference. At that checkpoint, including earlier paid diagnostics, provider spend was $0.071 USDC; diagnostic/fixture/model-evaluation inference costs are separate. The updated branch passes **196 focused TypeScript tests and 23 harness tests**, the build, workspace static checks and package smoke. These are observed results, not paid CI gates.

The natural two-turn crypto validation used a fresh persisted Haiku session and then resumed it with only “So what are their prices right now?” The first turn made one Exa search and one Vaaya fetch ($0.017); the follow-up made one CoinMarketCap request ($0.01), with exactly `symbol=BTC,ETH`. Both displayed USD prices matched the saved response to two decimals. The first turn passed all 11 transport/report gates; the follow-up passed the ten routing/execution gates but failed the source-link gate because Haiku omitted a citation. The report remains failed rather than weakening that gate. The pair cost $0.027 USDC and $0.0330173 Claude inference, excluding Jev charges. A separate natural x402 research prompt made one Exa search and two Vaaya fetches, passed all 11 gates and cost $0.027 USDC. A Markdown URL-label parsing bug in the validator was fixed and its saved result rechecked offline, without new payments.

One earlier natural first turn reached the headless four-turn cap, so the conversational validation used eight turns with the existing 120-second timeout and $0.50 inference cap per invocation. The one-shot script below retains its four-turn limit. An `example.com` summary prompt produced no tool call because Haiku treated it as a placeholder; the presentation now uses a real documentation URL. These failures remain distinct from successful paid execution. Across diagnostics and validation, the preserved payment ledger accounts for **$0.189 USDC**, leaving **$0.811** under the original $1 cap, with no unresolved attempts at the final preparation checkpoint.

Base transaction receipts independently confirmed the initial Exa, Vaaya and CoinMarketCap transfers. CoinMarketCap returned nonstandard `txHash`/`networkId` receipt fields, so the executor conservatively labels its settlement `unverified`; HTTP success does not become an independent settlement claim. The first crypto trial also exposed a raw-text preview that omitted ETH. Generic bounded JSON compaction fixed that, and the final trial delivered both prices while retaining explicit truncation markers and the complete response locally.

An initial generic WebFetch prompt returned `needs_input`. Clarifying that the scraper supplies content while Claude summarizes it fixed routing; the original generic prompt then completed a paid scrape and cited the returned URL. Earlier quote requests timed out when the local network's IPv4 route was unavailable; validated IPv4/IPv6 connection fallback resolved it without retrying a transmitted authorization. Failed pre-signing attempts spent no USDC.

- The hook transport probe checks opaque fixture content and source delivery, native denial, exactly one requested call, and model identity. Haiku passed search and fetch; same-session resume passed with Haiku and Sonnet. These probes use synthetic results and explicitly explain the fixture to Claude.
- The initial live Jev evaluation passed **25/25 fixed-label cases**, making 42 model requests and no provider requests or payments. After adding the generic-fetch regression and clarifying routing, a 26-case batch passed 23 cases with three transport errors; separate retries passed those three. All 26 labels therefore have successful evidence, but there was no clean 26/26 batch. Two additional generic-fetch repetitions hit transport errors, so repeatability is not established. Cases cover provider/argument choice, corrections, missing values, native restrictions, merchant instruction injection, and an unseen synthetic provider. Contexts are fixtures; this is not a real Claude resume semantic benchmark or a universal accuracy claim. `jev-latest` is an alias, not a pinned server revision.
- Four additional crypto-versus-search evaluation cases passed separately, including direct CoinMarketCap with the exact `symbol=BTC,ETH` argument and ordinary documentation requests selecting Exa. The evaluation now contains 30 cases; there is no claim of a single clean 30-case live batch.
- The final focused Jev regression batch passed **6/6 cases in 20 model requests**, with no provider requests or payments. Three new cases require exact complete query objects: an identical generic pending query resolves to `symbol=BTC,ETH` or `symbol=SOL,XRP` when only the assistant answer changes, and a later user correction narrows it to `symbol=ETH`. The other three cover generic page extraction, explicit ticker selection and documentation search. Source-span evidence points to the prior assistant answer. The evaluation contains 33 cases in total; this six-case batch is not a claim that all 33 were rerun successfully together.
- Earlier independent field selections overfilled alternative identifiers or repeated list members. Required-key-only checks could miss extra bad fields, so the new cases grade the entire query. Sequential member choices and a final choice over complete schema-valid argument sets resolved those cases. These tests establish the demonstrated behavior, not general semantic correctness for every provider schema.
- Deterministic tests cover quote substitution, revocation, concurrent claims, budget reservation, ambiguous transmissions, replay without signing again, schema constraints, public destination checks, and a two-step Exa/Tavily-style fixture workflow. Tavily is synthetic in these tests.
- In `--tool auto` mode, the live report validator requires successful process exit, the requested model, one to eight distinct WebSearch/WebFetch calls, matching native denials for every call, fulfilled current-event provider outcomes, HTTP 200, and a final citation to a returned URL or an actual supplying endpoint. It records every selected provider, arguments, amount, receipt status and cache status, and sums amounts by unique tool-use ID. Explicit `--tool WebSearch` or `--tool WebFetch` mode retains the exactly-one-call gate. Structured data APIs need not invent a URL field to supply provenance. An unrelated URL or stale prior result cannot pass. These transport gates do not prove factual completeness; the final demo answers were also checked against saved provider results.

The live results above were measured headlessly. They establish the paid call paths and the specific natural follow-up described above; they are not a completed interactive presentation or a general reliability guarantee. The presentation instructions use interactive CLI flags checked against Claude Code 2.1.278.

For automated single-task revalidation, the agent can run natural prompts with both native tools available. These optional commands share the local policy and can make multiple paid calls. They do not reproduce the two-turn dialogue above: each script invocation creates a new session.

```sh
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-live/config.json --model haiku \
  --tool auto --prompt 'Find two authoritative explanations of how x402 payments work. Link both sources and briefly explain what each covers.'
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-live/config.json --model haiku \
  --tool auto --prompt 'Summarize this page in two sentences and link to it: https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works'
node scripts/auto-mode-demo.mjs --config /tmp/tenjin-auto-live/config.json --model haiku \
  --tool auto --prompt 'What are BTC and ETH trading at in USD right now, and how have they moved over the last 24 hours? Include a source.'
```

With `--tool auto`, the harness exposes WebSearch and WebFetch and records the tools Claude actually uses. It validates one to eight unique calls, uses a persisted session, a 120-second process timeout, a $0.50 Claude inference cap and four turns. It saves Claude's stream and `runs/<session>/report.json`, checks each current-call outcome, verifies the observed model, and stops its child processes. `--model sonnet` is also supported; no Fable model is selected.

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

CDP facilitator Bazaar supplies endpoint descriptions, payment advertisements, and available machine-readable input schemas. This importer generates a versioned JSON contract directly from those schemas, including provenance/source hashes. It never downloads or executes a third-party `SKILL.md`, shell program, or generated JavaScript. There are no Exa/Firecrawl routing branches or manually edited generated manifests. The prepared demo chooses three captured records by hand, then uses the same generic compiler and router as dynamic discovery. The public fixtures retain those raw CDP records for reproducible testing.

Without `catalogFile`, optional dynamic CDP discovery remains available. It accepts up to three query seeds per native tool, interleaves and deduplicates results, and caps the candidate set at 20; without seeds it queries from the task text. Search failures and truncation are recorded. Tested live queries did not reliably return the desired approved sellers, so improving retrieval is separate follow-up work. The hand-selected presentation does not establish that dynamic discovery works for arbitrary intents.

The [catalog audit](./auto-mode-catalog-coverage.json) covers 14,986 endpoint records across 150 pages and 1,996 endpoint origins. **8,050 contracts validate; 6,936 are explicitly unsupported.** This is input-schema compilation, not successful endpoint execution. The API's `curated: true` subset was 58/86; it is not claimed to equal agentic.market's curated collection. Pagination completed but the service offers no transactional snapshot guarantee.

Every entry can be ingested and receive an actionable status. Missing/placeholder schemas, contradictory metadata, unsupported schema constraints, and unknown primitives are not silently guessed. The MVP does **not** yet translate prose-only documentation or support every Bazaar service. In particular, regex constraints are deferred until a bounded matching primitive exists. New metadata or interpreter primitives can make an entry executable without adding a provider-specific registry.

```sh
node dist/tenjin-auto-mode.mjs discover --query 'web search'
node dist/tenjin-auto-mode.mjs audit --output /tmp/catalog-audit.json --pages 200 --duration-ms 200000
```

HTTP request construction supports the validated query/body/path/header contract. Live payments currently support x402 v2 `exact`, Base native USDC. Arbitrary transports, signing schemes, dynamic branches/loops, autonomous installation and prose translation are follow-ups. Automatic routing selects one contract per hook. `executeWorkflow` separately supports up to ten ordered steps with typed references to prior JSON results; it applies the same quote, policy, ledger and total-budget checks per step. Automatic multi-step planning is not wired into Jev yet.

## Operational boundaries

Argument binding retains labeled source spans from user and assistant text. Assistant answers are evidence for references such as “their”; latest user corrections take priority and neither role can grant payment authority. Code can join at most eight selected members into a comma-separated string or array, across at most two fields. Members are selected in order, with previously chosen values removed. Jev then chooses a complete, schema-valid argument set: required values stay fixed, up to six proposed optional fields produce at most 64 candidate sets, and unresolved constraints remain visible. If no candidate satisfies the task, the result is `needs_input`. These are closed choices over data, not generated executable code. Serialized Jev requests and responses each have a 1 MiB limit.

The transcript parser reads bounded user/assistant text from the current session, including persisted resume history. It does not retrieve other sessions, reconstruct arbitrary tool-result history, or support subagents. Missing, oversized, malformed or compacted context returns `needs_input` and asks for a fresh session. Native domain allow/block filters currently return `unsupported` instead of dropping restrictions.

Payment attempts are claimed under a local lock before network work. Budget is reserved before signing; policy is rechecked before signing and transmission. A transmitted authorization remains reserved after timeout and is never automatically signed again. Completed event replay returns saved evidence without rerouting or paying again. A new tool-use ID is a new request: semantic duplicates across IDs are not inferred by a model. The hook tells Claude not to repeat a fulfilled call.

Provider HTTPS connections resolve and validate destinations before connecting; private addresses, credentials, custom ports and redirects are rejected. Nested target URLs receive public HTTPS/DNS preflight checks. Those checks cannot control a remote scraper's own DNS resolution or subsequent redirects. A local file and wallet policy is not an isolation boundary against malicious code running as the same OS user.

The hook has a 70-second internal deadline under Claude's 90-second timeout. Native `ask` permissions protect fallback, and the headless runner uses `dontAsk`. Result context is bounded below Claude's hook limit and labeled untrusted. Full results remain in local state; truncation is explicit. This design forces the local executable operation when the matched hook runs; it cannot force Claude to request a tool or to reason correctly from returned content.
