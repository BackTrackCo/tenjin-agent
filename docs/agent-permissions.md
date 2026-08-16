# Agent permissions

Coding harnesses running unattended ("auto mode", "full auto", YOLO) classify each
shell command before running it, and an unknown binary is denied by default. That
denies the free verbs too, which breaks the whole marketplace loop: the skills
forbid working around a denial, so a denied `tenjin search` just stops.

Pre-clearing the free verbs once fixes that. This page is the full reasoning
behind which verbs are on that list, which two are separate opt-ins, and which are
never recommended at all, and it is where `tenjin install` and `tenjin doctor`
send you. The [README](../README.md#permissions) carries the paste block and the
three-tier summary.

## The free tier

The free tier is nine rules for the `permissions.allow` array of Claude Code's
`~/.claude/settings.json`. `tenjin install` can write them for you; see
[Getting the rules onto your machine](#getting-the-rules-onto-your-machine).

```
Bash(tenjin search:*)
Bash(tenjin fund:*)
Bash(tenjin inspect:*)
Bash(tenjin read:*)
Bash(tenjin outcome:*)
Bash(tenjin doctor:*)
Bash(tenjin wallet show:*)
Bash(tenjin wallet balance:*)
Bash(tenjin config get:*)
```

None of those can spend, and none can move your keys; `tenjin doctor` decrypts
locally to check your wallet still opens. That is the definition of
this tier, and it is deliberately narrower than "signs nothing": `tenjin read` can
present a session key that already exists, which is a signature — a P-256
delegation, the wrong curve to authorize a USDC transfer. It cannot mint one; that
needs the wallet.

### What each verb actually does

| Rule                            | Why it is safe to pre-clear                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Bash(tenjin search:*)`         | Free anonymous marketplace search. No wallet, no signing, no payment. POSTs the generalized question off-machine.                  |
| `Bash(tenjin fund:*)`           | Owner call (2026-08-12): mints a card-funding checkout link for THIS wallet only; moves no money, origin-pinned (no `--base-url`). |
| `Bash(tenjin inspect:*)`        | Free pre-purchase card and preview. Never signs, never pays, never saves.                                                          |
| `Bash(tenjin read:*)`           | Free-only delivery. Cannot spend and cannot open the keystore, but transmits a cached session key when one exists (see below).     |
| `Bash(tenjin outcome:*)`        | Free honest outcome report on a past search. No wallet, no payment. POSTs a report that moves the marketplace's reuse signal.      |
| `Bash(tenjin doctor:*)`         | Local environment and API reachability diagnostics; decrypts the wallet locally to check it still opens.                           |
| `Bash(tenjin wallet show:*)`    | Prints the wallet address and key source. Never prints the key.                                                                    |
| `Bash(tenjin wallet balance:*)` | Read-only USDC balance query on Base.                                                                                              |
| `Bash(tenjin config get:*)`     | Reads one effective config value. Note `config get rpcUrl` returns a URL that commonly embeds a provider API key.                  |

`tenjin doctor --json` emits the same per-verb notes under `permissions`, so an
agent can read them without this page.

### Three free verbs are not read-only

Worth knowing before you pre-clear them: `tenjin search` POSTs your generalized
question off-machine, and `tenjin outcome` POSTs a report that moves the
marketplace's reuse signal — both unauthenticated and free, neither carrying a
credential — while `tenjin read` writes locally, saving a delivered piece to your
library.

### `read` transmits a credential once a session key exists

Worth knowing before you paste the `read` line: once a session key exists, `read`
**transmits that wallet-derived credential** to the origin it was minted for. That
origin binding is what keeps a stray `--base-url` from redirecting it, and it is
the reason the binding exists rather than a nicety.

`read` itself can never mint one: it imports no wallet, payment, or
session-minting module, and its import graph is test-pinned to stay clear of all
three. It cannot unlock a keystore and never consults the spend policy.

## Getting the rules onto your machine

`tenjin install` writes the nine rules into `~/.claude/settings.json` for you. It
is one of the four setup decisions, and at a terminal it asks:

> Let your agent search tenjin without permission popups? Adds 9 free commands to
> `~/.claude/settings.json`. None can spend USDC or move your keys; doctor may
> check your wallet still opens. Three send or store data (search, outcome,
> read). Full caveats:
> https://github.com/BackTrackCo/tenjin-agent/blob/main/docs/agent-permissions.md

Answer yes and it merges them in. The write is additive only: it appends the rules
that are missing and never removes, reorders, or rewrites an existing entry or any
other key in the file, so a re-run adds nothing. A settings file it cannot parse is
reported and left exactly as it is, never repaired. The rules it may write are a
fixed constant, so no flag or config value can widen it to `buy`, `publish`,
`session start`, or a blanket `Bash(tenjin:*)`.

A non-interactive install (piped, or under `--json`) does the same write BY
DEFAULT, with no flag: the machine most likely to be denied mid-task is the
headless one, and there is nobody there to answer. `--no-allow-free-verbs` opts
out; `--allow-free-verbs` states the default explicitly. Every run that writes
reports how many rules landed, in which file, and that deleting those lines undoes
it.

`tenjin doctor --json` carries this whole recommendation as data under
`permissions` — every rule, every per-verb note, both caveats, on the failure
envelope as well as the success one — so an agent that just got denied can point
you at the exact line. Its human render is the check list plus one link back
here.

## A prefix rule pins the verb, not the flags

Every line above also clears `--base-url <url>` on that verb, because the CLI
accepts the global flags on every subcommand. `--base-url` is validated as a URL
and nothing more, and it wins settings precedence, so it moves where the question
goes, where `doctor` probes, and (with the `buy` line below) where a SIWX signature
and an EIP-3009 payment authorization are sent. The origin pin only checks that a
resource URL shares an origin with the _configured_ base, so an attacker-controlled
pair satisfies it.

There is no prefix syntax for "this verb but not that flag", so treat this as a
disclosed limit: set your base URL in config, and allowlist these verbs only if you
are content for an agent to be able to choose the destination host. The skills tell
agents never to pass `--base-url` on an allowlisted verb, but that is a convention
rather than an enforced boundary.

## Opt-in: purchases

Purchases are a **separate, explicit opt-in**:

```
Bash(tenjin buy:*)
```

Read this before pasting it: **on the default config that line authorizes
unattended spending up to your wallet balance.** `--yes` is an ordinary flag on the
same allowlisted verb and it clears the confirm gate outright, so `confirm: always`
does not put a human on every purchase once the agent can pass `--yes`.

Walking the defaults:

- `allowlistCreators` is empty, so the creator gate is off.
- `maxAutoSpend` is `0` and `confirm` is `always`, which together only ask for a
  confirmation that `--yes` satisfies.
- `sessionBudget` is `0`, which the policy reads as **no ceiling at all**, not a
  zero one.

Set real values first:

```bash
tenjin config set maxAutoSpend 0.25
tenjin config set sessionBudget 2.00
```

The allowlist line itself never raises a spend cap. That is true, and it is not the
same as saying the caps stop an allowlisted `buy`.

## Opt-in: minting a session key

Minting a session key is the **other** explicit opt-in. It spends nothing and
cannot spend, but it opens the keystore:

```
Bash(tenjin session start:*)
```

`tenjin session start --scope read` takes one wallet signature and leaves a ≤24h
P-256 delegation in `~/.tenjin/session.json` (0600), which `tenjin read` then
presents to recover pieces you already own. The key is the wrong curve to sign an
EIP-3009 payment authorization, so the line can never become a spend grant.

### The `read` scope is not a containment boundary

Do not read the `read` scope as more than a scope. It is enforced only on the
request shape that carries a session signature alongside the delegation header; a
copy of the same delegation presented differently is not scope-checked, so treat
the file as a credential carrying your wallet's authority. Its real bounds are the
24h expiry, the 0600 mode, and the origin binding.

### What you are actually clearing

**Unattended keystore access.** On an encrypted wallet the passphrase comes from
the environment rather than from you, and the `--base-url` caveat above bites
hardest here, because a mint against a host an agent chose is a wallet signature
you did not intend to make. `tenjin doctor` reports whether a session exists, for
which origin, at what scope, and when it expires.

## Never recommended

Deliberately **never** recommended, because each is a human decision:

| Verb                   | Why it stays a human decision                                                        |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `tenjin send`          | Moves USDC out of the wallet, and is not bounded by the buy spend policy. See below. |
| `tenjin publish`       | Puts your content on a public marketplace under your identity.                       |
| `tenjin edit`          | Edits live posts and prices; a prefix rule cannot clear its read half only.          |
| `tenjin wallet create` | Creates the payment credential.                                                      |
| `tenjin config set`    | It can widen the agent's own spend policy.                                           |
| `tenjin install`       | Writes into harness config and skills directories.                                   |
| `tenjin mcp`           | It re-exposes every command core, so clearing it clears everything.                  |
| `tenjin update`        | It replaces the tenjin binary the agent then runs. See below.                        |

For the same reason, prefer the narrow rules above over a broad `Bash(tenjin:*)`,
`Bash(tenjin wallet:*)`, or `Bash(tenjin config:*)`, which would swallow them.

### `tenjin update`, a human decision

`tenjin update` replaces the globally installed `tenjin` with whatever npm serves
next, which is the binary the agent goes on to run for the rest of the session and
every session after it. Which build an agent executes is an operator decision, so
no recommended rule pre-clears it. `tenjin update --check` only reports, but a
prefix rule pins the **verb**, not the flags, so clearing the check would clear
the install with it. Nothing stops you adding the rule yourself; it stays off the
recommended set.

### `tenjin fund`, free on both surfaces

Free by owner decision (2026-08-12), because on either surface the command just
opens the fund modal. Minting a checkout link moves no money: the destination is
pinned server-side to the wallet that signed the request, so a link an agent
mints can only ever fund your own wallet, the CLI refuses any checkout host but
`pay.coinbase.com`, and the payment itself happens behind Coinbase's own human
gate. The `--base-url` caveat that qualifies every other prefix rule does not
apply here: `fund` is pinned to the production origin and takes no override from
the flag, the environment, or config, so an allowlisted invocation cannot steer
where the wallet's SIWX proof goes. That pin is what separates `fund` from
`session start` (unattended keystore access, override surface intact), which
stays opt-in.

### `tenjin send`, the escape hatch

`send` is human-invoked only: it is deliberately absent from the MCP toolset and
the harness skills, and nothing is signed until the previewed (checksummed)
recipient, amount, and network fee are confirmed, interactively at a TTY or
explicitly with `--yes` when headless. It refuses when the active wallet's
passphrase entry is missing. The `sendMaxAmount` hard per-send cap has no
default: `tenjin send` refuses until you run `tenjin config set sendMaxAmount
<usd|0|none>` (`0` disables the verb, `none` opts in to uncapped), and `--yes`
can never bypass the cap or the unset refusal. For routing FUTURE revenue away
from the agent wallet entirely, connect the agent to your own Tenjin account
instead (delegation); `send` exists for funds already sitting on the agent key.

## Wallet passphrase storage

The signing passphrase resolves in order: `TENJIN_WALLET_PASSPHRASE`, then the
OS credential store, then an interactive prompt. On `wallet create` with no env
passphrase, a strong random one is generated and saved to the OS store so later
signing is transparent. Every stored entry is **per wallet**, keyed by the
wallet's own address, so replacing a wallet never touches the outgoing wallet's
passphrase. Installs from before per-wallet entries used one shared slot; the
first signing that proves ownership re-keys that slot under the owning wallet's
address, and the copy is verified before the old slot is removed.

Where entries land per platform:

- **macOS**: the login keychain, via the OS `security` tool (the same mechanism
  the GitHub CLI uses): service `tenjin-cli`, account = the wallet address.
- **Windows**: a DPAPI-encrypted file per wallet (`passphrase.<address>.dpapi`),
  decryptable only by the same user on the same machine, via built-in
  PowerShell. The file holds ciphertext, not the passphrase.
- **Desktop Linux**: the Secret Service keyring, via `secret-tool` when
  libsecret-tools is installed: service `tenjin-cli`, account = the wallet
  address.
- **Headless or CI (any OS)**: no durable OS store, so set
  `TENJIN_WALLET_PASSPHRASE`.

The passphrase reaches these tools over stdin, never on a command line, and the
key never leaves the machine.

## Two gaps, both fail-closed

Both are denied, never wrongly allowed:

- Bare `tenjin config` is as read-only as `config get`, but no prefix rule reaches
  it without also covering `config set`, so use `tenjin config get <key>`.
- Group-level flag forms like `tenjin wallet --json show` are not covered, so put
  global flags after the leaf verb (`tenjin wallet show --json`).

## Delegating to a subagent

The free tier is the answer to "what may a read-only subagent run", with nothing
subtracted. All nine are safe to hand over: `search`, `fund`, `inspect`, `read`,
`outcome`, `doctor`, `config get`, `wallet show`, `wallet balance`.
None can spend and none can move your keys; `fund` mints a checkout link only a
human can pay.

Everything that mutates stays in a mutation-capable, human-gated context:
`publish`, `edit`, `buy`, `send`,
`session start`, `wallet create`, `config set`, `install`. In particular, do not
delegate publishing what a subagent just derived: bring the finding back and
publish it from the context that can ask the user.

Two caveats travel with the safe set. "Read-only" describes your wallet and your
repo, not the network: `search` and `outcome` POST off-machine (a question, a
report) and `read` saves to the local library. And a delegated context is where a stray `--base-url` does the most
damage, so never pass one.

## Running the local MCP server instead?

That is a different permission surface: the harness gates tools there, and these
Bash rules do not apply. If you follow the
[MCP section](../README.md#local-stdio-mcp-server) as well, leave
`mcp__tenjin__tenjin_publish`, `mcp__tenjin__tenjin_edit`, and
`mcp__tenjin__tenjin_wallet` gated, and treat `mcp__tenjin__tenjin_buy` as the
same opt-in decision as the `buy` line above.

## Not the same as `allowlistCreators`

This harness allowlist is unrelated to the `allowlistCreators` spend-policy key:
that one gates **who you may pay**, this one gates **which commands may run**.
