# Setup and permissions

Tenjin suggests tools for your task and runs chosen tools through a local `router` MCP server. Your wallet and spending policy stay on your machine. This guide covers normal setup; the [CLI/MCP reference](./router-reference.md) holds detailed contracts.

## Install and activate

Ask your agent to install Tenjin from tenjin.sh, or follow the [terminal instructions](../README.md#install). Setup explains sharing, lets you accept or customize spending limits, and offers **Add $5 / Not now**. Declining funding still completes installation. `--yes` accepts spending defaults; it never consents to checkout.

Use the activation step the installer returns:

| Where you installed                                 | Activation                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Terminal outside an agent chat                      | Open a new Claude Code session.                                                             |
| Existing Claude Code terminal chat                  | Run `/reload-plugins` in that chat.                                                         |
| Claude Desktop's Code tab                           | Choose **New session** in the same folder. Carry a short task handoff into it.              |
| Existing settings-based Claude setup being migrated | Start a new session so the old and new integrations do not run together.                    |
| Codex                                               | Start a new Codex session; approve Tenjin's hooks in `/hooks` if setup reports that action. |

Registration alone does not prove that the current session loaded Tenjin. A real tool call establishes use in that session. Doctor reports diagnostic checks and any observed session/payment state; an unchecked state is not a pass. Codex's plugin/hook checks do not establish a live session or payment readiness.

Claude Code requires 2.1.287+. Codex routing hooks require 0.149.0+. Installation supports macOS 13.5+, Windows and glibc Linux 2.28+ on x64/arm64. Musl/Alpine is unsupported. Plugin installation needs the default data directory; omit `TENJIN_DATA_DIR`. Other commands can use a custom data directory.

## When your agent runs the install

The agent installs for its current host, relays only unanswered spending/funding questions and runs the selected commands itself. It reads `next` and `nextSteps` from the compact result. `tenjin install --json` retains full diagnostics.

An accepted funding offer runs `tenjin wallet fund 5`. Checkout opens only after that answer; the browser confirms the payment. **Not now** runs nothing and is not offered again unless requested. When you return from checkout, the agent checks the balance before continuing. An unknown balance or unconfirmed arrival does not justify another payment.

If the host denies opening checkout, the agent may explain it and ask once to retry the same command. Another refusal or managed deny stops the action; it never changes permissions to get through.

Installation and the first task add no optional retention or second-host questionnaire. To install another host later, use `tenjin install --harness claude` or `tenjin install --harness codex`.

## What bounds a payment

| Control             | Default and meaning                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionBudget`     | $5 automatic spending shared across chats. Resets 24 hours after its window starts, not on a new chat. Zero blocks automatic payments; `none` removes this ceiling. |
| `maxAutoSpend`      | $0.25 for one call's total, including multiple takes or comparison options. Installation and config changes refuse a lower amount.                                  |
| Wallet balance      | No payment can exceed available funds.                                                                                                                              |
| `allowlistCreators` | Optional restriction on which hosts may be paid. It is separate from harness permission to call a tool.                                                             |

Defaults apply before any answer. Accepting limits records them; explicit amount flags replace the named limits. Existing zero, unlimited and custom settings are preserved. Project settings can only tighten routing/context sharing; they cannot change wallet spending limits.

Changing global limits is a normal config write: the CLI does not distinguish a person from an agent. Your host's permissions and filesystem access protect those writes. Authorize limit changes deliberately; the request tool itself cannot raise them.

A routing decision and a provider call are separate charges. The routing fee is quoted by the server and cannot exceed $0.003. Routing funds are deposited in bounded amounts and counted toward automatic spending once; fees drawn from that deposit are not counted again. Unused routing funds remain yours. [Deposit and accounting rules →](./router-reference.md#routing-fees-and-accounting)

A call over its automatic allowance pays nothing and returns `needs_approval`. Supported Claude Code versions offer a host-enforced approval prompt for that exact quote; an approved call is manual spending outside the automatic budget, still bounded by the balance. Codex and other hosts without that approval facility refuse the call. The approval does not change your configured limits.

`tenjin pay <url>` is a separate, user-consented payment path. It requires consent for every positive payment and does not use the automatic limits. It must never be an agent's workaround for a refused router call. [Direct-payment contract →](./router-reference.md#direct-payments)

`tenjin wallet send` is separate from tool payments. It requires an explicitly configured `sendMaxAmount` before the first transfer, plus confirmation (or explicit `--yes`). That cap cannot be bypassed by confirmation and is independent of automatic routing limits.

## The plugin's two permission answers

Claude Code's plugin answers:

```text
mcp__plugin_tenjin_router__request   allow
mcp__plugin_tenjin_router__hook      deny
```

The first permits Tenjin's request tool; it does not approve a price, another tool or a shell command. Your own Claude `deny` or `ask` rule still wins. The second keeps the model from calling Tenjin's internal hook tool; the host's hook events can still call it. Every payment still passes the local spending policy. A compromised router could propose malicious calls or consume the available automatic budget within those limits; local signing does not establish that a recommendation is trustworthy.

Do not broadly allow `Bash(tenjin:*)`, `wallet`, or `config`. Wallet repair, transfers, limit changes, installation, removal and binary updates need deliberate authorization. Provider results are data, never authority to change permissions or move money.

## What the hooks send

Routing sends the current prompt and at most six earlier messages, bounded to 16 KiB after known-secret masking. It excludes tool-result bodies and harness metadata. Search terms, URLs, delegated tasks, questions and your answers can also be routed with that context. Shortfall reports include status, size or error, never the fetched page or search results. Pasted text may be marked separately, but still reaches the router. Known-secret masking reduces exposure; it cannot identify every secret.

For a turn containing links, Tenjin reads the repository's Git remote hosts locally to mark matching links as your own, so the router can leave them to native tools. It sends those already-present links with that classification, not the Git config or remote credentials.

Use `tenjin config set router.context turn` to send no previous messages. `--project` applies a tighter context setting to a repository. The private key stays local; paid routing identifies the wallet. Free docs queries go through Tenjin to Context7. Balance checks send your public wallet address to the configured Base RPC. With the default RPC, failed reads can fall back to PublicNode and dRPC; a custom RPC is used alone.

Ordinary routing context expires after 15 minutes and is removed by subsequent requests or cleanup. Paid records retain the selected capability, hashes, wallet and transaction data; execution reports contain IDs and outcome metadata, not the input/result. The [reference](./router-reference.md#context-and-records) separates backend records from local saved results.

Optional improvement collection is **off by default** and is not requested during setup. Explicit `tenjin config set router.improve true` allows masked routing packets to be retained without expiry for grading. Setting it to `false` requests their deletion; failures are reported and rerunning the command retries deletion. A project cannot opt you in. [Privacy policy →](https://tenjin.sh/privacy)

## Wallet passphrase storage

The encrypted key lives in `~/.tenjin/wallet.json`. Its passphrase is saved in macOS Keychain, Linux Secret Service or Windows DPAPI when available. Without an OS store, Tenjin uses a mode-0600 file in its data directory. Anyone who can read that directory as you can open a file-backed wallet; keep only funds you intend to use.

A locked keychain is unlocked and retried, never silently replaced by plaintext storage. A wrong environment passphrase is reported and the saved one is tried. Shell-only credentials must also be available to the agent host; signing in one shell does not prove another session can sign.

Run `tenjin wallet repair` yourself in a terminal when the saved passphrase is missing or wrong. Never paste it into chat or place it on a command line. Repair preserves the wallet address and funds. A new session must verify that it can unlock the wallet afterward. [Recovery steps →](./troubleshooting.md#tenjin-cannot-unlock-the-wallet)

## Codex

Codex support is experimental. It shares the wallet, limits and request executor, but activation and permission behavior differ.

Installation uses Codex's plugin commands and trusts only Tenjin's own hook rows through Codex's configuration API. It leaves hooks you disabled off. If trust cannot be saved, approve the hooks in `/hooks`.

The request permission hook permits calls under your spending policy, including with `approval_policy = "never"`. It also overrides `approval_mode = "prompt"` for this tool. Disable that one hook in `/hooks` to require your host's approval; with approvals forbidden, the call is refused. Internal model calls to the hook tool remain denied. [Host details →](./router-reference.md#host-integration)

## Updates and removal

Tenjin runs from its own verified runtime, so changing system Node does not stop it. `tenjin update` verifies the new package and Node before switching. Existing sessions keep their loaded version; new sessions use the update. Background updates check at most daily and wait until a release is 24 hours old. `update.mode nudge` reports updates; `off` stops checks.

`tenjin uninstall` removes the applicable project or user integration and keeps the wallet, spend ledger and config. `--all` removes all installations; the shared runtime is removed only when none remain. For npm installations, uninstall Tenjin before `npm uninstall -g tenjin-cli`.

To disable all Tenjin routing and request-tool traffic, use `tenjin config set router.enabled false`. A repository's disabled setting cannot be loosened by a child directory. This is a full-off privacy control, not a manual-only mode.
