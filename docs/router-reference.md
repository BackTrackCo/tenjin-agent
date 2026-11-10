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

A general routing call goes to the configured router's paid route. `tenjin mcp` uses the x402 SDK to pay the quoted fee only in USDC on Base, under a $0.25 ceiling and the local spend policy. It pays the answer's own quote ahead of the router's fixed $0.003 quote, and the fixed quote only when it is the only offer. A quote above the ceiling or your per-call limit is not paid, and the fixed quote is not used in its place. The provider's price is checked against its own spec, independently of this fee ceiling. A decision can charge a routing fee even when it suggests no tool.

Routing fees are paid from a routing balance that Tenjin tops up from your wallet. A top-up is a deposit, and Tenjin sends one only when the balance cannot cover the next fee, on the same call, so a dear answer keeps its offer. A call whose deposit the wallet cannot fund pays nothing, and the next answer is still asked for. It sizes the deposit in four steps:

1. **Target.** The amount the router suggests, normally $0.05, or five times the fee when the fee is above that suggestion, cut down to your per-call limit and to a $0.25 ceiling. The suggestion is live data from the router, not a fixed amount in this document. If the next fee alone is more than the ceiling or your per-call limit, Tenjin sends no deposit and skips the routing call.
2. **Balance.** Tenjin reads your USDC balance once. If the wallet holds less than the next fee needs, it sends no deposit and skips the routing call.
3. **Reserve.** Tenjin keeps $0.01 in the wallet for provider payments. If the wallet holds at least $0.10 and at least the target plus that $0.01, it deposits the target.
4. **Small wallet.** Otherwise it deposits $0.01, or what the next fee needs if that is more (never above the target), and no more than the wallet holds above the $0.01 reserve. If that leaves nothing, or less than the next fee needs, it sends no deposit and skips the routing call.

The balance lookup takes at most two seconds, inside the call's own deadline. With the built-in default RPC, the lookup can fall back to two public RPCs (PublicNode, then dRPC) within the same two seconds; an RPC you configured is the only one asked. Each is asked once. A lookup that fails or runs late sends no deposit, reserves no spend and skips the routing call without a warning, since nothing failed and nothing was paid. A fee that the routing balance already covers is paid without any balance read.

A deposit meets your automatic limits (per-call limit, daily budget, creator allowlist) before it is signed, and counts against automatic spending once. Fees drawn from it do not consume the daily budget again. Each fee still obeys the per-payment policy and creator allowlist; a zero daily budget stops automatic fees even from an already-funded balance. A deposit counts from the moment it is sent. An answered 4xx or 5xx response releases it, because the server settles nothing on those. An unanswered request does not release it or prove that no money moved. Unused routing funds stay yours and pay later routing fees, never provider calls.

`tenjin status` and `tenjin balance` show what routing has cost so far, beside the funds set aside for it: the deposits sent less the credit they still hold, a local estimate from the routing channel files, with no extra network read. Offers show no fee, so this is where the cost appears. An install that did not approve limits on these terms is told them once, on its first routing call after the update; no spend limit changes.

The facilitator checks the wallet's funds when it verifies the deposit. If it answers that the wallet holds less, that call gets no route, the wallet is reported as too low, and Tenjin does not retry.

### Whole-call limits

The CLI admits a plan for the whole call before signing: one automatic per-call total and the remaining daily headroom. Multiple takes and comparison options cannot each claim a fresh per-call allowance. A payment must use its admitted slot, once, at no more than its planned amount. Reservations and duplicate guards are shared across processes.

`spend.json` separates automatic exposure, pending reservations and manual exposure. Manual payments remain in reporting but do not consume automatic headroom. Older records without that distinction count conservatively as automatic until their window expires. `none` removes only the daily ceiling, not duplicate protection or reservations.

### Uncertain authorizations

A signed payment authorization can be charged after the process stops. Treat it as spent when transmitted. `tenjin payments reconcile` releases eligible expired authorizations only after the chain proves they were unused, once per nonce and within the window that counted them. A seller saying a payment failed is not equivalent proof. The request tool reconciles a bounded number of records beside its ordinary work.

