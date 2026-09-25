# Agent permissions

`tenjin install` writes one permission rule into `~/.claude/settings.json`, and this page is the whole reasoning behind it: what it clears, what it cannot clear, and what stays a decision you make by hand.

Harnesses that run unattended deny tools they have not been told about. Without the rule below, every lookup stops on a permission prompt, and a session left alone stops with it.

## The one rule

```
mcp__x402__request
```

That is it. It clears the `request` tool on the `x402` MCP server `tenjin install` registers, and nothing else: no shell verb, no other tool, no price.

It is a tool grant, not a spending grant. Every payment the tool makes still passes the local spend policy, and the policy is the only thing that decides an amount.

## What bounds a payment

Router on/off controls automatic routing. The spending controls and ledger are local; the router cannot read or raise them:

- **`maxAutoSpend`** caps automatic router purchases per call. `tenjin install` sets it to 0.25 USD only when absent; the bare CLI defaults to zero. Above the cap, automatic payment is refused without prompting.
- **`sessionBudget`** caps automatic exposure in the existing 24 hour ledger window. It defaults to 5.00 USD before and after install. Explicit zero blocks positive automatic spending; `none` removes the automatic daily ceiling.
- **`spend.json`** records all payments, with separate automatic exposure and reservation modes. Only automatic exposure and pending automatic reservations consume the daily budget. Manual payments remain in total reporting. Older records without a mode/counter conservatively count as automatic until their window expires. Both modes retain the keyed duplicate guard, including under `none`.

Manual pay ignores both configured limits and always requires user consent. The retired `bazaarPay` and `confirm` keys have no effect after upgrade, regardless of their old values. Doctor/status warn while they remain. Install/refresh removes and reports exactly those keys, preserving current router/limit settings and unrelated fields. `config set` rejects the retired keys.

A router refusal retains the `needs_approval` status with the summary “Blocked by spending policy.” It does not offer an approval/resume flow or automatically raise limits.

```bash
tenjin status                          # spent, reserved, and the caps in force
tenjin config set maxAutoSpend 0.25
tenjin config set sessionBudget 2.00
```

## What bounds a ROUTER payment, on top of that

The routing decision comes from a server, and it is free: it proposes, it never authorizes. These checks are what keep a wrong or hostile one from being worth anything:

- The amount actually signed has to fit `maxAutoSpend` and the day's `sessionBudget`. A live price above the one the decision quoted is refused before anything is signed, so a provider or a stale catalog cannot charge more than it advertised; a hostile server sets that quote itself, so against one the bound stays `maxAutoSpend`.
- The backend binds the call and validates its arguments against the capability's own schema, then sends the finished request; this CLI sends it as given and never rebuilds it, so there is no second copy of that rule here to drift from the first.
- The destination has to be a public HTTPS endpoint whose name resolves to a public address. This is a check, not a pin: the request resolves the name again on its own, so a host that answers publicly at check time and privately a moment later is not closed by it. See [safety-model.md](./safety-model.md).
- A 2xx whose body fails the decision's own success rule is delivered as `unverified`, never `fulfilled`, with a caveat naming the rule it missed. The money has already moved, so the body is not withheld.

A compromised backend can therefore name any origin it likes, and spend at most one `maxAutoSpend` per call inside `sessionBudget`. Set both to numbers you would not mind losing. This is a pocket-money wallet, not treasury custody.

## A prefix rule pins the verb, not the flags

This matters for the shell rules below rather than the tool rule above. Claude Code's `Bash(tenjin pay:*)` matches the verb and lets every flag through, including `--base-url`, which points the command at another host. So a rule you add is a rule for the verb at whatever host the caller names, and a task that arrived from a web page or a purchased document is exactly where such a flag comes from.

## Opt in by hand: paying an endpoint you name

```
Bash(tenjin pay:*)
```

