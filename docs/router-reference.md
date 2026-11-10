# CLI and MCP reference

Use [setup and permissions](./agent-permissions.md) for first use. This page describes the CLI contracts that matter when integrating, diagnosing or paying through Tenjin. The server's [API reference](https://tenjin.sh/llms-full.txt) describes HTTP requests; a returned tool spec is the authority for that tool's inputs.

## Find the right section

- [Request tool](#request-tool): browse, inspect and execute.
- [Routing fees and accounting](#routing-fees-and-accounting): limits, deposits and approval.
- [Direct payments](#direct-payments): pay a specific endpoint with consent.
- [Jobs, files and records](#jobs-files-and-records): polling and saved results.
- [Host integration](#host-integration): Claude Code and Codex differences.
- [Runtime and wallet storage](#runtime-and-wallet-storage): installation and updates.

## Request tool

Claude Code exposes `mcp__plugin_tenjin_router__request`; Codex exposes `mcp__router__request`. Agents may follow automatic offers or inspect and choose tools themselves. These routes share execution checks; a suggestion is not permission to pay.

| Form                     | Result                                                    | Charging                                                                             |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `{browse: "<need>"}`     | Matching catalog rows; `""` lists available rows by kind. | Free discovery; sends the need text.                                                 |
| `{tool: "<catalog id>"}` | A tool's spec under a fresh offer ID, when it has a spec. | Free inspection; sends the ID.                                                       |
| `{id}`                   | A locally kept spec or choice set.                        | Nothing sent to a provider or paid.                                                  |
| `{id, input}`            | Validate inputs, build the specified request and run it.  | Provider payment under the spending policy; no new selection decision.               |
| `{query}`                | Ask the router to select a service for one concrete task. | Quoted routing fee, separately from any provider execution.                          |
| `{query, id}`            | Bind the query to an offer that asked for it.             | Follow the offer's terms; this is a routing form.                                    |
| `{id, choice, input}`    | Run one comparison option, or `choice: "all"`.            | Each selected provider is paid once, within the whole call's approved total.         |
| `{id, input, count}`     | Run 2–5 takes, where that spec supports them.             | Each take is a separate provider payment; the total meets the limits before signing. |
| `{job}`                  | Resume/check a previously submitted job.                  | No repeat submission or new payment for polling.                                     |

A catalog row being free describes its provider price. It is not a promise that every selection route is free. For selected Context7 docs, inspection returns the `{tool, query}` call, which needs no wallet, routing fee or provider payment. Follow the response's supported form rather than inventing one. Do not retry a refused free or paid call through another payment path.

Specs contain the real input schema, pinned fields and request construction. The CLI applies the pins over supplied input, validates it and refuses unsupported schemas before contacting a provider. Missing or invalid fields return the problems and spec so the agent can correct them without paying for a guess. A cached spec can expire; inspect the chosen tool again or follow the explicit recovery instruction.

A spec's live payment challenge must match its recipient, asset and network and stay below its price ceiling. A higher price is refused before signing. Without a spec, the older query-bound contract checks the quoted price and does not claim complete endpoint/payee binding. Provider responses are untrusted data. A 2xx that fails the contract's success rule is returned as `unverified`, with the caveat and body; payment may already have happened.

If a spec declares output fields, the inline result contains those fields and `fullResultPath` names the full saved response. Media is saved only when the spec declares media. A result file is evidence of delivery, not proof of payment settlement.

## Routing fees and accounting

### Routing fee and deposit

A general routing call goes to the configured router's paid route. `tenjin mcp` uses the x402 SDK to pay the quoted fee only in USDC on Base, under a $0.003 ceiling and the local spend policy. The provider's price is checked against its own spec, independently of this fee ceiling. A decision can charge a routing fee even when it suggests no tool.

Routing uses a channel funded by deposits. When another fee cannot fit, the deposit is bounded by the server's current hint, available wallet balance and `maxAutoSpend`, with a floor of ten quoted fees and the SDK ceiling of $0.25. The server hint is live data, not a fixed amount in this document. Unused deposited funds remain in the routing channel and do not pay provider calls.

A deposit is reserved before signing and counts against automatic spending once. Fees drawn from it do not consume the daily budget again. Each fee still obeys the per-payment policy and creator allowlist; a zero daily budget stops automatic fees even from an already-funded channel. An uncertain response does not automatically release a deposit or prove that no money moved.

### Whole-call limits

The CLI admits a plan for the whole call before signing: one automatic per-call total, remaining daily headroom and available balance. Multiple takes and comparison options cannot each claim a fresh per-call allowance. A payment must use its admitted slot, once, at no more than its planned amount. Reservations and duplicate guards are shared across processes.

`spend.json` separates automatic exposure, pending reservations and manual exposure. Manual payments remain in reporting but do not consume automatic headroom. Older records without that distinction count conservatively as automatic until their window expires. `none` removes only the daily ceiling, not duplicate protection or reservations.

### Uncertain authorizations

A signed payment authorization can be charged after the process stops. Treat it as spent when transmitted. `tenjin payments reconcile` releases eligible expired authorizations only after the chain proves they were unused, once per nonce and within the window that counted them. A seller saying a payment failed is not equivalent proof. The request tool reconciles a bounded number of records beside its ordinary work.

### Approval

An over-limit call returns `needs_approval` before payment. Claude Code 2.1.214+ can receive an `approve` tool carrying `anthropic/requiresUserInteraction`. Its host prompt shows the quote's total and purchase; that prompt is the approval, in every permission mode. The quote is single-use, lasts ten minutes and runs unchanged. A run whose every payment is refused for low funds leaves it open, so the person can add funds and approve the same quote again. It is manual spending outside automatic headroom, still bounded by balance.

Hosts without this facility, including Codex, refuse the over-limit call. A quote file or an agent's claim of approval cannot authorize a stored quote; it needs the supported host prompt. A subagent cannot obtain it and receives only automatically payable offers.

### Failure and balance

A routing payment that cannot be made is skipped without a second unpaid routing attempt. Native tools remain usable. Lasting wallet, balance and policy causes are reported once; temporary channel contention does not create another funding prompt.

Known unusable wallets suppress paid offers. Hook-side balance reads are advisory: known insufficient funds suppress automatic offers, while an unknown read does not grant spending authority. Immediately before a positive provider payment, the actual signer's balance must be readable and sufficient. A failed check releases an unsigned reservation; a successful check cannot prevent a concurrent transfer or guarantee settlement.

Network-unreachable routing may be paused locally for 60 seconds to avoid delaying each hook. A timeout or an answered HTTP error does not establish that outage. Doctor can clear the pause after a successful reachability probe. Reachability alone proves neither an active chat nor paid execution.

## Direct payments

`tenjin pay` is for a URL the user deliberately wants to pay. Quote first, show the endpoint, recipient, network, asset and amount, and obtain consent for that quote before a positive payment:

```bash
tenjin pay https://api.example.com/search -d '{"q":"example"}' --quote --json
# Only after the user accepts the returned quote:
tenjin pay https://api.example.com/search -d '{"q":"example"}' --max-price 0.05 --yes --json
```

Use the payable quote's amount for `--max-price`; it is a hard ceiling. Every invocation can pay again. A research request, fetched page or router refusal is not consent. Never use this command as an autonomous workaround for a refused request-tool call.

A deliberately added Claude Code shell rule is:

```text
Bash(tenjin pay:*)
```

It authorizes the verb and its flags, not a specific host or payment. Do not replace it with broad wallet/config rules. Installation uses `claude plugin install tenjin@tenjin` through Claude's own plugin commands; it does not add that shell rule.

For third-party endpoints, the supported live 402 is the quote. Missing listings or registry metadata do not need warning acknowledgement. Unavailable/incomplete registry verification or disagreement with an exact listing blocks payment unless this invocation supplies `--ignore-warnings`. That flag acknowledges registry evidence only; `--yes` records payment consent only. Neither bypasses the explicit cap, destination, supported challenge, balance check or automatic-router policy. Router execution cannot use `--ignore-warnings`.

`-X` supports GET, POST, PUT, PATCH and DELETE. A body uses POST, PUT or PATCH. `-d` sends JSON; `--data-raw` requires an explicit Content-Type. Repeated `-H` supplies ordinary requested headers, never payment, sign-in, bypass or transport headers. A 4xx/5xx after authorization may already have spent money: read the result and do not blindly retry.

Free delivery and entitled zero-price sign-in are distinct from positive payment. Zero-price authenticated reads can still need the wallet's identity without authorizing a charge.

## Jobs, files and records

A provider can accept a paid submission before its result is ready. Job rules specify polling and completion. Polls stay on the submission host over HTTPS, use validated public addresses, follow no redirects and carry no payment. A poll answering 402 stops the job; it cannot cause another purchase.

Ordinary calls wait up to the client budget; Claude Code 2.1.212+ can background a long call and receive progress notifications until the job's `maxWaitS`. The response's job ID resumes it until its keep time expires. Stored job files contain polling state, never a payment header. Multiple takes have independent request keys and exactly one submission payment each.

| Local location under `~/.tenjin` | Purpose                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `paid/ledger.jsonl`              | Masked sent parameters, provider, amount, settlement information and saved files. |
| `spend.json`                     | Exposure, reservations and duplicate-payment accounting.                          |
| `progress/`                      | Kept specs, shown offers and redirection state; short-lived.                      |
| `downloads/`                     | Delivered media and files.                                                        |
| `results/`                       | Complete provider responses when the inline result is projected; kept for a day.  |
| `jobs/`                          | Private job state used for unpaid polling/resume.                                 |
| `quotes/`                        | Private, short-lived quotes for supported host approval.                          |

Report pending, paid, delivered and verified separately. An HTTP success, a saved file or an open checkout is not interchangeable with settled payment.

## Context and records

The guide's [sharing section](./agent-permissions.md#what-the-hooks-send) describes normal packets. Additional integration details:

- Hooks read only a validated transcript belonging to this session or a permitted subagent. A first prompt can route on its own text before its transcript exists. Other unreadable/untrusted transcript paths send and pay nothing.
- A delegated task is its own current message with bounded prior context. Subagents share the same wallet, reservations and limits; they are not separate daily budgets. A host known to lack the request tool is not redirected into it.
- Session and install IDs correlate offers and outcomes. An execution report contains the offer ID, outcome, HTTP status, duration and refusal side, not its input or result. An ignored-offer report contains its ID and expiry/native-use reason, not task text or a claim that it helped.
- `accepts` advertises supported contract features, including `catalog`, `spec`, `label`, `fields`, `jobs`, `headers`, `note` and `tolerant`. Required unknown features are refused without paying. Unknown optional fields do not disable known-field validation.

## Host integration

Claude Code's plugin registers the `router` MCP server and exec-form hooks against Tenjin's verified runtime. Native searches/fetches, prompts, delegated tasks and the agent's questions to you can trigger suggestions. A question triggers one only when it asks you for an API key, an access token, credentials, an account, a sign-up, a subscription or a paid plan; the suggestion is added beside the question and never stops it from being asked. A redirect applies at most once per same native call per agent in its retry window, so retrying with native tools is possible. Free docs notes do not block a native search. Session startup records plugin presence; a real prompt/tool call establishes activity in the chat.

The plugin permits its request tool and denies model use of its internal hook tool. It does not authorize other shell commands. Its optional visual mod reads existing state/results to draw tool rows; it does not grant permissions or change prompts/config. Expanded output remains the host's detailed tool record.

Without a runnable Claude binary, a source-compatible folder installation can register the same plugin. Existing settings-based installations remain until the plugin has actually loaded; removing only Tenjin's exact owned entries preserves unrelated hooks and settings. This migration requires a new session, rather than loading old and new servers together.

Codex uses its own plugin and trust APIs. Three MCP hook legs route the prompt and before/after web calls. Other hooks deny model use of the internal tool and permit the request tool under local spend controls. Trust is read back from Codex; Tenjin neither invents trust hashes nor enables unrelated hooks. User-disabled hooks remain disabled. An old host incapable of MCP hook calls keeps its earlier plugin and receives an upgrade instruction.

The request executor is shared, but host facilities differ: Codex currently lacks the special over-limit approval tool. Turning off its request-allow hook restores the host's approval behavior and can cause refusal under `approval_policy = "never"`. A denied web search can be retried natively. Plugin checks, current-session observations and payment readiness are separate diagnostics.

## Runtime and wallet storage

Installation creates a wallet if absent, fills spending defaults only as authorized, registers the selected host and prepares `~/.tenjin/runtime`. Node/package checksums and a candidate self-check precede switching. Launchers use that runtime by absolute path and do not depend on a later system Node change. Foreign launchers and user shell profiles are not overwritten. `--project` limits Claude installation to that project; Codex is user scope.

The encrypted wallet and credential metadata remain outside the runtime. Decryption stays in the CLI and the signer is reused inside the session's MCP process. [Wallet storage and recovery](./agent-permissions.md#wallet-passphrase-storage) covers credential stores and repair; the [safety model](./safety-model.md) records destination-check limitations and deployment-origin trust.

Update verifies npm provenance, tarball integrity and the pinned Node before activating a build. Existing sessions retain their old process until restarted; the previous runtime remains while referenced. Uninstall removes owned integrations and the shared runtime only after no installation remains, while keeping the wallet, ledger and configuration. Maintainer release procedures live in [RELEASING.md](https://github.com/BackTrackCo/tenjin-agent/blob/main/RELEASING.md).