### Approval

An over-limit call returns `needs_approval` before payment. Claude Code 2.1.214+ can receive an `approve` tool carrying `anthropic/requiresUserInteraction`. Its host prompt shows the quote's total and purchase; that prompt is the approval, in every permission mode. The quote is single-use, lasts ten minutes and runs unchanged. A run whose every payment is refused for low funds leaves it open, so the person can add funds and approve the same quote again. It is manual spending outside automatic headroom, still bounded by balance.

Hosts without this facility, including Codex, refuse the over-limit call. A quote file or an agent's claim of approval cannot authorize a stored quote; it needs the supported host prompt. A subagent cannot obtain it and receives only automatically payable offers.

### Failure and balance

A routing payment that cannot be made is skipped without a second unpaid routing attempt. Native tools remain usable. Lasting wallet, balance and policy causes are reported once; temporary channel contention does not create another funding prompt.

A wallet that cannot sign suppresses paid offers. Tenjin reads no balance when it offers a tool, admits a plan or signs a provider payment: the facilitator checks funds when it verifies each payment, and a payment it refuses as short of funds is reported as a low wallet, with no retry. The automatic routing notice says only that Tenjin could not pay for that answer and that answers needing no payment can still work. A balance check cannot prevent a concurrent transfer or guarantee settlement. `tenjin balance`, `tenjin status` and `tenjin doctor` read the balance when you run them, and a once-a-day session-start notice reads it too.

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

Claude Code's plugin registers the `router` MCP server and exec-form hooks against Tenjin's verified runtime. Native searches/fetches, prompts, delegated tasks and questions can trigger suggestions. A redirect applies at most once per same native call per agent in its retry window, so retrying with native tools is possible. Free docs notes do not block a native search. Session startup records plugin presence; a real prompt/tool call establishes activity in the chat.

The plugin permits its request tool and denies model use of its internal hook tool. It does not authorize other shell commands. Its optional visual mod reads existing state/results to draw tool rows; it does not grant permissions or change prompts/config. Expanded output remains the host's detailed tool record.

Without a runnable Claude binary, a source-compatible folder installation can register the same plugin. Existing settings-based installations remain until the plugin has actually loaded; removing only Tenjin's exact owned entries preserves unrelated hooks and settings. This migration requires a new session, rather than loading old and new servers together.

Codex uses its own plugin and trust APIs. Three MCP hook legs route the prompt and before/after web calls. Other hooks deny model use of the internal tool and permit the request tool under local spend controls. Trust is read back from Codex; Tenjin neither invents trust hashes nor enables unrelated hooks. User-disabled hooks remain disabled. An old host incapable of MCP hook calls keeps its earlier plugin and receives an upgrade instruction.

The request executor is shared, but host facilities differ: Codex currently lacks the special over-limit approval tool. Turning off its request-allow hook restores the host's approval behavior and can cause refusal under `approval_policy = "never"`. A denied web search can be retried natively. Plugin checks, current-session observations and payment readiness are separate diagnostics.

## Runtime and wallet storage

Installation creates a wallet if absent, fills spending defaults only as authorized, registers the selected host and prepares `~/.tenjin/runtime`. Node/package checksums and a candidate self-check precede switching. Launchers use that runtime by absolute path and do not depend on a later system Node change. Foreign launchers and user shell profiles are not overwritten. `--project` limits Claude installation to that project; Codex is user scope.

The encrypted wallet and credential metadata remain outside the runtime. Decryption stays in the CLI and the signer is reused inside the session's MCP process. [Wallet storage and recovery](./agent-permissions.md#wallet-passphrase-storage) covers credential stores and repair; the [safety model](./safety-model.md) records destination-check limitations and deployment-origin trust.

Update verifies npm provenance, tarball integrity and the pinned Node before activating a build. Existing sessions retain their old process until restarted; the previous runtime remains while referenced. Uninstall removes owned integrations and the shared runtime only after no installation remains, while keeping the wallet, ledger and configuration. Maintainer release procedures live in [RELEASING.md](https://github.com/BackTrackCo/tenjin-agent/blob/main/RELEASING.md).
