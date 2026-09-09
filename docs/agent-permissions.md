# Agent permissions

Coding harnesses running unattended ("auto mode", "full auto", YOLO) classify each
shell command before running it, and an unknown binary is denied by default. That
denies the free verbs too, which breaks the whole marketplace loop: the skills
forbid working around a denial, so a denied `tenjin search` just stops.

Pre-clearing the free verbs once fixes that. This page is the full reasoning
behind which verbs are on that list, which two are separate opt-ins, and which are
never recommended at all, and it is where `tenjin install` sends you. The [README](../README.md#permissions) carries the paste block and the
three-tier summary.

## The free tier

The free tier is nine rules for the `permissions.allow` array of Claude Code's
`~/.claude/settings.json`. `tenjin install` can write them for you; see
[Getting the rules onto your machine](#getting-the-rules-onto-your-machine).

```
Bash(tenjin search:*)
Bash(tenjin wallet fund:*)
Bash(tenjin inspect:*)
Bash(tenjin read:*)
Bash(tenjin outcome:*)
Bash(tenjin doctor:*)
Bash(tenjin wallet show:*)
Bash(tenjin wallet balance:*)
Bash(tenjin config get:*)
```

None of those can spend; `tenjin doctor` decrypts locally to check your wallet
still opens. That is the definition of this tier, and it is deliberately narrower
than "signs nothing" and narrower than "never opens the keystore": `tenjin read`
signs with a P-256 session delegation, and mints one with a wallet signature when
an owned piece is not on this machine and no delegation is live. The delegated key
is the wrong curve to authorize a USDC transfer, so no amount of it moves money.

### What each verb actually does

| Rule                            | Why it is safe to pre-clear                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Bash(tenjin search:*)`         | Free anonymous marketplace search. No wallet, no signing, no payment. POSTs the generalized question off-machine.                  |
| `Bash(tenjin wallet fund:*)`    | Owner call (2026-08-12): mints a card-funding checkout link for THIS wallet only; moves no money, origin-pinned (no `--base-url`). |
| `Bash(tenjin inspect:*)`        | Free pre-purchase card and preview. Never signs, never pays, never saves.                                                          |
| `Bash(tenjin read:*)`           | Free-only delivery. Cannot spend, but opens the keystore to mint a read-scoped session key, and transmits it (see below).          |
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

### `read` mints and transmits a credential

Worth knowing before you paste the `read` line. A paid piece this wallet already
owns but has never been read on this machine takes one wallet signature: `read`
mints the same ≤24h read-scoped P-256 delegation `publish` and `edit` mint, stores
it 0600 in `~/.tenjin/session.json`, and transmits that
**wallet-derived credential** to the origin of the piece. Every later owned read
reuses it and asks for nothing.

It mints and presents only for the origin of the URL being read, and never for a
second origin while a delegation for another is cached, which is what keeps a
stray `--base-url` from turning an allowlisted read into a wallet signature
against a host an agent picked.

`read` still **cannot pay**: the payment module is absent from its import graph,
test-pinned, and the delegated key is the wrong curve for an EIP-3009
authorization. It never consults the spend policy.

### The `read` scope is not a containment boundary

Do not read the `read` scope as more than a scope. It is enforced only on the
request shape that carries a session signature alongside the delegation header; a
copy of the same delegation presented differently is not scope-checked, so treat
the file as a credential carrying your wallet's authority. Its real bounds are the
24h expiry, the 0600 mode, and the origin binding.

## Getting the rules onto your machine

`tenjin install` writes the nine rules into `~/.claude/settings.json` for you,
plus the two rules your publish mode carries (below). It does not ask a question
of its own about them. Installing tenjin is the consent for the free nine, and
the publish-mode select is the consent for the pair, because that is the answer
that adds them:

> Auto (recommended) — your agent publishes and updates pieces on its own, under
> your identity; it also allows `tenjin publish` and `tenjin edit` in the
> harness.

One prompt, one consent: a second yes/no naming the same grant would ask twice
for one thing, and put a rule string in front of an operator with no way to act on
it mid-install. This page is where the detail lives.

It merges the rules in. The write appends the rules that are missing and
never reorders or rewrites an existing entry or any other key in the file. It
removes exactly two things: a rule an older version of this CLI wrote and this one
no longer does, and, when your `publish.mode` is back to `review`, the two rules
that mode carries. A settings file it cannot parse is reported and left exactly as
it is, never repaired. The rules it may write are fixed constants selected by your
publish mode, so no flag or config value can widen it to `buy`, `wallet send`,
`config set`, or a blanket `Bash(tenjin:*)`.

A non-interactive install (piped, or under `--json`) does the same write, for the
same reason: the machine most likely to be denied mid-task is the headless one.
`--no-allow-free-verbs` is the only opt-out. Every run reports how many rules
landed and in which file, on its `permissions` row.

`tenjin doctor --json` carries this whole recommendation as data under
`permissions` (every rule, every per-verb note, both caveats, on the failure
envelope as well as the success one) so an agent that just got denied can point
you at the exact line. Its human render is the check list and nothing else,
except on a machine whose own publish mode is missing a rule: that one line names
the rule, because it is a finding about the machine rather than a standing
recommendation.

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

## Opt-in: `tenjin pay`

The generic x402 payment verb is its own opt-in, with everything above applying
unchanged:

```
Bash(tenjin pay:*)
```

Two differences from `buy`. The destination set is wider: the configured base
URL always, and with `bazaarPay` on, any registry-listed foreign seller. And
there is no library dedupe: `pay` has no owned-content re-read, so a looping
agent pays on every call, bounded only by `maxAutoSpend`, `sessionBudget`, and
`--max-price`. Leave `bazaarPay` off unless you mean it.

## Never recommended

Deliberately **never** recommended, because each is a human decision:

| Verb                   | Why it stays a human decision                                                        |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `tenjin wallet send`   | Moves USDC out of the wallet, and is not bounded by the buy spend policy. See below. |
| `tenjin publish`       | Publishes publicly under your identity. Cleared only by `publish.mode`; see below.   |
| `tenjin edit`          | Edits live posts and prices. Cleared only by `publish.mode`; see below.              |
| `tenjin delete`        | Destroys a published piece. No mode clears it; see below.                            |
| `tenjin wallet create` | Creates the payment credential.                                                      |
| `tenjin config set`    | It can widen the agent's own spend policy.                                           |
| `tenjin install`       | Writes into harness config and skills directories.                                   |
| `tenjin mcp`           | It re-exposes every command core, so clearing it clears everything.                  |
| `tenjin update`        | It replaces the tenjin binary the agent then runs. See below.                        |

For the same reason, prefer the narrow rules above over a broad `Bash(tenjin:*)`,
`Bash(tenjin wallet:*)`, or `Bash(tenjin config:*)`, which would swallow them.

## The two rules your publish mode carries

`publish.mode` is where you say whether publishing asks you first. On `auto` or
`full-auto` it does not, and a harness prompt in front of every publish asks that
same question again somewhere the mode cannot answer it, so the agent stops and
the mode you chose does nothing. That is why two rules track the mode:

- `Bash(tenjin publish:*)` puts new content on the marketplace under your identity.
  It publishes Markdown supplied on stdin or the contents of any regular local file the
  agent can read, gated only by the deterministic scan below. The prefix rule
  matches a stdin heredoc because its shell/tool command uses `tenjin publish` as
  the command prefix. A file publish must likewise run as its own bare command:
  chaining it after `cat`, `cd`, or the command that writes the file can put a
  different prefix in front and therefore fall outside this rule. Publishing also
  opens your wallet keystore unattended and mints a `read+write` session credential
  to disk when no usable one exists, which is a strictly broader credential than
  the read-only one `tenjin read` mints.
- `Bash(tenjin edit:*)` updates posts your wallet already owns: reprices, refreshes
  an as-of date, repairs an answer card, and flips status both ways, so it can
  promote a draft to published under the same mode gate (a promotion re-runs the
  block-tier secret scan over the stored body). Owner-scoped on both legs, spends
  nothing, and mints no new posts, but it opens the keystore on the same terms,
  and it runs the same `publish.mode` gate in the CLI. A mode that can publish a
  post unattended but cannot fix that post's price is the asymmetry the mode exists
  to remove.

Neither is in any block above: there is nothing to paste here, because the mode is
the decision and the rules only follow it. Neither can spend: `publish` and `edit`
carry no payment path, so what they reach is your identity and your keystore, not
your balance.

**The mode carries two rules and stops there.** `tenjin delete` is the write verb
it deliberately does not reach: consent to publish is not consent to destroy, and
letting one decision authorize the other is how an operator ends up with a piece
gone that they only ever agreed to have published. So `delete` sits on the never
list above under any mode, and the CLI does not rely on the harness for that: the
command reads no mode at all and confirms on every run, interactively at a
terminal and by refusing with exit 3 until `--yes` anywhere else. When a piece
should come down but not be lost, `tenjin edit <post-id> --status draft` is the
reversible move, and it rides the ordinary `Bash(tenjin edit:*)` rule.

**Installing Tenjin is the consent for these.** `tenjin install` settles
`publish.mode` at `auto` unless you say otherwise, and writes both rules alongside
the free tier on the FIRST install, headless runs included. Pass
`--publish-mode review` if you want the mode without the rules; at a terminal the
install asks the question outright, with auto as the default answer.

Each surface discloses the grant at the depth its reader can use. At a terminal
the install says which mode it settled, what your agent will now do in plain
words, and the one command that turns it off (`tenjin config set publish.mode
review`); it deliberately prints no rule strings, because a `Bash(...)` line an
operator is meeting for the first time mid-install is not something they can act
on. `tenjin install --json` and `tenjin doctor --json` carry the whole thing as
data: both rule strings, what they clear including the keystore and the
`read+write` session mint, and all three undos. This page is the long form.

The bare CLI, on a machine where `install` never ran, still defaults to `review`
and grants nothing. Install is the consent anchor: nothing here is granted to
someone who never ran it.

Going back to `review` takes them away, on the next `install` or immediately
with `tenjin config set publish.mode review`. `tenjin uninstall` reclaims them
like every other rule this CLI wrote. There is no flag that adds them and no line
to paste: change the mode.

Your `publish.mode` lives in `~/.tenjin/config.json` and survives `tenjin
uninstall` along with the rest of your config, so a later `tenjin install` resumes
it and writes both rules again: installing is the consent, each time. Set the mode
to `review` before uninstalling, or pass `--publish-mode review` when you come
back, if you want the rules to stay gone.

`tenjin config set publish.mode` keeps the two in step without waiting for the
next `install`. Moving to `auto` or `full-auto` asks you once, naming both rules,
and writes them on yes; a run with no terminal, a `--json` run, or a no leaves
the file alone and prints where the rules go. Moving back to `review` retracts
them without asking, because that direction can only take back what this CLI
wrote. It runs through a pass that removes and never appends, so it retracts on
any machine carrying the rules, including one whose free tier no longer matches
what this release ships. The one case it cannot handle is a settings file it
cannot parse, which it reports by name along with `tenjin uninstall`.

What still stops a bad publish is the CLI, not the harness prompt: the
deterministic secret scan blocks in every mode and is never clearable by `--yes`,
`auto` stops on any finding, and `full-auto` stops only on a hard block. These
rules clear the harness prompt and nothing else.

Read "`auto` stops on any finding" as a stop rather than as a human, though.
These are prefix rules: they pin the verb, not the flags. `--yes` is an ordinary
flag on the same allowlisted verb, and it clears exactly the WARN findings `auto`
stopped on, so a re-run with it collapses `auto` into `full-auto` with nobody
asked, the same hazard the `tenjin buy` line carries. What holds that line is the
skills, which render the findings as the question rather than asking a generic
one first.

### `tenjin update`, a human decision

`tenjin update` replaces the globally installed `tenjin` with whatever npm serves
next, which is the binary the agent goes on to run for the rest of the session and
every session after it. A successful swap then re-copies the loop daemon's
bundles and rewrites this CLI's own hook entries in `settings.json`, for the
profile the update ran under, so the harness fires the new build rather than the
one just replaced; it writes no permission rule and registers no hook on a machine
that had none. Which build an agent executes is an operator decision, so
no recommended rule pre-clears it. `tenjin update --check` only reports, but a
prefix rule pins the **verb**, not the flags, so clearing the check would clear
the install with it. Nothing stops you adding the rule yourself; it stays off the
recommended set.

### `tenjin wallet fund`, free on both surfaces

Free by owner decision (2026-08-12), because on either surface the command just
opens the fund modal. Minting a checkout link moves no money: the destination is
pinned server-side to the wallet that signed the request, so a link an agent
mints can only ever fund your own wallet, the CLI refuses any checkout host but
`pay.coinbase.com`, and the payment itself happens behind Coinbase's own human
gate. The `--base-url` caveat that qualifies every other prefix rule does not
apply here: `fund` is pinned to the production origin and takes no override from
the flag, the environment, or config, so an allowlisted invocation cannot steer
where the wallet's SIWX proof goes. `read` is pinned the same way, one step
wider: it presents and mints only against `baseUrl` or `publicShelfUrl` as the
config file names them, so `read --base-url <host>` still fetches a free piece
from that host but signs nothing for it.

### `tenjin wallet send`, the escape hatch

`send` is human-invoked only: it is deliberately absent from the MCP toolset and
the harness skills, and nothing is signed until the previewed (checksummed)
recipient, amount, and network fee are confirmed, interactively at a TTY or
explicitly with `--yes` when headless. It refuses when the active wallet's
passphrase entry is missing. The `sendMaxAmount` hard per-send cap has no
default: `tenjin wallet send` refuses until you run `tenjin config set sendMaxAmount
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
subtracted. All nine are safe to hand over: `search`, `wallet fund`, `inspect`, `read`,
`outcome`, `doctor`, `config get`, `wallet show`, `wallet balance`.
None can spend; `wallet fund` mints a checkout link only a human can pay, and
`read` mints and presents a read-scoped session key (above).

Everything that mutates stays in a mutation-capable, human-gated context:
`publish`, `edit`, `delete`, `buy`, `wallet send`,
`wallet create`, `config set`, `install`. Never delegate
`delete` at all: it is irreversible, and a subagent has no one to ask.

Publishing what a subagent derived is the one exception, and it is a narrow one.
Do not hand a subagent a publish as a task. What the SubagentStop capture arm does
is different: at that subagent's own end, with `hooks.publish` on, the arm asks it
once to publish the finding it just settled, and that publish runs the same local
scan and the same `publish.mode` consent as any other, in the same directory. So
under `review` it refuses and the subagent states the finding instead, for you to
publish; under `auto` with a clean scan, or `full-auto`, it publishes. Your own
turn end then reports what your subagents published.

`hooks.publish` is on by default and asks you and each subagent at its own end,
as context beside the stop rather than as a blocking decision; off it asks
nobody.

Two caveats travel with the safe set. "Read-only" describes your wallet and your
repo, not the network: `search` and `outcome` POST off-machine (a question, a
report) and `read` saves to the local library. And a delegated context is where a stray `--base-url` does the most
damage, so never pass one.

## Running the local MCP server instead?

That is a different permission surface: the harness gates tools there, and these
Bash rules do not apply. If you follow the
[MCP section](../README.md#local-stdio-mcp-server) as well, leave
`mcp__tenjin__tenjin_publish`, `mcp__tenjin__tenjin_edit`,
`mcp__tenjin__tenjin_delete`, and `mcp__tenjin__tenjin_wallet` gated, and treat
`mcp__tenjin__tenjin_buy` as the same opt-in decision as the `buy` line above.
`mcp__tenjin__tenjin_delete` is the one whose core still confirms even if you
clear it: it never reads `publish.mode`, so an ungated call comes back as
`NEEDS_CONFIRMATION` rather than deleting.

## Not the same as `allowlistCreators`

This harness allowlist is unrelated to the `allowlistCreators` spend-policy key:
that one gates **who you may pay**, this one gates **which commands may run**.

## What install writes

`tenjin install` prints five rows and this page carries the rest. What is behind
each row:

**Skills.** The packaged skills, copied into every harness directory it detected
(`~/.claude/skills`, `~/.agents/skills`). A skill already there is replaced by
this package's copy; your own files beside it are left alone.

**Permissions.** The rules above, in `~/.claude/settings.json`. Nine on `review`,
eleven on `auto` and `full-auto`. Deleting those lines undoes it, and so does
`tenjin uninstall`.

**Hooks.** Eleven Claude Code entries in the same file, written as one set. Nine
POST the harness's own hook payload to a Tenjin daemon on `127.0.0.1` — your
machine only, authorized by a token in that file, which is why it is written mode
0600 — and two run `~/.tenjin/hooks/tenjin-shim.mjs` so that daemon is up before
the turn's first tool call. No arm can block or change a tool call; every one of
them only adds context beside it. The arms ask your configured shelf a question
and mention a tested answer if one exists. Six things leave the machine, each
with its secrets stubbed and then cut at 512 characters: a prompt you typed, a
WebSearch query, a WebFetch address and the prompt beside it, the work order a
subagent is dispatched with, and — to the team shelf only — the fingerprint of a
failed command and, when nothing on that shelf is filed under the fingerprint,
the failed command's error line as the runner printed it. Nothing else does.
That sixth one is the only one of the six you did not type: an error line can
carry a path, a host, or an internal package name, and `tenjin hooks disable
failure` is how you keep it here. The files you read and edit are recorded
locally and asked about nowhere; the publish arm reads that record to know your
turn did work, and the failure arm keeps only the time of your last command, so
it can tell that command's output from the one before it.

The seven arms, in the order `tenjin hooks` prints them:

- **prompt** — you press enter. Your prompt goes to the team shelf and the
  public one, and a piece that answers it is named beside what you typed.
- **web-search** — before a WebSearch runs. The query goes to both shelves as
  typed, and an answer already paid for is named beside the search.
- **web-fetch** — before a WebFetch runs. The address goes to both shelves, cut
  at the first `?` or `#` so a token in the query string or the fragment stays
  here, along with the prompt attached to the fetch.
- **subagent** — you dispatch a subagent, and that subagent starts. The work
  order goes to both shelves at dispatch; you are told nothing, and whatever it
  found opens the subagent's first turn instead. The start itself sends nothing.
- **failure** — a shell command fails. Its fingerprint, a hash rather than your
  error text, goes to the team shelf first; if no piece is filed under that
  hash, the error line itself follows as a question, in the runner's words
  rather than yours, so a teammate's write-up that carries no fingerprint is
  still reachable. Both rounds are the team shelf, never the public one, and
  with no team shelf configured nothing leaves at all. This machine keeps no
  record of the errors it has fixed, and nothing here pairs a failure with a
  later pass.
- **publish** — your turn ends, and each subagent's turn ends. If there is
  something worth writing up, you are asked once whether to publish it, and the
  answer is kept here. It sends nothing: publishing is `tenjin publish`, which
  you run.
- **primer** — a session starts, including a clear and a compact. Two paragraphs
  about the shelf go in front of the model. It sends nothing.

There is one key per arm, all on out of the box: `tenjin hooks` lists the seven
with what each has fired and hit this week, and `tenjin hooks disable web-fetch`
silences that one without unwiring anything. Hooks are read once at session
start, so Claude Code has to be restarted.

**Publishing.** `publish.mode` in `~/.tenjin/config.json`, from the select above.
`tenjin config set publish.mode review` puts it back to asking first.

**Wallet.** A local Base wallet at `~/.tenjin/wallet.json`, unless `--no-wallet`.
The key is encrypted at rest (keystore v3, scrypt, mode 0600) and never leaves
this machine; the passphrase goes to your OS credential store, or to
`TENJIN_WALLET_PASSPHRASE` if you set one. With neither, nothing is created and
the run says so. It holds $0: funding is a human step, `tenjin wallet fund`.

`tenjin uninstall` removes all of it except the wallet, the config, the library
and the loop database, which are yours rather than something install created.
