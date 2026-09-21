# Local Jev → x402 experiment

This draft uses a conditional `UserPromptSubmit` classifier and a local `PreToolUse` executor for research, page-reading, pricing, enrichment and computation requests. Jev selects a capability and its arguments; code validates the request, authorization, quote and budget, then pays and executes. A tiny local stdio MCP bridge returns the saved result as a successful tool response. It has no hosted backend and cannot route, sign or call a provider itself.

The demo has eight capabilities: Exa search, Vaaya/Firecrawl scraping, CoinMarketCap quotes, four GTM enrichment endpoints and Wolfram Alpha through Sponge. Seven are unchanged CDP Bazaar listings. Wolfram requires an explicit, documented input translation. Claude sees one generic `request` tool and describes what it needs; Jev selects the capability and arguments. This demonstrates routing within the curated catalog, not automatic discovery across the entire Bazaar.

The single entrypoint keeps Claude from prematurely choosing page scraping when the user asked for current facts. A requested page URL can be included in the query; Jev distinguishes reading that document from using a previously cited page as an optional source. Legacy search/fetch receipt delivery remains supported internally but those tools are not advertised.

A `UserPromptSubmit` check first asks Jev whether an available capability would help the current request. Native, unresolved and failed decisions add no instructions. A selected route adds one generic instruction to call the request bridge next, by itself, and wait for its result before any other tool call. A fulfilled step should not be duplicated; native tools for that step require an explicit bridge fallback. No task-specific instruction or skill is injected. This stage uses only the configured local catalog, without dynamic discovery; it performs no provider request, quote, payment or execution. Without a local catalog it abstains. `PreToolUse` independently selects and validates the actual tool request before execution.

Jev receives the pending request and bounded user/assistant text from the current session, including prior answers and corrections. Selected context is sent to the Jev/TypeSafe API; local execution does not mean offline inference. Its choice API selects exact available values and bounded list compositions; it cannot generate arbitrary new arguments. A missing value returns `needs_input`. Payment authorization is deterministic and automatic within the local policy. Claude interprets the returned content and decides how to continue.

Optional mixed mode also lets Jev choose ordinary Claude tools when they suit the task. The default preference is capability and fidelity first: use a compatible dedicated page extractor for page reads, even simple known pages. Optional `priceAware` adds a mild price comparison after capability fit. Native search and host reasoning remain available in mixed mode, and explicit no-paid/native-only instructions take precedence. Spending authorization and hard limits still run in code. The CLI default remains bridge-only. The prepared demo below uses mixed mode with native WebSearch, disabled native WebFetch and price awareness; the profile must match the launch command.

## Current status

The current behavior is **Jev selects → code validates → pay and execute → bridge delivers the saved result**. Jev makes qualitative choices, optionally considering advertised price; the code does not enforce a numerical value or confidence-score threshold. There is no hosted Tenjin router, automatic skill import or automatic multi-step Jev planner in this PR.

The final interactive demo includes same-session direct Exa research and a fresh CoinMarketCap follow-up, plus native weather, Hunter company/email and Wolfram examples. Earlier Exa 503s did not prevent the later recorded success. [Validation evidence](./auto-mode-validation.md) separates this recording from headless checks, inspected calibration sets, citation failures, charged no-result calls and unresolved payment reservations. None of those cohorts establishes marketplace-wide accuracy or current provider availability.

CoinMarketCap settlement remains unverified. Other compatible receipts establish provider-reported settlement; they do not independently confirm it on-chain. Timeout or `pending` never establishes zero spend. The historical run's authorized $5 total cap and unresolved reservations are not a new budget for another demonstration.

## Endpoint catalog

