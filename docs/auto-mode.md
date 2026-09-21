# Local Jev → x402 experiment

This draft routes research, page-reading, pricing, enrichment and computation requests through a local `PreToolUse` hook. Jev selects a capability and its arguments; code validates the request, authorization, quote and budget, then pays and executes. A tiny local stdio MCP bridge returns the saved result as a successful tool response. It has no hosted backend and cannot route, sign or call a provider itself.

The demo has eight capabilities: Exa search, Vaaya/Firecrawl scraping, CoinMarketCap quotes, four GTM enrichment endpoints and Wolfram Alpha through Sponge. Seven are unchanged CDP Bazaar listings. Wolfram requires an explicit, documented input translation. Claude sees one generic `request` tool and describes what it needs; Jev selects the capability and arguments. This demonstrates routing within the curated catalog, not automatic discovery across the entire Bazaar.

The single entrypoint keeps Claude from prematurely choosing page scraping when the user asked for current facts. A requested page URL can be included in the query; Jev distinguishes reading that document from using a previously cited page as an optional source. Legacy search/fetch receipt delivery remains supported internally but those tools are not advertised.

A `UserPromptSubmit` check first asks Jev whether an available capability would help the current request. Native, unresolved and failed decisions add no instructions. A selected route adds one generic instruction to call the request bridge next, by itself, and wait for its result before any other tool call. A fulfilled step should not be duplicated; native tools for that step require an explicit bridge fallback. No task-specific instruction or skill is injected. This stage performs no provider request, quote, payment or execution. `PreToolUse` independently selects and validates the actual tool request before execution.

Jev receives the pending request and bounded user/assistant text from the current session, including prior answers and corrections. Its choice API selects exact available values and bounded list compositions; it cannot generate arbitrary new arguments. A missing value returns `needs_input`. Payment authorization is deterministic and automatic within the local policy. Claude interprets the returned content and decides how to continue.

Optional mixed mode also lets Jev choose ordinary Claude tools when they suit the task. The default preference is capability and fidelity first: use a compatible dedicated page extractor for page reads, even simple known pages. Optional `priceAware` adds a mild price comparison after capability fit. Native search and host reasoning remain available in mixed mode, and explicit no-paid/native-only instructions take precedence. Spending authorization and hard limits still run in code. The default setup below continues to expose only the x402 bridge. See the mixed-mode setup before enabling native tools.

## Endpoint catalog

| Capability                            | Supplying endpoint                 | Advertised USDC | Observed support                                  |
| ------------------------------------- | ---------------------------------- | --------------: | ------------------------------------------------- |
| Web search                            | Exa                                |          $0.007 | Paid research requests verified                   |
| Page reading                          | Vaaya/Firecrawl                    |           $0.01 | Paid exact-page requests verified                 |
| Cryptocurrency quotes                 | CoinMarketCap                      |           $0.01 | Paid BTC/ETH quotes verified                      |
| Company enrichment by domain          | Hunter through Locus               |          $0.013 | Paid Stripe company profile returned              |
| Email verification                    | Hunter through Locus               |          $0.008 | Paid public-address verification returned         |
| Person enrichment                     | Apollo through Locus               |          $0.038 | Paid professional profile returned                |
| Company enrichment by name/social URL | CompanyEnrich through StableEnrich |           $0.06 | Paid Stripe company profile returned              |
| Mathematical computation              | Wolfram Alpha through Sponge       |           $0.02 | Paid integral result verified on the second query |