`tenjin pay <url>` is for an explicit user-requested payment. It requires consent for every positive payment, even below the automatic threshold or when the automatic budget is zero/exhausted. Without a usable terminal or `--yes`, it returns a confirmation-required refusal before signing. A generic research task, instructions from a page, or a router refusal is not consent; an agent must never rerun a refused router purchase through manual pay on its own.

The configured deployment keeps its existing origin behavior. Other public HTTPS endpoints use the supported live 402 as the quote. A missing Bazaar extension or successful lookup with no exact listing is normal: no warning or acknowledgement flag is needed. Only unavailable/incomplete registry lookups or actual differences from an exact listing produce blocking warnings. Listings do not authorize payment or guarantee quality.

Review the live endpoint, recipient, network, asset and amount. `--ignore-warnings` acknowledges only registry warnings for this invocation; it does not skip lookup, hide warnings, persist acknowledgement or confirm payment. `--yes` records explicit user consent already obtained for that quote; it cannot acknowledge warnings. Interactive confirmation cannot replace the warning flag. These are agent instructions plus CLI gates, not tamper-proof proof of human approval.

```bash
tenjin pay https://api.example.com/quote --json --max-price 0.05
# After reviewing a registry warning and the live quote:
tenjin pay https://api.example.com/quote --json --max-price 0.05 --ignore-warnings --yes
```

Both flags still obey the optional explicit `--max-price` cap, destination and supported-challenge checks, and the authoritative wallet balance check. Warnings and acknowledgement status remain in JSON output. Each paid invocation can spend again; there is no purchase-library dedupe. Free or SIWX-entitled delivery needs neither warning acknowledgement nor a payment balance read.

Router calls cannot use `--ignore-warnings`. They require their offered price and retain hard checks for any supplied network, asset or recipient. The current server protocol supplies price only; this release does not claim complete endpoint/payee quote binding.

Immediately before signing a positive payment, the CLI reads the actual signer's Base USDC balance through the configured RPC. An unreadable balance gets one retry within the original deadline. Confirmed insufficient funds or two unreadable results refuse, releases the reservation and counts no spend. Hook balance reads are advisory and bounded: prompt, pre-call, after-call and subagent offers are suppressed for known insufficient funds or policy refusal. A successful balance read cannot reserve funds or guarantee settlement after concurrent transfers.

## Never recommended

Each of these is a decision a person makes, so none is in the rule set and none should be added without meaning it:

| Verb                   | Why it stays a human decision                                        |
| ---------------------- | -------------------------------------------------------------------- |
| `tenjin wallet send`   | Moves USDC out of the wallet and is not bounded by the spend policy. |
| `tenjin wallet create` | Creates the payment credential.                                      |
| `tenjin config set`    | It can widen the agent's own spend policy.                           |
| `tenjin install`       | Writes into harness config.                                          |
| `tenjin uninstall`     | Removes the wiring the harness is running on.                        |
| `tenjin update`        | Replaces the binary the agent then runs.                             |

Prefer the narrow rules on this page to a broad `Bash(tenjin:*)`, `Bash(tenjin wallet:*)` or `Bash(tenjin config:*)`, each of which swallows the table above.

## What `tenjin install` writes, in full

