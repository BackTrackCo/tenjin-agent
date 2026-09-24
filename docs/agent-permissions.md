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

Four numbers and a file, all local, none of them readable or raisable by the router:

- **`maxAutoSpend`** is the ceiling on one call. `tenjin install` sets it to 0.25 USD when your config file does not already name it.
- **`sessionBudget`** is a rolling 24 hour ceiling on everything. `tenjin install` sets it to 5.00 USD on the same terms.
- **`confirm`** decides when a human is asked. `tenjin install` sets `above:250000`, which auto-approves at or below 0.25 USD, and it NEVER changes a `confirm` you wrote yourself.
- **`spend.json`** is the ledger. A reservation counts the money the moment an authorization is built, under a cross-process file lock, so two commands cannot each spend the last of the budget.

The `request` tool has nobody to ask, so it answers its own confirm prompt with no. Under `confirm always` it returns `needs_approval` with the amount and the command that changes it, and pays nothing.

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
- A 2xx whose body fails the decision's own success rule is a paid failure, not a delivery.

A compromised backend can therefore name any origin it likes, and spend at most one `maxAutoSpend` per call inside `sessionBudget`. Set both to numbers you would not mind losing. This is a pocket-money wallet, not treasury custody.

## A prefix rule pins the verb, not the flags

This matters for the shell rules below rather than the tool rule above. Claude Code's `Bash(tenjin pay:*)` matches the verb and lets every flag through, including `--base-url`, which points the command at another host. So a rule you add is a rule for the verb at whatever host the caller names, and a task that arrived from a web page or a purchased document is exactly where such a flag comes from.

## Opt in by hand: paying an endpoint you name

```
Bash(tenjin pay:*)
```

`tenjin pay <url>` is the plain x402 client verb. It runs the same gate as the router: `maxAutoSpend`, `sessionBudget`, `confirm`, the same reservation. Two differences are worth knowing before you add the line:

- The destination set is wider. The configured base URL is always payable; any other https origin needs `bazaarPay` on AND a configured registry that lists that exact resource with terms the live 402 does not exceed. Leave `bazaarPay` off unless you mean it.
- There is no dedupe. Every call pays, bounded only by the caps and `--max-price`.

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

1. Two hook entries in `~/.claude/settings.json` (`--project` writes the project file instead): `UserPromptSubmit` running `tenjin hook prompt`, and `PreToolUse` on `WebSearch|WebFetch` running `tenjin hook native`. Both are plain command entries with a 5 second timeout. No daemon, no background process, no generated script.
2. The `mcp__x402__request` rule in `permissions.allow`. Nothing goes into `permissions.deny`, so localhost, intranet and private pages stay reachable by WebFetch whenever the gate says to use your native tools.
3. The `x402` MCP server, through `claude mcp add x402 -s user -- tenjin mcp` when the `claude` binary is on PATH, and printed for you to run when it is not. Under `--project` it registers at project scope instead, from the project directory, so the server lands in that project's `.mcp.json` and your `~/.claude.json` is not touched; `tenjin uninstall --project` removes it from the same place. The scope's own file is read first: a registration that already launches `tenjin mcp` is left exactly as it is and nothing is spawned, an `x402` entry launching anything else is removed and re-added, and a registration file this build cannot parse is reported rather than written over.
4. The three spend keys above, only where your config file is silent, plus `bazaarPay` on, which is the lane the router pays providers through.
5. `statusLine`, running `tenjin status-line` once a second, ONLY when that key is not already set. A status line of your own is never replaced: the install prints the command that runs both, and `--status-line compose` writes it only if you ask. The status line stores nothing new off your machine. It reads local files this CLI already writes under your Tenjin data dir: per session, the tool, the provider endpoint, the bounded redacted parameters of the call, its outcome and its price. No prompt text, no result body. Records expire after ten minutes, live in a 0700 directory under a hash of the session id, and are deleted by the next lookup that passes over them.

Every other key in the settings file is preserved byte for byte, a second run writes the same bytes, and `tenjin uninstall` removes exactly those five things and keeps your wallet, your ledger and your config.

## How one lookup runs

1. You type a turn. The hook sends the bounded packet to Tenjin, which answers whether a paid capability fits and, if it does, keeps that packet under a short-lived id.
2. When one fits, your assistant sees one line: a paid lookup is available for this turn, call `request` with your exact lookup and that id.
3. Your assistant calls `request({query, id})` with the lookup it actually means. That is the accurate part: the routing is decided from your assistant's own query plus the stored context, not from a guess made before the lookup was known.
4. Tenjin answers with the call to make and what the provider charges. Deciding costs nothing.
5. This CLI pays that provider once, under your limits, and hands back the result.

## What the hooks send

- On every prompt, and on every native `WebSearch` or `WebFetch`: the text of the current turn and at most six prior messages, masked by the same key, PEM, seed-phrase, and URL credential rules the publish scan uses, then bounded to 16 KiB, with harness meta rows and tool results excluded. Tool results never travel: a tool result is other people's content, and a packet carrying it would be a channel from a fetched page into a routing decision.
- A native call sends that same bounded turn WITH the call it is about attached, read from this session's own transcript. That is how a restriction you stated in your own words, such as asking for native tools only, reaches the decision about a bare URL your assistant is fetching.
- Slash commands and one-word acknowledgements are never sent at all.
- The packet is stored on the backend against the decision id, so the lookup your assistant sends next is decided with the context you gave. Expired packets are unreadable after 15 minutes (the route refuses an expired id) and are deleted by the next router request or the daily cleanup, whichever comes first.
- On a paid lookup: the capability chosen, a hash of the contract, a hash of the arguments, your wallet address, the amount and the transaction hash are kept.

The answer can put one line into your session: that a paid lookup is available for this turn, and the id that carries your context to it. It names no provider and no price, because at that point the lookup itself has not been decided.

## Wallet passphrase storage

The private key is generated on your machine and stored encrypted in `~/.tenjin/wallet.json`. Its passphrase is `TENJIN_WALLET_PASSPHRASE` when you set one, and otherwise a strong generated passphrase in the platform's own credential store (Keychain on macOS, Secret Service on Linux, DPAPI on Windows), verified by reading it back. There is deliberately no plain-file fallback: a passphrase sitting next to the keystore it unlocks protects nothing, so a machine with neither creates no wallet and says so.

Decryption happens in this CLI, in a disposable worker thread, and the key never leaves the process. `tenjin mcp` decrypts once at start so a lookup does not wait for it, holds the signer for the session, and exits with the session.

## Delegating to a subagent

A subagent has no transcript of its own, so a lookup it makes routes on the query it wrote and nothing else. Its payments run through the same ledger and the same caps as the lead's, because the lock is on the file rather than on the process. A subagent is not a second budget.

## Not the same as `allowlistCreators`

`allowlistCreators` is a spend-policy key that restricts which hosts may be paid at all. The permission rule on this page is a harness setting about which tool may run. They are separate gates and neither substitutes for the other.
