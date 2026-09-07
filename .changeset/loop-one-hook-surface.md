---
'tenjin-cli': minor
---

One hook surface, and install and doctor reshaped around it (PR E2).

**Seven config keys, one per arm, all on out of the box.** `hooks.prompt`
(`UserPromptSubmit`), `hooks.web-search` (`WebSearch`), `hooks.web-fetch`
(`WebFetch`), `hooks.subagent` (the dispatch and the child's start),
`hooks.failure` (a failing command), `hooks.publish` (the turn-end ask, to you
and to each subagent) and `hooks.primer` (`SessionStart`), each a boolean
defaulting to `true` and named for what the arm does rather than for the event
it rides. The context arm is bookkeeping for `failure` and `publish` and runs
while either is on. **Deleted: `hooks.push`, `hooks.webSearch`,
`hooks.agentDispatch`, `hooks.capture`, `hooks.sessionPrimer` and the `remind`
mode** — five grouped keys over nine arms meant six of them refused to run until
something set `hooks.push`, and `remind` was a privacy state that "text leaves
as written" had already made empty. `install` writes no hooks key at all, and
the `--search-hooks` flag goes with the prompt it settled: everything is on, and
there is one place to change it.

**`tenjin hooks`** is that place. It prints one row per arm — `ARM`, `STATE`,
`EVENT`, `FIRED 7d`, `HIT 7d`, counted off `loop.db` — plus a last line naming
the daemon and the ledger it counted, with `--json`. `tenjin hooks enable|disable <arm>` writes the same
boolean `tenjin config set hooks.<arm>` writes, through the same locked merge;
the daemon re-reads it per fire, so nothing restarts and nothing re-installs.

**`tenjin grade` moves to the top level** and keeps its flags: it is a report
about the loop's precision, not a switch. **`tenjin push` and `tenjin state
query` are deleted** — `tenjin hooks` answers what the status half was asked,
and `sqlite3 ~/.tenjin/loop.db` answers the rest (the wrapper existed for a
`sqlite3 -readonly` quirk on a database that no longer exists). **`tenjin send`
becomes `tenjin wallet send`**, beside the rest of the wallet verbs; the
permission rules, the never-allowlisted list and both skill references follow.

**`tenjin session start` is deleted, and `tenjin read` mints its read session on
demand** the way `publish` and `edit` already do: one keystore unlock, a 24-hour
delegated key cached 0600 for that origin, presented free on every later read,
through the same `resolveWriteAuth`/`session-key.ts` path the writes take. No
SIWX code is duplicated for reading. `read` is auto-allowed by default and now
opens the keystore and signs, which `docs/agent-permissions.md` says in as many
words; the test pin that `read` never reached the wallet goes, since `publish`
was auto-allowed with full wallet access already and the pin bought nothing. The
mint is pinned the way `wallet fund` is: `read` presents and mints only against
`baseUrl` or `publicShelfUrl` as the CONFIG FILE names them, so an allowlisted
`read --base-url <host>` still fetches a free piece from that host and signs
nothing for it. The refusal's `entitlementCheck` loses `not_performed` and gains
`no_wallet` and `origin_not_configured`, and no fix line names a session
command.

**Install asks two things** — the publish mode (which is also the consent for
the harness allowlist) and whether to create a wallet — and prints ten rows. The
hooks row is now what an operator can act on: `7 enabled; change: tenjin hooks
disable <arm>`.

**Doctor is grouped**: Environment, Shelf, Hooks, Wallet, one line per check and
a `fix:` line only under a warn or a fail. `store` opens `loop.db`, which proves
the `node:sqlite` module, the file and its shape in one go, so the separate
module probe goes; `api` and `search` are two verdicts on one `openapi.json`
fetch; the `test-reporters` project lint goes, leaving the vitest-reporter regex
one home in `test-identity.ts`; the session-key check goes with the verb.
`--prune` and `--json` are unchanged.

**Help is the reference now, and `docs/command-reference.md` is deleted.**
`tenjin --help` groups every command under Setup, Search and read, Publish,
Wallet and Integration, one line each, with the three global flags listed once
and examples and pointers at the end; each command's own help is a usage line,
at most two sentences, its flags, and an example where the flags are not
obvious. The four commands that page alone documented — `pay`, `discover`,
`delete` and `daemon` — say their piece there now, `tenjin hooks` prints the
arms and the ledger path, and the README, `docs/agent-permissions.md` and
`docs/safety-model.md` carry the rest. The audit that came with the reshape
took the dead surface with it: `tenjin help <command>` goes so
`tenjin <command> --help` is the one way in, `(default: [])` stops trailing the
nine repeatable flags, and the globals still parse after a subcommand without
being re-listed under every one. The README's "Core commands" list, which
restated all of this and had fallen behind it, goes the same way, and the arm
table stays what `tenjin hooks` prints rather than a snapshot in help.