1. Five hook entries in `~/.claude/settings.json` (`--project` writes the project file instead): `UserPromptSubmit` running `tenjin hook prompt`, `PreToolUse` on `WebSearch|WebFetch` running `tenjin hook native`, `PreToolUse` on `Agent|Task` running `tenjin hook agent`, and `PostToolUse` and `PostToolUseFailure` on `WebSearch|WebFetch`, both running `tenjin hook shortfall`. All are plain command entries with a 5 second timeout. No daemon, no background process, no generated script. An install from an earlier release already has the first two; `tenjin install --refresh` (which `tenjin update` runs) adds the rest.
2. The `mcp__x402__request` rule in `permissions.allow`. Nothing goes into `permissions.deny`, and no hook ever approves a call, so WebSearch and WebFetch stay under your own permission rules. Before each one, when a paid lookup fits it, the hook redirects your assistant to `mcp__x402__request` in its place, as earlier releases did; a subagent is redirected only when it is known to have `mcp__x402__request` and your spend policy would pay without asking, and otherwise its call simply runs. It never redirects twice in a row: when the redirected lookup does not come back fulfilled (it failed, stopped to ask, or was never called), the next WebSearch or WebFetch in that session runs as it is, and routing resumes on the call after. After a call that came back short (a failed call, a page that answers 401, 402, 403, 429 or 5xx, an empty page, a search with no results; never a 404 or 410, since a missing page is missing for a paid reader too), the router may offer a paid lookup.
3. The `x402` MCP server, through `claude mcp add x402 -s user -- tenjin mcp` when the `claude` binary is on PATH, and printed for you to run when it is not. Under `--project` it registers at project scope instead, from the project directory, so the server lands in that project's `.mcp.json` and your `~/.claude.json` is not touched; `tenjin uninstall --project` removes it from the same place. The scope's own file is read first: a registration that already launches `tenjin mcp` is left exactly as it is and nothing is spawned, an `x402` entry launching anything else is removed and re-added, and a registration file this build cannot parse is reported rather than written over.
4. The two automatic spend limits above, only where your config file is silent. Explicit zero, unlimited, custom registry lists and router opt-outs are preserved. Ignored `bazaarPay` and `confirm` keys are removed and reported; refresh removes retired keys without filling absent settings.
5. `statusLine`, running `tenjin status-line` once a second, ONLY when that key is not already set. A status line of your own is never replaced: the install prints the command that runs both, and `--status-line compose` writes it only if you ask. The status line stores nothing new off your machine. It reads local files this CLI already writes under your Tenjin data dir: per session, the tool, the provider endpoint, the bounded redacted parameters of the call, its outcome and its price. No prompt text, no result body. Records expire after ten minutes, live in a 0700 directory under a hash of the session id, and are deleted by the next lookup that passes over them.

The installer installs no skills. Install/refresh removes only an owned obsolete `tenjin-pay/SKILL.md`, preserving adjacent user files and foreign skills.

Every other key in the settings file is preserved byte for byte, a second run writes the same bytes, and `tenjin uninstall` removes exactly those five things and keeps your wallet, your ledger and your config.

To stop the router without removing anything, `tenjin config set router.enabled false` stops it on this machine, and `tenjin config set --project router.enabled false` stops it in this repository. Off means no router hook reads or sends anything and the `request` tool refuses without paying. The project value lives in `<project>/.tenjin/config.json`, which you commit; `--project --local` writes `.tenjin/config.local.json` beside it instead, which is yours alone and belongs in `.gitignore`. Every such file from where the session runs up to the git root applies, and in a git worktree so do the main checkout's; a key a file leaves out is inherited from the files around it. A project file can only turn the router off or narrow what it sends; it cannot enable anything or change a spend setting. From a git worktree, `config set --project` writes at the worktree's own root, never the main checkout's file, though the router reads both.

## How one lookup runs

1. You type a turn. The hook sends the bounded packet to Tenjin, which answers whether a paid capability fits and, if it does, keeps that packet under a short-lived id.
2. When one fits, your assistant sees one line, opening with `Tenjin router (installed by the user):`, that names the service and the call to make: `mcp__x402__request` with your exact lookup and that id.
3. Your assistant calls `request({query, id})` with the lookup it actually means. That is the accurate part: the routing is decided from your assistant's own query plus the stored context, not from a guess made before the lookup was known.
4. Tenjin answers with the call to make and what the provider charges. Deciding costs nothing.
5. This CLI pays that provider once, under your limits, and hands back the result.

## What the hooks send