| Capability                            | Supplying endpoint                 | Advertised USDC | Observed support                          |
| ------------------------------------- | ---------------------------------- | --------------: | ----------------------------------------- |
| Web search                            | Exa                                |          $0.007 | Paid research requests verified           |
| Page reading                          | Vaaya/Firecrawl                    |           $0.01 | Paid exact-page requests verified         |
| Cryptocurrency quotes                 | CoinMarketCap                      |           $0.01 | Paid BTC/ETH quotes verified              |
| Company enrichment by domain          | Hunter through Locus               |          $0.013 | Paid Stripe company profile returned      |
| Email verification                    | Hunter through Locus               |          $0.008 | Paid public-address verification returned |
| Person enrichment                     | Apollo through Locus               |          $0.038 | Paid professional profile returned        |
| Company enrichment by name/social URL | CompanyEnrich through StableEnrich |           $0.06 | Paid Stripe company profile returned      |
| Mathematical computation              | Wolfram Alpha through Sponge       |           $0.02 | Numerical integral checked independently  |

These are captured/observed September 20–21, 2026 catalog prices, not guarantees of current prices, availability or fulfillment. Exact live quotes must match the catalog and spending policy. Reseller names identify the actual supplier, not an independent attestation of its upstream implementation. [Locus lists Hunter and Apollo](https://paywithlocus.com/tools), and [StableEnrich documents CompanyEnrich](https://stableenrich.dev/docs).

Wolfram's raw Bazaar schema prohibited all query arguments. Its translated contract uses the [documented Full Results input/output parameters](https://products.wolframalpha.com/api/documentation), with JSON output. The fixture retains the raw record and enumerates the translation. An initial unsigned attempt returned HTTP 403; adding an honest `tenjin-cli/0.1 (local-x402-experiment)` User-Agent restored the HTTP 402 quote for Sponge and Locus. The subsequent paid computation is described below. This is explicit MVP curation, not automatic translation of the whole marketplace.

Natural prompts for separate manual sessions:

```text
Look up company details for stripe.com for a quick sales brief.
```

```text
Look up a company profile for Stripe.
```

```text
Check whether info@stripe.com is deliverable. Don't send a message.
```

```text
Evaluate ∫₀¹ e^(−x²) cos(37x) dx to 12 decimal places.
```

The prompts name the task and its input, not a provider. They do not guarantee a tool call or a particular route. The reserved `sales@example.com` test was answered without tools; it did not test the email endpoint. Use an authorized public business address when testing deliverability, and distinguish a provider's verdict from a guarantee that a future email will arrive.

Export all eight capabilities locally with `node dist/tenjin-auto-mode.mjs demo-catalog --output /tmp/expanded-catalog.json`. This refuses to overwrite an existing file and preserves capture/translation provenance. For an existing prepared demo, have the setup agent review and replace its catalog and set its resource scopes to the eight exact method/URL pairs below. Add the `request` operation and bump the policy revision if needed. Preserve the run ID, expiry, caps and ledger, including unresolved reservations. Do not initialize another budget or clear prior attempts when changing the catalog.

Generic requests use the `request` policy operation; exact page reads continue to use `fetch`, and legacy native searches use `search`. An older search/fetch-only policy must explicitly add `request`. For one user turn, an unresolved paid failure blocks another call to the same capability even if Claude changes tool IDs or arguments. Identical in-flight calls are also blocked. Distinct requests to the same capability wait up to ten seconds while another payment is signing or awaiting its response, releasing the ledger lock between checks. A durable successful result lets the waiting request continue after policy and budget rechecks; failed or ambiguous payments remain blocked. Unsigned quote requests may overlap, and different capabilities retain their concurrency. The single wait budget spans both initial claim and payment reservation. Waiting never reclaims an attempt or renews authorization. New explicit user turns retain their own identities. This guard is deterministic and does not ask Jev to authorize a retry.

### Headless validation for the expanded catalog

Run headless Sonnet in auto mode with the isolated bridge; keep manual presentation sessions empty and interactive. Use a config with `mode: "route"` for routing-only tests. `--routing-only --expectation /tmp/expectation.json` validates the chosen endpoint and exact arguments without provider requests, payments or task-completion claims. It appends a validation-only system instruction to stop after a prepared selection, keeps the user's prompt unchanged, and allows two Claude turns for selection and acknowledgment. An expectation can be:

```json
{
  "scope": "routing",
  "providers": [
    {
      "url": "https://hunter.x402.paywithlocus.com/hunter/company-enrichment",
      "assertions": [{ "pointer": "/body/domain", "equals": "stripe.com" }]
    }
  ]
}
```

Live expectations use `scope: "response"`, explicit `httpStatuses`, and response JSON-pointer assertions. At least one returned scalar per provider must appear in the final answer (`inAnswer: true`). Use this explicit mode for enrichment fields or numerical answers; it retains session, model, auto-mode, payment, receipt and per-call checks. Without an expectation file, the research citation checks remain required. Saved runs that failed those checks remain failed; the task-specific evidence above does not retroactively turn them into research-harness passes.

## Run the prepared demo

Use the directory and resolved launch command supplied by the setup agent. Preserve its existing policy and ledger; starting a new conversation does not require initializing another payment budget.

For the prepared mixed demo, verify `nativeFallback: true`, `nativeWebFetch: false` and `priceAware: true` in the existing config, then regenerate bridge settings as described below. These are presentation settings, not CLI defaults. For a prepared directory at `/tmp/tenjin-auto-live`, open your terminal and run:

```sh
cd /tmp/tenjin-auto-live
claude --model sonnet \
  --permission-mode auto --tools WebSearch \
  --settings /tmp/tenjin-auto-live/bridge-settings.json \
  --mcp-config /tmp/tenjin-auto-live/mcp.json \
  --setting-sources '' --strict-mcp-config \
  --disable-slash-commands --no-chrome
```

This opens an **empty interactive conversation**: no initial prompt, `-p`, `--continue`, or `--resume`. Complete any startup trust/login screen and verify Sonnet and auto mode in the UI. [Native auto mode requires a supported model and account configuration](https://code.claude.com/docs/en/permission-modes#eliminate-permission-prompts-with-auto-mode); Haiku is unsupported. If auto is unavailable, report that limitation rather than silently calling manual mode “auto.” Native permission mode and the x402 spending policy are separate controls.

This launch exposes the local x402 `request` tool and native WebSearch. Generated settings install the conditional prompt classifier, MCP execution hook, native-search gate and live footer; there is no SessionStart hook. Normal user/project settings, other MCP servers, slash commands and skills are excluded by these flags. Managed settings still apply. Do not use safe/bare mode or disable hooks: the bridge needs the hook to obtain a result. Keep normal session persistence enabled so Jev can read the transcript. Exiting Claude closes the child stdio bridge; no server is left running.

If the terminal wraps `claude` to inject integration hooks, use the resolved official Claude executable in the launch command. The terminal wrapper can add hooks independently of the settings flags above.

The bridge exposes one generic task-request tool. A host-selected page fetch had pinned the previous demo to CoinGecko URLs before Jev could consider CoinMarketCap; tool descriptions alone did not reliably prevent that. Jev now resolves whether a supplied URL is a requested document or only a suggested source for fresh data. Document requests retain deterministic exact-URL binding, and the selected operation still goes through the spending policy. No provider or cryptocurrency names are hardcoded into this routing distinction.

### What to say in the empty session

First:

```text
can you research BTC and ETH for someone new to crypto
```

After the answer:

```text
Check price for both now
```

The opener asks for research without naming a provider or tool. Jev classifies it at prompt submission, and Claude still decides whether to issue a tool call. Prices are allowed during research; the demo does not suppress that useful context. The second request resolves “both” from the conversation and asks for a new observation, even if the first answer already included prices. The generic routing rules distinguish a refresh from merely restating an earlier result. Conditional bridge guidance treats a new refresh as a new step, while avoiding duplicate execution within the current step. The earlier market-cap → “their prices” pair sometimes led Claude to reuse prices already returned in the first answer; that was not a second routing demonstration. Returned fields are not hidden to manufacture a reason for another call.

If you use the market-cap opener instead, “Check fresh quotes for both now” makes a new observation explicit when the first answer already contains prices. Check the saved outcomes to establish that a new request actually occurred. A new HTTP fetch does not guarantee the provider updated its market data after the user asked; show the provider's quote timestamps honestly.

Additional natural tasks:

```text
Find two authoritative explanations of how x402 payments work. Link both sources and briefly explain what each covers.
```

```text
Summarize this page in two sentences and link to it: https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works
```

While a request is running, the footer shows selection progress, then the selected endpoint and abbreviated parameters, for example `calling vaaya.ai/api/run/firecrawl/scrape · {"body":{"url":"…"}}`. It updates once per second from session-scoped local progress files. The footer makes no model, wallet or network calls; concurrent requests remain separate. Stale work is labeled stale rather than declared complete. Claude still owns the collapsed “Calling x402” heading. Use Ctrl+O to expand completed tool details. [Claude's status-line setting](https://code.claude.com/docs/en/statusline#manually-configure-a-status-line) provides the live footer.

A successful tool response starts with a short receipt identifying the actual supplying service/host, selected parameters and USDC amount. Long parameters are abbreviated there; full arguments remain in local outcomes. The bounded result envelope includes provider provenance and marks provider content as untrusted. Vaaya's listing advertises Firecrawl; that does not independently attest its backend implementation. Failed, refused or unresolved calls remain errors.

Firecrawl's own CLI default integration uses a different mechanism: `setup defaults` / `make default` adds native `WebSearch` and `WebFetch` to Claude's permission deny list, while its skill guides Claude to the Firecrawl CLI. It does not replace successful native results through a hook. The prepared mixed mode here retains native search behind a per-call Jev gate and sends page reads through the generic MCP request; the hook selects and executes the reader, and the bridge carries its result. [Firecrawl CLI implementation](https://github.com/firecrawl/cli/blob/6ff1658539fd676c7ebff23d7a1490f93d668f99/src/utils/web-defaults.ts).

The legacy hook-only transport denied Claude's native search/fetch after fulfilling the paid request; Claude rendered that as red `Error`. The bridge instead lets a local result carrier complete successfully. [PreToolUse supports input updates and permission decisions](https://code.claude.com/docs/en/hooks#pretooluse-decision-control), not successful native-tool result replacement. PostToolUse replacement runs after the original tool has already executed, so it would duplicate work here.

Tested provider prices were $0.007 Exa, $0.01 Vaaya and $0.01 CoinMarketCap per call. Every live quote must still pass the current listing and policy checks. Jev and Claude inference are separate costs. The interactive session does not inherit the headless runner's inference/turn caps. New policies default to $0.10/call and $1/run, with a 24-hour expiry established at initialization. An existing validation run was explicitly authorized for a $5 total cap; that is an operator-approved exception, not the default. Preserve the actual existing policy rather than resetting its budget or silently changing its cap.

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

Interactive calls write `state/progress/`, `state/outcomes/`, `state/events.jsonl`, `state/bridge-receipts/` and the payment ledger. Claude keeps its session transcript. `runs/<session>/` belongs to headless validation only. These files may contain private task data and stay local. Receipt files are private, expire after ten minutes, and are bound to the tool and request arguments; the bridge returns an error for a missing, altered or expired receipt. A failed/missing hook cannot cause the bridge to make a payment. Retain the ledger for reconciliation; never clear it to renew spending authority.

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
to $0.10/call, $1 total, 24 hours, and the eight exact method/URL scopes in
the exported demo catalog. Do not raise caps to fit a quote. An existing
operator-approved $5 cap stays in that existing policy; do not create a new
run to bypass its ledger or reservations.

Run demo-catalog --output <new-catalog-path> to export all eight capabilities
with raw captures and explicit schema-translation provenance. Pass --catalog-file
and leave discoveryQueries empty. This is a hand-selected Bazaar catalog.
Reference the env and wallet in place. Never reset a ledger or silently renew
an expired policy. For this mixed demo, set nativeFallback=true, nativeWebFetch=false and
priceAware=true without changing payment authorization. Run bridge-setup to
create isolated prompt/tool hooks, a one-second live footer and MCP configuration.
Verify paths, scope, caps and expiry; launch with --tools WebSearch.

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

```sh
mkdir -p /tmp/tenjin-auto-live
node dist/tenjin-auto-mode.mjs demo-catalog --output /tmp/tenjin-auto-live/catalog.json
```

```sh
node dist/tenjin-auto-mode.mjs init \
  --directory /tmp/tenjin-auto-live --mode live --native-fallback --price-aware \
  --env-file /absolute/path/to/existing.env --wallet-dir /absolute/path/to/existing/wallet \
  --catalog-file /tmp/tenjin-auto-live/catalog.json \
  --allow-resource POST:https://api.exa.ai/search POST:https://vaaya.ai/api/run/firecrawl/scrape GET:https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest POST:https://hunter.x402.paywithlocus.com/hunter/company-enrichment POST:https://hunter.x402.paywithlocus.com/hunter/email-verifier POST:https://apollo.x402.paywithlocus.com/apollo/people-enrichment POST:https://stableenrich.dev/api/companyenrich/properties-enrich GET:https://wolframalpha.x402.paysponge.com/v2/query
node dist/tenjin-auto-mode.mjs bridge-setup --config /tmp/tenjin-auto-live/config.json
```

For an existing prepared run, update the catalog and approved exact resource scopes as described above, then run **`bridge-setup`, not `init`**. `bridge-setup` adds the isolated footer and MCP configuration without changing config, policy, ledger, catalog or the legacy native settings. Restart Claude with the launch command above to load the updated configuration; an already-running session keeps its existing settings. The bridge starts as Claude's child process and reads config without importing credentials from the env file. The hook separately loads only the required Jev/wallet credential keys.

### Mixed and bridge-only profiles

The demo initialization above includes `--native-fallback`, exposing native search while keeping page reading on the hook-driven x402 path (`nativeWebFetch: false`). For a newly authorized bridge-only run, omit that flag and launch with `--tools ''`. For an existing prepared run, have the setup agent set `"nativeFallback": true` and `"nativeWebFetch": false` while preserving every other setting, the policy and ledger. Run `bridge-setup` again and start a fresh session. The setup installs a Jev-driven `UserPromptSubmit` classifier, the MCP `PreToolUse` executor and a value gate for native `WebSearch`. There is no SessionStart instruction hook or unconditional task instruction. The prompt classifier supplies generic bridge guidance only after Jev selects a suitable external capability; native, unresolved and failed decisions return no additional context. Native `WebFetch` is denied in settings and omitted from the launch tool list, so Claude requests page content through the generic MCP tool directly. The hook still chooses the service and arguments, validates and executes payment, and supplies a receipt to the bridge; Claude does not select Firecrawl itself.

Launch the same empty interactive session with native search additionally exposed:

```sh
cd /tmp/tenjin-auto-live
claude --model sonnet \
  --permission-mode auto --tools WebSearch \
  --settings /tmp/tenjin-auto-live/bridge-settings.json \
  --mcp-config /tmp/tenjin-auto-live/mcp.json \
  --setting-sources '' --strict-mcp-config \
  --disable-slash-commands --no-chrome
```

With `priceAware` omitted or false, Jev compares the eight paid capabilities with the ordinary host alternative using capability and fidelity, without minimizing price. A compatible dedicated extractor is preferred for page reads, including simple summaries of known public pages. This is a default preference, not an unconditional provider rule: explicit no-paid/native-only instructions and actual capability constraints still apply. Simple factual searches, basic arithmetic and conceptual explanations can remain native; structured fresh quotes, enrichment, deeper source research and nontrivial symbolic or numerical calculations favor suitable specialists. Calculations can benefit from an engine without the user naming one. Explicit no-paid, native-only or solely-by-hand constraints still govern. The task and requested evidence matter, not keywords such as “research.” The host still interprets results and handles ambiguity; Jev does not generate arbitrary new argument values or grant spending authority. Quote validation, spending caps and payment authorization remain deterministic in both routing modes.

The preference accounts for what the native tools return. Claude documents that WebFetch usually returns a smaller model's extracted answer rather than the raw page, and truncates large pages. [Official WebFetch behavior](https://code.claude.com/docs/en/tools-reference#webfetch-tool-behavior). Firecrawl documents Markdown/HTML extraction and page metadata, which support preferring a dedicated extractor for page reading. [Official Firecrawl scraping documentation](https://docs.firecrawl.dev/features/scrape). The Vaaya reseller contract exposes only its declared subset; these upstream docs do not prove that the reseller supports every Firecrawl feature. Jev receives native capability descriptions and generic fidelity rules, including missing fields or a reported native failure. The preference does not guarantee any provider's fulfillment.

When Jev chooses native through the bridge, it returns a successful `native_fallback` receipt without calling or paying an x402 provider. Claude can use native `WebSearch` or its own reasoning. If it needs to read a search result, it sends that exact URL through the MCP request tool; the hook selects a compatible page reader (currently Vaaya/Firecrawl) and the bridge returns its result normally. This applies to standalone page reads and page reads after a native search. There is no native-fetch attempt to block first. The router excludes unavailable native fetching from its choices, including at higher advertised prices; explicit no-paid constraints can require a decline rather than silently charging or inventing an unavailable fallback.

These decisions still use Jev inference, and Claude/native-tool charges remain separate; zero x402 payment does not mean zero cost. The prompt classifier and MCP tool description support request-first routing, while the native hook guards the exposed native search tool. A native search that bypasses request-first can still be denied when Jev selects a specialist; actual provider failures remain errors. The model can still ignore conditional guidance and answer without a tool call; a prompt decision is not execution evidence. In one test Claude answered a known Toronto webpage question without any tool call; that is not a Jev-native-routing demonstration. Validate the saved Jev decision and actual successful native tool result instead of inferring tool use from the final prose. The default bridge-only configuration keeps native tools hidden. To restore it, remove or disable `nativeFallback`, rerun `bridge-setup`, and return to `--tools ''` without changing the payment ledger.

For compatibility, older configs with `nativeWebFetch` omitted retain the previous native search/fetch behavior. To opt into that behavior deliberately, use `--native-web-fetch` together with `--native-fallback` on a new run, or set `nativeWebFetch: true`, rerun `bridge-setup`, and expose `WebSearch,WebFetch` in the launch command. That optional profile can still show a red denial when a native fetch is rerouted to a paid reader. The prepared demo uses `false`.

### Optional mild price awareness

For a newly authorized run, add `--price-aware` to `init`. For an existing run, have the setup agent set `"priceAware": true` in its config while preserving the rest of the config, payment policy and ledger; do not run `init` again or renew its budget. Set it to false or omit it to restore capability-first routing. This option does not expose native tools or change the launch command. `nativeFallback` controls native availability separately: with both options enabled, Jev can compare a paid specialist with an adequate native alternative; with only `priceAware`, PreToolUse routing compares the available paid capabilities. The prompt classifier separately always offers host reasoning as an abstention choice, even in bridge-only mode.

Before Jev selects a route, code summarizes supported advertised offers for exact Base USDC payments. Amounts are normalized with `BigInt` and six-decimal USDC units, without floating-point rounding. These are per-request advertised ceilings, not live quotes or whole-task cost estimates. When all supported alternatives have valid prices, the comparison uses their conservative maximum and also supplies the range. For example, offers capped at 0.01 and 0.10 USDC produce a 0.10 USDC comparison ceiling: the server need not offer the cheaper alternative in its live quote. Missing, invalid or partially priced supported alternatives make the overall price unknown; a known subrange is not a complete upper bound. Unknown never means free.

Price is a mild preference after capability fit. The contextual policy favors useful research coverage or page extraction at fractional-cent or few-cent prices; dollars for an ordinary search or short summary need a concrete benefit beyond what adequate native tools provide. These are semantic preferences, not deterministic tariff thresholds. Modest charges can also justify structured data or independent computation. A substantial premium for convenience can favor an adequate native alternative when available, but it cannot justify dropping required raw content, verification, a computational-engine check or an explicit source constraint. A higher price does not establish better quality. The same policy applies across the eight capabilities without provider-specific rules. Native tools have no x402 provider charge; their inference/tool costs are unknown, not zero.

The MCP route and native gate use the same preference. Neither the advertised-price summary nor Jev's decision authorizes spending. The executor still obtains and validates the actual quote, checks resource scope and spending limits, reserves the budget and controls signing and transmission. Enabling price awareness does not change those checks, cached paid results, unresolved reservations or retry identity.

## Validation

Read the [dated validation evidence](./auto-mode-validation.md) for observed outcomes and failures. The commands here are reproduction instructions, not claims that a new run has passed.

For paid research, the bridge harness checks actual auto mode and model identity, absence of native search/fetch, one to eight distinct MCP calls, successful corresponding tool results, current-event fulfilled outcomes, HTTP 200, valid amounts, receipt provenance/parameters and a final citation to a returned URL or supplying endpoint. It saves streams/reports and closes the Claude process group. Missing citations remain failed checks. Optional `--session-id <uuid>` then `--resume <same-uuid>` supports two-turn headless validation; the actual presentation starts empty without either flag.

To validate native fallback with the mixed-mode config, use `--transport bridge --expectation /tmp/native-expectation.json`, with an expectation such as:

```json
{ "scope": "native", "tools": ["WebSearch"] }
```

With the optional legacy `nativeWebFetch: true` profile, the expected tool list can contain `WebFetch` or both tools; the harness rejects WebFetch expectations when fetching is disabled. This checker requires actual successful native execution after the corresponding saved Jev gate decision, matching handoff evidence when MCP was used, and no x402 executor or provider result. A direct native call without its gate evidence fails. An answer with no tools also fails. Older recordings from the instruction-only setup do not establish the new gate behavior. Paid response expectations remain separate from this native checker.

### Reproduce checks

From the built PR checkout, run the calibration cohort first. This invokes Jev and can incur inference charges, but never executes a provider or signs a payment:

```sh
node dist/tenjin-auto-price-eval.mjs --cohort calibration \
  --env-file /absolute/path/to/existing.env --max-calls 60 \
  --output /tmp/price-calibration-01.json
```

The bundled held-out cohort was unseen for its original frozen run and has since been inspected. Re-running it now is a regression check, not new held-out evidence. For a new generalization claim, freeze a new uninspected set and policy first. The existing regression cohort can be run separately:

```sh
node dist/tenjin-auto-price-eval.mjs --cohort heldout \
  --env-file /absolute/path/to/existing.env --max-calls 60 \
  --output /tmp/price-heldout-01.json
```

The default model is `jev-latest`; `--model` can select an explicit model. Save each attempt to a new report path because the evaluator writes intermediate results to its output file. Retain failed and partial reports. Synthetic high-price offers are routing inputs only and are never executed. Review price-only choice changes separately from capability-preservation and equivalent-offer invariants: those invariants can pass while low and high prices produce the same choice, so their success alone does not demonstrate price sensitivity. Report deferrals and incomplete argument binding separately too. These small, curated cohorts do not estimate broad marketplace accuracy. Once held-out results inform an instruction change, label subsequent reruns as calibration or use a fresh held-out set.

```sh
node scripts/auto-mode-demo.mjs --transport bridge --model sonnet \
  --config /tmp/tenjin-auto-live/config.json \
  --prompt 'Find two authoritative explanations of how x402 payments work. Link both sources and briefly explain what each covers.'
```

This opt-in live command can make multiple paid calls. It uses a 180-second timeout, eight-turn limit and $0.50 Claude inference cap per invocation, plus the shared payment policy. It does not impose those inference limits on the interactive launch. The legacy native harness remains available with `--transport native --model haiku --tool auto`; it deliberately expects tool denials and uses `dontAsk` plus native `ask` rules for fallback protection.

Focused local checks for implementation changes (documentation-only changes need formatting and link checks, not live calls):

```sh
pnpm exec vitest run src/experimental/auto-mode --maxWorkers 2
pnpm test:auto-mode-harness
# In a managed workspace, use its scripts/check --path . for static/package checks.
```

## Open marketplace and execution boundaries

The importer generates a versioned JSON contract from Bazaar descriptions, payment advertisements and supported machine-readable schemas, with source hashes. It never downloads/executes third-party `SKILL.md`, shell code or generated JavaScript. Provider branding in receipts is display metadata, not routing logic. Without `catalogFile`, optional dynamic discovery queries CDP, interleaves/deduplicates results and caps candidates at 20. Twelve tested provider-free queries did not reliably surface the approved demo services; improving retrieval is follow-up work.

The [saved catalog audit](./auto-mode-catalog-coverage.json) covers 14,986 records across 150 pages: 8,050 contracts validate and 6,936 are explicitly unsupported. The API's curated flag yielded 58/86; it is not claimed to equal agentic.market's curated collection. Enumeration has no transactional snapshot guarantee. Compilation is not paid execution. Every listing can receive an actionable status, but the MVP cannot execute every Bazaar entry or translate arbitrary prose-only documentation. Missing schemas, unsupported constraints and unknown primitives fail explicitly.

For exact page fetching, code filters out contracts without a declared target URL binding or exact direct resource, and rejects final arguments that change that URL. Underspecified target fields remain unsupported. The same generic checks apply to new providers; no provider-name dispatch is introduced. Broader informational searches can still select structured price endpoints.

Jev chooses source spans and schema values, can compose up to eight selected members per field across at most two fields (16 total), and finally selects a complete schema-valid argument set. Up to six optional fields yield at most 64 candidate sets. No payment judgment is delegated to a model. Route selection is bounded to 20 capabilities and 60 argument leaves. Jev requests are limited to 1 MiB and responses to 1,000,000 bytes. Current-session user/assistant text is limited to 48,000 serialized characters and the transcript file to 4,000,000 bytes; tool-result history, other sessions, subagents and compacted/malformed/oversized transcripts are unsupported. Native domain filters are rejected rather than dropped. Rejected transcript shapes are not silently summarized into a partial history. The prompt path supports an empty first-turn transcript and adds the current prompt.

Payment execution supports x402 v2 `exact`, Base native USDC, validated HTTP query/body/path/header contracts and explicit action scope. A lock claims each attempt; budget is reserved before signing and policy rechecked before signing/transmission. Ambiguous transmissions retain their reservation and are never automatically re-signed. Replaying a completed event returns cached evidence. Within the same user turn, an unresolved paid attempt blocks another request to that capability even with a new tool-use ID or changed arguments; other capabilities can proceed independently. This does not deduplicate all semantically equivalent successful requests. A separate typed workflow executor supports up to ten ordered steps and prior-result bindings; automatic multi-step Jev planning is not wired in. The Exa/Tavily chain test is synthetic.

The local catalog can attach an operator-owned JSON result contract to an exact method/URL. Wolfram's rule requires `success: true`, `error: false`, at least one pod and a nonempty pod array. It rejects known no-result responses before fulfillment, preserving their payment evidence, but does not prove the answer or requested precision. The other curated capabilities generally treat HTTP 2xx as fulfilled without an application-success rule; content accuracy and usefulness remain separate. Remote Bazaar records cannot define this trusted local rule.

Provider connections validate DNS/destinations and reject private addresses, credentials, custom ports and redirects. Nested scraper targets receive public HTTPS/DNS checks, which cannot control the remote scraper's later behavior. Provider results are untrusted. The local receipt files, wallet and policy are not isolation from malicious code running as the same OS user. The hook has a 70-second deadline under Claude's 90-second hook timeout. The bridge fails closed without a valid result receipt; it cannot force Claude to request a tool or to interpret the result correctly.