These are catalog prices, not guarantees of current availability or fulfillment. Exact live quotes must match the catalog and spending policy. Reseller names identify the actual supplier, not an independent attestation of its upstream implementation. [Locus lists Hunter and Apollo](https://paywithlocus.com/tools), and [StableEnrich documents CompanyEnrich](https://stableenrich.dev/docs).

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

### Expansion test evidence

The initial eight-capability catalog passed seven live Jev routing cases in 20 model requests: company enrichment, email verification, person enrichment, computation, company-reference resolution, plus the existing price and exact-document regressions. The batch made zero provider requests or payment signatures. These are observed choices with native fallback disabled, not paid-versus-native benchmark results. Headless Sonnet auto-mode runs also validated company and math routing using the real transcript with zero provider execution. Four GTM unsigned quotes matched their advertised Base USDC terms.

Paid headless tests then produced these results:

| Task                                      | Saved provider result                                                                                                 | Payment evidence                                   | Strict research harness                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Company lookup by `stripe.com`            | Hunter/Locus returned a nonempty company profile, HTTP 200                                                            | $0.013; reported settlement                        | Execution/receipt checks passed; both clickable-citation checks failed                                                 |
| Company lookup by `Stripe`                | CompanyEnrich/StableEnrich returned a nonempty profile, HTTP 200                                                      | $0.06; reported settlement                         | Execution/receipt checks passed; exact citation-destination check failed because a returned tracking query was removed |
| Public business email verification        | Hunter/Locus returned `valid`, score 100, HTTP 200 for `info@stripe.com`; no message sent                             | $0.008; reported settlement                        | Execution/receipt checks passed; both clickable-citation checks failed                                                 |
| Definite integral                         | First Wolfram response had no result; second returned `π² − 4 ≈ 5.8696`, matching an independent antiderivative check | Two $0.02 calls, $0.04 total; reported settlements | Execution/receipt checks passed; both clickable-citation checks failed                                                 |
| Natural professional-person lookup        | First call needed input; Claude then selected a Vaaya/Firecrawl public biography lookup                               | $0.01 for the page read                            | This did not exercise Apollo paid enrichment and is not an Apollo success                                              |
| Subsequent professional-person enrichment | Apollo/Locus returned a matched professional profile for Tim Cook at `apple.com`, HTTP 200                            | $0.038; reported settlement                        | All 20 checks passed, including clickable citations                                                                    |

These receipts are provider-reported; settlement was not independently queried on-chain for this expansion. Successful enrichment delivery does not establish the independent accuracy of every profile field. The CompanyEnrich result contained conflicting employee/location fields, which the answer disclosed. Apollo returned a role that conflicted with the separately fetched official biography in the saved runs; profile freshness was not independently resolved. The Apollo request explicitly disabled personal-email and phone-number enrichment. Wolfram's second response verified the mathematical result, but its first paid response did not, and the final prose abandoned a manual derivation before restating the correct value. Transport success, task evidence and citation presentation remain separate checks.

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

Only the local x402 `request` tool and its hook are configured. Normal user/project settings, other MCP servers, slash commands and skills are excluded by these flags. Managed settings still apply. Do not use safe/bare mode or disable hooks: the bridge needs the hook to obtain a result. Keep normal session persistence enabled so Jev can read the transcript. Exiting Claude closes the child stdio bridge; no server is left running.

If the terminal wraps `claude` to inject integration hooks, use the resolved official Claude executable in the launch command. The terminal wrapper can add hooks independently of the settings flags above.

The bridge exposes one generic task-request tool. A host-selected page fetch had pinned the previous demo to CoinGecko URLs before Jev could consider CoinMarketCap; tool descriptions alone did not reliably prevent that. Jev now resolves whether a supplied URL is a requested document or only a suggested source for fresh data. Document requests retain deterministic exact-URL binding, and the selected operation still goes through the spending policy. No provider or cryptocurrency names are hardcoded into this routing distinction.

The four focused live Jev cases for this handoff passed in 16 model requests with no provider calls: the generic price follow-up selected CoinMarketCap with `symbol=BTC,ETH`; the same need with a suggested CoinGecko page still selected CoinMarketCap; an explicit x402 document request selected Vaaya with the exact URL; and x402 source discovery selected Exa. In the subsequent interactive recording, the research opener and unchanged price follow-up each made a separate successful CoinMarketCap request for `BTC,ETH`, costing $0.01 each. The follow-up's displayed prices and percentage changes matched the delivered quotes; its provider data was about 101 seconds old and the displayed timestamp identified the quote minute. This is observed behavior, not a guarantee of identical model choices on every run.

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
an expired policy. Run bridge-setup on the config to create only isolated
bridge settings, a one-second live service footer and MCP configuration. Verify paths, scope, caps and expiry.

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
  --directory /tmp/tenjin-auto-live --mode live \
  --env-file /absolute/path/to/existing.env --wallet-dir /absolute/path/to/existing/wallet \
  --catalog-file /tmp/tenjin-auto-live/catalog.json \
  --allow-resource POST:https://api.exa.ai/search POST:https://vaaya.ai/api/run/firecrawl/scrape GET:https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest POST:https://hunter.x402.paywithlocus.com/hunter/company-enrichment POST:https://hunter.x402.paywithlocus.com/hunter/email-verifier POST:https://apollo.x402.paywithlocus.com/apollo/people-enrichment POST:https://stableenrich.dev/api/companyenrich/properties-enrich GET:https://wolframalpha.x402.paysponge.com/v2/query
node dist/tenjin-auto-mode.mjs bridge-setup --config /tmp/tenjin-auto-live/config.json
```

For an existing prepared run, update the catalog and approved exact resource scopes as described above, then run **`bridge-setup`, not `init`**. `bridge-setup` adds the isolated footer and MCP configuration without changing config, policy, ledger, catalog or the legacy native settings. Restart Claude with the launch command above to load the updated configuration; an already-running session keeps its existing settings. The bridge starts as Claude's child process and reads config without importing credentials from the env file. The hook separately loads only the required Jev/wallet credential keys.

### Optional paid-versus-native routing

For a newly authorized run, add `--native-fallback` to the `init` command above. This exposes native search while keeping page reading on the hook-driven x402 path (`nativeWebFetch: false`). For an existing prepared run, have the setup agent set `"nativeFallback": true` and `"nativeWebFetch": false` while preserving every other setting, the policy and ledger. Run `bridge-setup` again and start a fresh session. The setup installs a Jev-driven `UserPromptSubmit` classifier, the MCP `PreToolUse` executor and a value gate for native `WebSearch`. There is no SessionStart instruction hook or unconditional task instruction. The prompt classifier supplies generic bridge guidance only after Jev selects a suitable external capability; native, unresolved and failed decisions return no additional context. Native `WebFetch` is denied in settings and omitted from the launch tool list, so Claude requests page content through the generic MCP tool directly. The hook still chooses the service and arguments, validates and executes payment, and supplies a receipt to the bridge; Claude does not select Firecrawl itself.

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

For a newly authorized run, add `--price-aware` to `init`. For an existing run, have the setup agent set `"priceAware": true` in its config while preserving the rest of the config, payment policy and ledger; do not run `init` again or renew its budget. Set it to false or omit it to restore capability-first routing. This option does not expose native tools or change the launch command. `nativeFallback` controls native availability separately: with both options enabled, Jev can compare a paid specialist with an adequate native alternative; with only `priceAware`, it compares the available paid capabilities.

Before Jev selects a route, code summarizes supported advertised offers for exact Base USDC payments. Amounts are normalized with `BigInt` and six-decimal USDC units, without floating-point rounding. These are per-request advertised ceilings, not live quotes or whole-task cost estimates. When all supported alternatives have valid prices, the comparison uses their conservative maximum and also supplies the range. For example, offers capped at 0.01 and 0.10 USDC produce a 0.10 USDC comparison ceiling: the server need not offer the cheaper alternative in its live quote. Missing, invalid or partially priced supported alternatives make the overall price unknown; a known subrange is not a complete upper bound. Unknown never means free.

Price is a mild preference after capability fit. The contextual policy favors useful research coverage or page extraction at fractional-cent or few-cent prices; dollars for an ordinary search or short summary need a concrete benefit beyond what adequate native tools provide. These are semantic preferences, not deterministic tariff thresholds. Modest charges can also justify structured data or independent computation. A substantial premium for convenience can favor an adequate native alternative when available, but it cannot justify dropping required raw content, verification, a computational-engine check or an explicit source constraint. A higher price does not establish better quality. The same policy applies across the eight capabilities without provider-specific rules. Native tools have no x402 provider charge; their inference/tool costs are unknown, not zero.

The MCP route and native gate use the same preference. Neither the advertised-price summary nor Jev's decision authorizes spending. The executor still obtains and validates the actual quote, checks resource scope and spending limits, reserves the budget and controls signing and transmission. Enabling price awareness does not change those checks, cached paid results, unresolved reservations or retry identity.

## Validation

For paid research, the bridge harness checks actual auto mode and model identity, absence of native search/fetch, one to eight distinct MCP calls, successful corresponding tool results, current-event fulfilled outcomes, HTTP 200, valid amounts, receipt provenance/parameters and a final citation to a returned URL or supplying endpoint. It saves streams/reports and closes the Claude process group. Missing citations remain failed checks. Optional `--session-id <uuid>` then `--resume <same-uuid>` supports two-turn headless validation; the actual presentation starts empty without either flag.

To validate native fallback with the mixed-mode config, use `--transport bridge --expectation /tmp/native-expectation.json`, with an expectation such as:

```json
{ "scope": "native", "tools": ["WebSearch"] }
```

With the optional legacy `nativeWebFetch: true` profile, the expected tool list can contain `WebFetch` or both tools; the harness rejects WebFetch expectations when fetching is disabled. This checker requires actual successful native execution after the corresponding saved Jev gate decision, matching handoff evidence when MCP was used, and no x402 executor or provider result. A direct native call without its gate evidence fails. An answer with no tools also fails. Older recordings from the instruction-only setup do not establish the new gate behavior. Paid response expectations remain separate from this native checker.

### Mixed-mode validation

With price awareness off and native WebFetch available, the capability-first policy passed all 33 labeled routing cases: 20/20 in 40 Jev calls and 13/13 in 24 calls, with zero provider requests or payment signatures. Both the paid/native choices and complete arguments matched. Three unchanged page-reading prompts now expect the dedicated extractor because the operator preference changed; a new explicit native-only/no-paid page case still selects native. This is a calibrated regression set, not an independent performance estimate. Earlier 15/16, 19/20 and argument-binding failures remain recorded. Generic binding rules were corrected to preserve explicit formats and distinguish serialization formats from content elements such as headings or tables.

A new ordinary-page headless run confirmed the changed default: Jev selected Firecrawl, paid $0.01, and delivered HTTP 200 with Markdown and page metadata. It passed 19/20 checks. The remaining failure was exact title presentation: Claude shortened `How x402 works - Coinbase Developer Documentation` to `How x402 works`, despite receiving the full title. Citation validation passed. This establishes routing and delivery, not perfect host formatting.

The completed eight-capability mixed-mode batch passed explicit response expectations for Hunter company enrichment ($0.013), CompanyEnrich ($0.06), Apollo person enrichment ($0.038), Hunter email verification ($0.008), CoinMarketCap BTC/ETH quotes ($0.01), Wolfram computation ($0.02), Exa research ($0.007), and Vaaya/Firecrawl page extraction ($0.01). Those eight successful provider calls totaled $0.166 USDC, excluding earlier attempts and the subsequent $0.01 ordinary-page run above. Each used one paid bridge request and checked returned public fields against the final answer. Wolfram received `integrate x^2 sin(x) dx from 0 to pi` and returned `π² − 4 ≈ 5.8696`; the answer quoted the engine's result verbatim and correctly checked the antiderivative. These checks verify response shape and at least one exact returned scalar; they do not independently establish every profile field's freshness or every rounded market number. Compatible settlement receipts were provider-reported; CoinMarketCap's receipt remained unverified.

The earlier mixed-mode math attempt selected Wolfram but its unsigned quote request timed out after 20 seconds, before any signed payment. It then tried native tools under the instruction-only setup, so that failed run remains recorded. The bypass motivated the native `PreToolUse` gate; the subsequent gated math run is the separate successful result above.

Both gated native paths also passed: a Toronto current-weather lookup used the MCP native handoff, its own native gate, and actual `WebSearch`; an exact `https://example.com` page read used the handoff, native gate and actual `WebFetch`. Each made zero x402 provider requests or payments. The WebFetch run is historical transport evidence with native fetching available. The prepared demo now disables that alternative; a native-only exact page request must decline if no permitted reader is available. The earlier zero-tool Toronto answer is still excluded from this evidence.

The initial mixed-mode full-Markdown test failed: Jev repeatedly chose native despite the required output, and no Firecrawl payment occurred. An intermediate paid attempt also exposed a preview that omitted the page title. After the generic fidelity and preview corrections, the final run selected Firecrawl and passed its execution and response expectations, including the returned title. Its citation checker initially included the closing backtick of a code-wrapped URL. Correcting that parser and regrading the same saved stream produced all 20 passing checks, without another provider request or payment. The original report and input hashes remain preserved; the earlier routing and preview failures remain separate records.

Before optional price awareness, focused validation passed 247 TypeScript tests across 14 relevant files; the nine policy/fixture tests passed again after the preference change. All 60 Node harness tests and workspace lint, formatting, typecheck and package smoke passed. Live routing and provider runs are opt-in; ordinary tests and CI do not make paid requests.

### Hook-driven page reads after native search

The prepared mixed-mode profile (`nativeWebFetch: false`, `priceAware: true`) passed three headless Sonnet runs in auto mode. The unchanged prompt “What's the weather in Toronto right now?” used actual native WebSearch and passed all 17 native checks with no x402 payment. An explicit Weather Network page request passed all 20 paid research checks: the hook selected Vaaya/Firecrawl, preserved the exact URL and returned HTTP 200 through the bridge for 0.01 USDC. Resuming the native-search session with “Read the Weather Network source page to verify those conditions.” also passed all 20 checks through one hook-selected Firecrawl request, costing 0.01 USDC. Neither page-read prompt named a provider, and neither run attempted native WebFetch or showed a tool error.

These runs establish the search-to-page transport and hook-owned provider choice. They do not establish live-second weather accuracy: Firecrawl returned a page dated the previous day, and the final answer disclosed that staleness and its disagreement with the earlier search summary. Both settlements were provider-reported. The earlier research run's concurrent-call failure below remains a separate limitation; this change removes the unavailable native-fetch route, not genuine provider or concurrency errors.

Focused offline validation for this profile passed 129 tests across six TypeScript files and all 60 Node harness tests. It covers exact-page binding, omitted/true legacy compatibility, native search availability, disabled-fetch setup and receipt validation, no-paid constraints and unsupported readers. Availability is enforced in routing and setup; it does not depend on Claude choosing Firecrawl from an instruction.

### Natural math and conditional prompt routing

The short prompt `integrate x^2 sin(x) dx from 0 to pi` is now the math demo. No provider, engine or response-format instruction is needed in the user prompt. The prompt hook uses the same Jev router and curated catalog, with native reasoning available as an abstention choice. It appends the submitted prompt to bounded prior session context, retains current policy resource filtering and records the decision separately from tool outcomes. Only a selected route emits the same fixed, provider-free bridge instruction. Missing context, unresolved intent and classifier failures add nothing. The subsequent PreToolUse hook makes a fresh selection from the actual call; the prompt decision is neither a paid result nor a cached authorization.

Five natural-math routing regressions passed in nine Jev requests with price awareness enabled and native fetching disabled: the plain integral and a numerical root task selected Wolfram with complete input bindings, while multiplication, a conceptual explanation and a later by-hand/no-paid correction selected native. This is route-only evidence, with zero provider requests or signatures.

In a fresh headless Sonnet auto-mode session, the unchanged integral prompt produced a recorded Jev prompt selection, one generic MCP request and one fulfilled Wolfram response. PreToolUse bound `input=integrate x^2 sin(x) dx from 0 to pi` and `output=json`; the provider returned HTTP 200, `success: true` and `π² − 4 ≈ 5.8696` for 0.02 USDC with a reported settlement. The final answer matched the result, also checked using the antiderivative `−x² cos(x) + 2x sin(x) + 2cos(x)`. The existing strict response harness passed 18/20 checks: it rejected the answer for not quoting the entire provider result line verbatim and for linking a constructed WolframAlpha query URL rather than a returned citation. This is successful routing, execution and mathematical output, not a full citation/formatting pass.

The control `What is 17 * 23?` recorded Jev's native decision with `injected: false`; Claude answered `391` without tools or payment. Resuming the integral session with `Now do it by hand, without paid tools.` likewise recorded a native decision with no guidance, then a manual derivation and no new tool call or payment. These are prompt-routing controls, not paid-research harness passes. Before adding the conditional classifier, both tested variants of the short integral prompt were solved correctly without any tool call; that did not exercise Jev or Wolfram. Conditional guidance can still be ignored by the host, so observe actual calls and outcomes rather than treating a prompt selection as fulfillment.

The headless report's `promptGate` field includes fresh, session-and-prompt-matched audit metadata separately from payment and execution checks. Focused validation passed 178 TypeScript tests across nine files and 55 Node harness tests, plus workspace lint, formatting, typecheck and package smoke. No test or ordinary CI run makes live model or payment calls.

### Request ordering after a selected prompt route

An interactive BTC/ETH run exposed a sequencing gap: the conditional hint required the bridge before presenting the answer, which still allowed native searches before or alongside it. The hint now requires the bridge as the next call, alone, and waiting for its result. A fulfilled step should not be repeated, and native tools for that step require an explicit fallback. This remains a fixed instruction emitted only after Jev selects a capability; no provider-specific prompt rule or payment path changed. Native `PreToolUse` remains a truthful backstop, so an ignored hint can still produce a denial.

Two headless Sonnet sessions used `can you research BTC and ETH for someone new to crypto`, followed by `Check price for both now`; the second preserved the pasted-text wrapper from the reported session. Both price follow-ups called the bridge directly, bound CoinMarketCap to `symbol=BTC,ETH`, and returned HTTP 200 with no native search or tool error. The first price run passed 19/20 checks: its rounded prices matched, but Claude linked the API origin instead of the returned endpoint. The second passed 20/20. The plain research turn passed 20/20 through sequential Exa and Firecrawl calls. The pasted research turn remains failed: Exa succeeded, but additional price/YTD and simplified price requests each returned `needs_input`, followed by an allowed native search. Every initial bridge call ran alone and completed before the next call; none of these four turns showed the original `paid_preferred` denial. Fulfilled calls totaled 0.044 USDC. These observations support the ordering change, not a guarantee of error-free orchestration or argument selection.

The unchanged Toronto weather control recorded a native prompt decision with no added guidance, then actual gated native WebSearch and all 17 checks passed with no x402 payment. The 24 focused prompt/native-gate tests and workspace lint, formatting, typecheck and package smoke passed. The `needs_input` outcomes record final complete-call rejection but do not retain rejected argument candidates, so these artifacts alone do not establish which constraint or value caused those deferrals.

### Refreshing observations already present in the conversation

A new tool-call ID triggers a new provider request even when the endpoint and arguments match an earlier call. Only redelivery of the same completed tool call replays its saved response. A generic integration regression exercises both the runtime and executor: two user turns receive mocked observations v1 then v2 through two transport requests; replaying the second call returns cached v2 without a third request or signing. Routing guidance now explicitly distinguishes a new refresh from restating prior observations. It preserves source and no-paid constraints and adds no topic-specific rule.

A headless Sonnet session that already contained a successful CoinMarketCap BTC/ETH quote was resumed with the unchanged `Check price for both now`. Jev selected CoinMarketCap at prompt submission, then the actual tool call made a new uncached HTTP 200 request with `symbol=BTC,ETH` for 0.01 USDC. Claude reported updated figures without native searches or tool errors. The strict harness passed 19/20 checks; the remaining failure was its link to the API origin rather than the returned quotes endpoint. A new HTTP response does not establish that provider observations were generated after the user prompt. The separate `needs_input` rejection seen during research remains unresolved: routing-only replays alternated between a valid complete quote request and abstention, and scope/date wording probes did not establish a reliable fix. Those probes made no provider requests or payments; no speculative binding change was adopted.

The 87 focused routing/prompt tests, six runtime tests and workspace lint, formatting, typecheck and package smoke passed. This evidence establishes request freshness and same-call replay behavior, not guaranteed host compliance or universal argument-selection accuracy.

### Concurrent requests to one capability

The reported research session attempted two different Firecrawl pages together. The second received a zero-payment `pending` response while the first payment was in flight; its later retry failed Jev's scope classifier before reaching the provider. The executor now distinguishes active work from an unresolved failure: a distinct request waits outside the ledger mutex for up to ten seconds, then repeats policy, conflict and budget checks. The wait budget is shared across initial claim and reservation. Identical in-flight requests, ambiguous attempts and completed paid failures remain blocked. A persisted signing/transmission state is never reclaimed automatically, even if its owner has exited. Timeout preserves the other attempt and cancels only this request's unsigned zero-cost claim, if one exists.

A live probe launched two separate bridge-hook processes for the exact Ethereum and Coin Bureau page URLs. These explicit fetch events isolated execution from neutral-request scope classification; they were not Claude-generated tool calls. Both received HTTP 200 from Vaaya/Firecrawl with the correct distinct target, 0.01 USDC each and reported settlement receipts. The ledger trace observed both zero-cost prepared attempts, then the first signing/transmitting while the second remained prepared. Only after the first completed did the second reserve and sign. This exercises cross-process payment serialization under the unchanged run policy and ledger. Different capabilities and unsigned quotes can still run concurrently.

The earlier headless Sonnet two-page test passed all 20 transport/receipt/citation checks for three fulfilled calls totaling 0.03 USDC, but it was sequential and once selected Ethereum when the pending request named Coin Bureau. It therefore does not validate concurrency or correct page selection. The separate concurrent hook probe cost 0.02 USDC. That scope-selection limitation remains; the queue fix adds no routing instruction or provider-specific rule.

All 88 executor tests and 44 runtime/bridge tests passed, covering distinct-request waiting, duplicate blocking, concurrent quote reservation, persisted unresolved states, bounded timeout cleanup, queued revocation, paid failure and exhausted budget. Workspace lint, formatting, typecheck and package smoke also passed. A slow or unresolved peer can still produce a truthful pending result after the bounded wait; no payment guard is bypassed to remove an error.

### Harder numerical demo

Use the provider-neutral prompt `Evaluate ∫₀¹ e^(−x²) cos(37x) dx to 12 decimal places.` The independently calculated answer is **−0.006801048333**. A Decimal power-series calculation and an independently implemented composite Gauss–Legendre quadrature agreed at high precision; a third, double-precision Simpson check also rounded to the same twelve decimal places. The reference and criteria were frozen before either model run.

One isolated, high-effort Sonnet run with no tools, hooks, skills or MCP servers answered **+0.000000007430**, which is wrong. It printed purported command output despite making no tool calls. This is one preselected problem and one unaided response, not proof that Sonnet can never solve the integral or that Wolfram is required when local computation is available.

With the same prompt in the prepared auto-mode session, Jev selected Wolfram at prompt time and again in the execution hook. One uncached Sponge/Wolfram call returned HTTP 200 for 0.02 USDC, with provider-reported settlement. Its result was `-0.00680104833279 + 0.×10^-14 i`; the real component agrees with the frozen reference at its returned precision, and the zero imaginary term is numerical residue. Claude delivered **−0.006801048333**, correctly rounded from the returned digits. It used no native tools. The raw provider result, delivered preview and final rounded answer are checked separately.

The strict response harness passed 19/20 checks: the answer did not reproduce the first input pod verbatim, so that assertion remains failed. The numerical comparison is separate and does not relabel that run as a full harness pass. Claude inference cost $0.0428252 for the paid run and $0.0158234 for the unaided baseline, excluding Jev and the 0.02 USDC provider charge. An earlier sandbox attempt failed DNS before any tool call; it is infrastructure failure, not mathematical evidence. The old simple-integral timeout and its reservation were not retried or cleared.

### Native continuation after a provider outage

A received paid HTTP 5xx response remains a failed request, with its amount, provider response and settlement evidence preserved. When native fallback is configured, the runtime can ask Jev whether available native tools still satisfy that same step. This recovery choice offers only native continuation or abstention; it cannot select another paid service. It preserves explicit provider, source, output and privacy constraints. An ambiguous transmission, a client error, an unavailable native page reader or a failed recovery check does not produce a handoff.

An approved continuation is saved privately for the current session, user turn, runtime mode and native tool, with a ten-minute expiry and an exact URL for page reads. The native hook rechecks the pending call against the original failed step with no paid candidates, so it cannot redirect the recovery back to the failed provider. A later user turn is a new decision. The bridge keeps the failed result visible, tells the host to disclose possible spending, and permits native continuation without another permission question. It does not refund, retry or rewrite the paid attempt. This is conditional failure handling, not a SessionStart instruction. Slow recovery classification is bounded and skipped when the hook has little time remaining.

The September 21 Exa incident returned HTTP 503 with `SERVICE_OVERLOADED` and a provider-reported settlement for 0.007 USDC. A subsequent explicitly requested, single recovery probe through the unchanged policy and ledger returned HTTP 200 and ten results for another 0.007 USDC; the original failed charge remained accounted for. Exa's payment-quote endpoint being reachable alone would not have established search recovery.

A frozen eight-case Jev-only check passed all eight expectations without provider requests or payments: BTC/ETH research, x402 source discovery and basic multiplication permitted native continuation; explicit Exa-only research, an exact page with native fetching disabled, required computational-engine evidence, Hunter deliverability fields and official CoinMarketCap API quote fields did not. These are small semantic regression checks, not a general recovery-accuracy claim. Provider transport recovery and host compliance with a native handoff are separate observations.

One isolated headless Sonnet test passed 13 frozen checks: the real prompt gate selected Exa, an execution stub returned one explicitly synthetic HTTP 503 with zero charge, the real runtime saved the continuation and the real bridge delivered the failed receipt, and three native WebSearch calls passed the live Jev gate. Claude finished linked BTC/ETH research, disclosed the synthetic/no-charge failure and asked no permission question. It made no second bridge call, provider request or signature. This test used eight Jev calls and reported $0.1473692 Claude inference. It proves host continuation with simulated failure, separately from the live Exa recovery probe and the executor-ledger regression; no paid failure was deliberately generated to test the UI.

The 171 focused runtime, routing, native-gate, bridge, prompt and continuation-store tests passed. A real-executor regression uses a synthetic transport and signer to show that native continuation preserves the failed paid ledger row byte-for-byte and that a changed-tool-ID retry cannot sign or transmit again. Separate tests cover classifier timeout, unavailable native tools, explicit abstention, expired/corrupt markers, and cross-session/turn/mode isolation.

Search continuations currently keep one failure record per user turn. Concurrent search failures can replace earlier request evidence and make an earlier continuation decline; this does not authorize another payment. Corrupt or unreadable handoff records stop routing without suggesting a paid retry.

A pending execution is not evidence of zero spend. The hook now explicitly warns the host not to infer “no charge” from a timeout. In the reported simple-integral timeout, the saved attempt remained at `signing` with 0.02 USDC reserved; the executor had not persisted its pre-transport `transmitted` state. A read-only wallet check completed in 2.35 seconds, so routine wallet decryption did not reproduce the earlier stall. The reservation remains untouched, and the stall cause is unresolved.

### Price-aware validation

With native WebFetch available, the frozen price policy completed 12 calibration cases and then eight held-out cases, with no provider requests or payment signatures. Instructions were frozen before the held-out run. These cohorts test different properties and should not be combined into a marketplace accuracy claim:

| Cohort      | Decisions matching expectations | Complete selected-route bindings | Native choices | Jev calls |
| ----------- | ------------------------------- | -------------------------------- | -------------- | --------- |
| Calibration | 12/12                           | 10/10                            | 2              | 28        |
| Held out    | 8/8                             | 6/6                              | 2              | 18        |

The calibration run showed two price-only switches: ordinary Exa research changed from paid at 0.007 USDC to native at a synthetic 10 USDC, and a page summary changed from Firecrawl at 0.01 USDC to native at a synthetic 2 USDC. Required CoinMarketCap quotes, Hunter company records, Hunter email verification and Wolfram computation retained the specialist at current and synthetic 2 USDC prices. The high-price offers were never executed and did not change payment caps. These runs used the optional profile with native WebFetch available; the current demo keeps page reads on the hook/bridge path, so that native page alternative is excluded there.

In the held-out run, required Apollo and CompanyEnrich records retained the specialist at their current 0.038/0.06 USDC prices and at synthetic 2 USDC. Two equivalently described synthetic search offers at 0.007 and 0.70 USDC selected the cheaper offer when their price positions were swapped. A trivial fact and an explicit no-paid task stayed native even with a 0.000001 USDC specialist offer. This small held-out set checks capability preservation, equivalent-offer preference and native controls; it is not a broad estimate of price sensitivity.

Earlier calibration reports remain preserved. The initial run matched 11/12 decision expectations while showing no price-only switches; intermediate instructions made the research pair both native or both paid. Only the final frozen calibration produced both intended optional-benefit switches while preserving the required capabilities. The 12 calibration cases were used for tuning, and the eight held-out cases are now known; future reruns are regression evidence, not a fresh held-out sample. The earlier 33-case capability-first result used price awareness off and remains separate.

Offline validation passed 144 focused tests across eight relevant files, including the 30 price-normalizer tests, plus all 60 Node harness tests and workspace lint, formatting, typecheck and package smoke. Under an earlier price prompt, headless Exa research (0.007 USDC), Hunter company enrichment (0.013 USDC) and native search passed their checks. With the final frozen policy, headless Sonnet research selected Exa and Firecrawl and successfully delivered one response from each (0.017 USDC total for those fulfilled calls). The whole research run remains failed: Claude first attempted native fetches that the gate redirected, then issued two concurrent Firecrawl calls; the in-flight service guard blocked the second with no new payment. It is not a clean end-to-end success. The separate final native-weather run passed all 17 checks with actual WebSearch and no x402 request or payment. Routing calibration does not establish frictionless tool orchestration.

From the built PR checkout, run the calibration cohort first. This invokes Jev and can incur inference charges, but never executes a provider or signs a payment:

```sh
node dist/tenjin-auto-price-eval.mjs --cohort calibration \
  --env-file /absolute/path/to/existing.env --max-calls 60 \
  --output /tmp/price-calibration-01.json
```

Use calibration results to refine the instructions, then freeze the instructions, case labels and code revision before inspecting or running the held-out cohort. Run it separately against that frozen version:

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

Focused local checks:

```sh
pnpm exec vitest run src/experimental/auto-mode --maxWorkers 2
pnpm test:auto-mode-harness
# In a managed workspace, use its scripts/check --path . for static/package checks.
```

### Bridge validation on 2026-09-20

The interactive report exposed two separate failures: exact page-fetch requests could select a search contract, and a successful 32,014-character GitHub scrape delivered only 160 original Markdown characters because metadata crowded out the document. Fetch routing now preserves the immediate page-reading operation and exact URL. Contracts need a declared URL input (including URI-format and URL-array fields) or must directly serve that exact resource. The fetch interpretation prompt stays with Claude instead of becoming a provider argument. Jev still judges semantic suitability; these guards do not establish that every URL-taking service retrieves pages. Generic previews allocate prose space by value size and also prioritize a bounded set of common provenance fields such as titles and source URLs. That display priority is provider-independent and does not affect routing. At the earlier checkpoint, the saved GitHub response retained 5,274 Markdown characters, including the specification overview and payment flow, in a 6,000-character valid JSON preview. Both primary BTC/ETH quote objects remain intact in the saved structured-data regression.

After these fixes, the exact x402 research prompt passed all 20 gates in a fresh Sonnet auto-mode run: one Exa search and two Vaaya fetches, all HTTP 200 and normal successful tool results, with two valid final citations. Provider cost was $0.027 USDC; Claude inference was $0.0459896, excluding Jev. A separate live routing batch passed 10/10 cases in 22 Jev requests and no provider calls, including both failed fetch prompts after synthetic crypto/research history, a held-out URL-array reader and existing quote/history cases. At that earlier checkpoint the evaluation contained 38 cases; this was not a single clean 38-case live batch.

An interactive synthetic PTY probe verified that Claude Code 2.1.278 renders a selected service in the status footer during a running PreToolUse hook, before hook completion. The first selected-service frame appeared 304 ms after the synthetic hook started. It made no provider payments; the two model attempts cost $0.0846606 total. Focused tests additionally verify the production progress writer publishes before execution finishes, isolates sessions/concurrent calls, bounds output, masks credentials/control characters, and keeps fresh completions visible alongside stale calls. This establishes the footer mechanism separately from the paid headless transport test.

The current research opener was tested exactly as written above in a fresh Sonnet auto-mode session. It made two Exa searches and two Vaaya Firecrawl fetches ($0.034), returned normal successful tool results, linked the researched sources and passed all 20 gates. The unchanged “Check price for both now” follow-up made one new uncached CoinMarketCap call with exactly `symbol=BTC,ETH` ($0.01). All 18 execution/receipt gates passed; rounded prices, percentage changes and abbreviated market caps matched the saved and delivered response. The final answer named CoinMarketCap without a clickable link, so the two citation gates remain failed. Its approximate quote time rounded to the nearest minute; quote data was about 121 seconds old at delivery. The pair cost $0.044 USDC and $0.1558788 Claude inference, excluding Jev. At that earlier preparation checkpoint the preserved ledger accounted for $0.376 USDC, leaving $0.624 of the original cap, with no unresolved attempts. This validates observed tool use for this run, not a guarantee that every run of the wording makes the same calls.

Claude Code 2.1.278 initialized `claude-sonnet-5` with `permissionMode: auto`. The synthetic fixture passed all 20 bridge gates without provider payment. The exact x402 research prompt made one Exa and two Vaaya calls, all returned successful tool results, and both final source links matched returned URLs: all 20 gates passed, $0.027 USDC. The first run of the checker mishandled an omitted `cached` flag; saved streams were regraded offline after fixing that test harness, without new paid calls.

The two-turn network-comparison → fresh-quotes dialogue used one persisted Sonnet session. The first turn made two Exa and two Vaaya calls ($0.034); the follow-up made two new, uncached CoinMarketCap requests, both with exactly `symbol=BTC,ETH` ($0.02). Both turns used normal successful MCP results. The first passed all 20 gates. The follow-up passed all 18 execution/receipt gates but failed the two citation gates: Sonnet named CoinMarketCap and printed its endpoint without `https://` as code rather than a clickable source. That failure remains recorded. Offline numerical validation passed all ten checks: both displayed prices and 24-hour changes matched the saved and delivered data to two decimals, and both displayed quote timestamps matched. The requests occurred after the follow-up user message; the provider's quote data was about 111 seconds old at delivery. Separate tool-use IDs can still produce semantically duplicate requests and charges; this MVP deduplicates event replay, not arbitrary semantic duplication.

An earlier minimal pair used the comparison opener, not the research opener now shown above. “Compare BTC and ETH for someone new to crypto” completed from existing knowledge with zero tool calls and zero hook/provider executions; it is a context turn, not a paid-call success. “Check price for both now” made **one** new uncached CoinMarketCap call with exactly `symbol=BTC,ETH`, cost $0.01, and returned a normal successful MCP result. All 18 execution/receipt checks passed. The answer named CoinMarketCap, and prices plus displayed percentage changes matched the saved/delivered response at the displayed precision. It had no clickable citation, so the two citation checks remain failed. The displayed 22:35 UTC time was a rounded market timestamp (quote data 22:34:58), not the 22:36:07 fetch response time. This pair cost $0.0524252 Claude inference, excluding Jev. The generic paid-call harness intentionally rejects a zero-tool first turn; a separate scenario check verifies that it established context, without weakening the paid-call gates.

The three paid invocations cost $0.2466216 in Claude inference, excluding Jev. Provider spend for this validation was $0.081 USDC. At the earlier comparison-only checkpoint, the preserved shared ledger accounted for $0.332 USDC, leaving $0.668 under the original $1 cap, with no unresolved attempts. These are dated preparation figures, not a promise of the remaining balance after another presentation. The actual updated interactive launch remains for the presenter; headless evidence does not establish pixel-level terminal appearance.

At that earlier bridge checkpoint, focused validation totaled 247 TypeScript tests and 42 Node harness tests; the 246-test suite passed before the final stale-progress regression, then all six progress tests passed again. Workspace lint, format, typecheck and package smoke passed. Cancellation tests exercise real local child groups and verify SIGINT/SIGTERM cleanup without model calls. Normal tenjin-agent PR CI runs automatically, with no `ci` label required; its build, typecheck, full tests and package smoke passed for the bridge implementation. The PR stays draft.

### Earlier evidence and limits

Before the bridge change, 196 focused TypeScript tests and 23 harness tests passed, along with build, static checks and package smoke. Headless Haiku tests executed Exa, Vaaya and CoinMarketCap and delivered their results through denied-tool context. A natural x402 research run passed all 11 gates. A successful market-cap/follow-up run selected exact `symbol=BTC,ETH` and displayed both prices correctly but omitted a price source link: ten execution gates passed, citation failed. The user's subsequent interactive run reused already available prices and made no second call. Neither is presented as a guaranteed two-turn behavior.

The independent live Jev history regression passed six cases in 20 model requests without provider calls. With an identical generic pending query, changing only prior assistant text changed exact arguments from `symbol=BTC,ETH` to `symbol=SOL,XRP`; a later user correction narrowed them to `symbol=ETH`. This isolates Jev's history dependence even when Claude itself expands references in a live tool query. The earlier evaluation contained 33 cases; the fetch regression extension above brings it to 38, without a single clean full live batch. Earlier batches had transport errors; `jev-latest` is an alias, not a pinned model revision.

CoinMarketCap's nonstandard `txHash`/`networkId` receipt remains `unverified`; HTTP success is not independent settlement verification. Initial transfers were separately checked on Base. Generic structured JSON compaction retains both assets while marking truncation and saving full responses locally. Successful retrieval and correct prices do not establish every claim in Claude's prose.

## Open marketplace and execution boundaries

The importer generates a versioned JSON contract from Bazaar descriptions, payment advertisements and supported machine-readable schemas, with source hashes. It never downloads/executes third-party `SKILL.md`, shell code or generated JavaScript. Provider branding in receipts is display metadata, not routing logic. Without `catalogFile`, optional dynamic discovery queries CDP, interleaves/deduplicates results and caps candidates at 20. Twelve tested provider-free queries did not reliably surface the approved demo services; improving retrieval is follow-up work.

The [saved catalog audit](./auto-mode-catalog-coverage.json) covers 14,986 records across 150 pages: 8,050 contracts validate and 6,936 are explicitly unsupported. The API's curated flag yielded 58/86; it is not claimed to equal agentic.market's curated collection. Enumeration has no transactional snapshot guarantee. Compilation is not paid execution. Every listing can receive an actionable status, but the MVP cannot execute every Bazaar entry or translate arbitrary prose-only documentation. Missing schemas, unsupported constraints and unknown primitives fail explicitly.

For exact page fetching, code filters out contracts without a declared target URL binding or exact direct resource, and rejects final arguments that change that URL. Underspecified target fields remain unsupported. The same generic checks apply to new providers; no provider-name dispatch is introduced. Broader informational searches can still select structured price endpoints.

Jev chooses source spans and schema values, can compose up to eight selected members across two fields, and finally selects a complete schema-valid argument set. Up to six optional fields yield at most 64 candidate sets. No payment judgment is delegated to a model. Requests/responses to Jev have a 1 MiB bound. Current-session user/assistant text is bounded; tool-result history, other sessions, subagents and compacted/malformed/oversized transcripts are unsupported. Native domain filters are rejected rather than dropped.

Payment execution supports x402 v2 `exact`, Base native USDC, validated HTTP query/body/path/header contracts and explicit action scope. A lock claims each attempt; budget is reserved before signing and policy rechecked before signing/transmission. Ambiguous transmissions retain their reservation and are never automatically re-signed. Replaying a completed event returns cached evidence. Within the same user turn, an unresolved paid attempt blocks another request to that capability even with a new tool-use ID or changed arguments; other capabilities can proceed independently. This does not deduplicate all semantically equivalent successful requests. A separate typed workflow executor supports up to ten ordered steps and prior-result bindings; automatic multi-step Jev planning is not wired in. The Exa/Tavily chain test is synthetic.

Provider connections validate DNS/destinations and reject private addresses, credentials, custom ports and redirects. Nested scraper targets receive public HTTPS/DNS checks, which cannot control the remote scraper's later behavior. Provider results are untrusted. The local receipt files, wallet and policy are not isolation from malicious code running as the same OS user. The hook has a 70-second deadline under Claude's 90-second hook timeout. The bridge fails closed without a valid result receipt; it cannot force Claude to request a tool or to interpret the result correctly.