- On every prompt and every native `WebSearch` or `WebFetch`: the text of the current turn and at most six prior messages, masked by the same key, PEM, seed-phrase, and URL credential rules the publish scan uses, then bounded to 16 KiB, with harness meta rows and tool results excluded. Tool results never travel: a tool result is other people's content, and a packet carrying it would be a channel from a fetched page into a routing decision.
- A native call sends that same bounded turn WITH the call attached, read from this session's own transcript. That is how a restriction you stated in your own words, such as asking for native tools only, reaches the decision about a bare URL your assistant is fetching. When that call then comes back short and nothing was offered before it, it is sent once more with what the harness reported: the status code and byte count, or the error. Never the page or the results. A call that came back fine sends nothing more.
- When your assistant hands a task to a subagent: that task, as the current message, with the same bounded turn before it.
- With `router.context turn`, no prior messages are sent: the prompt on a prompt, your latest message on a native call, and the task on a delegation. `tenjin config set router.context turn` sets it for this machine, and `--project` for this repository.
- Slash commands and one-word acknowledgements are never sent at all.
- The packet is stored on the backend against the decision id, so the lookup your assistant sends next is decided with the context you gave. Expired packets are unreadable after 15 minutes (the route refuses an expired id) and are deleted by the next router request or the daily cleanup, whichever comes first.
- On a paid lookup: the capability chosen, a hash of the contract, a hash of the arguments, your wallet address, the amount and the transaction hash are kept.

The answer can put one line into your session, or into a task your assistant delegates: the service that fits, what it does, its listed price, and the `mcp__x402__request` call carrying the id that brings your context to it. The line says it comes from the Tenjin router you installed, and it is an option: your assistant's own tools keep working. Which service actually runs, and what it costs, is decided when your assistant makes that call, under your spend policy.

## Wallet passphrase storage

The private key is generated on your machine and stored encrypted in `~/.tenjin/wallet.json`. Its passphrase is `TENJIN_WALLET_PASSPHRASE` when you set one, and otherwise a strong generated passphrase in the platform's own credential store (Keychain on macOS, Secret Service on Linux, DPAPI on Windows), verified by reading it back. There is deliberately no plain-file fallback: a passphrase sitting next to the keystore it unlocks protects nothing, so a machine with neither creates no wallet and says so.

Decryption happens in this CLI, in a disposable worker thread, and the key never leaves the process. `tenjin mcp` decrypts once at start so a lookup does not wait for it, holds the signer for the session, and exits with the session.

## Delegating to a subagent

When your assistant delegates, the task it hands over is routed before the subagent starts, and a paid lookup that fits is appended to that task as one optional line. A native search or fetch the subagent makes later is routed on its own task, read from its own transcript, with your turn still in front of it.

A subagent cannot reach you to approve a spend, so it is only offered lookups your spend policy would pay without asking: within `maxAutoSpend`, inside the day's `sessionBudget`, and to a host `allowlistCreators` permits. Its payments run through the same ledger and the same caps as the lead's, because the lock is on the file rather than on the process. A subagent is not a second budget.

A subagent is only redirected or offered a lookup when it is known to have `mcp__x402__request`: a custom agent whose definition (`.claude/agents/<name>.md` in the project, `~/.claude/agents/<name>.md`, or an installed plugin's) lists it in `tools:` or has no `tools:` line at all, or one of the built-in `general-purpose`, `Explore` and `Plan` agents, which inherit MCP tools. Any other subagent, such as the built-in `claude-code-guide` (which has WebFetch and WebSearch but no MCP tools) or a type with no definition to read, is left alone: its native calls and delegated tasks are not sent to the router at all, and its calls run free. `tenjin doctor` names your own agents that leave the tool out; add `mcp__x402__request` to their `tools:` to allow paid lookups there. Nothing here edits your agent files.

## Not the same as `allowlistCreators`

`allowlistCreators` is a spend-policy key that restricts which hosts may be paid at all. The permission rule on this page is a harness setting about which tool may run. They are separate gates and neither substitutes for the other.
