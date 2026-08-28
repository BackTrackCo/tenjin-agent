# Command reference

The README keeps the first-run path short. This page carries the command details that are useful once you are wiring Tenjin into scripts, agent permissions, or a longer-running harness.

Every command accepts the global flags:

| Flag               | Effect                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `--json`           | Emit one machine-readable JSON envelope and suppress human stderr rendering. |
| `--base-url <url>` | Point this run at another Tenjin deployment.                                 |
| `--timeout <ms>`   | Per-request timeout. Defaults to `10000`.                                    |

## Setup

### `tenjin install`

Detects Claude Code, Codex, or a shared Agent Skills directory; wires Tenjin skills, whose text is shaped by whether this machine is in [team mode](#team-shelf); can add the free command permissions; can register search hooks; can create a local Base wallet; then runs `doctor`.

Useful flags:

| Flag                    | Values                        | Effect                                                                                                                           |
| ----------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--harness <name>`      | `claude`, `codex`, `shared`   | Target one harness. Repeatable.                                                                                                  |
| `--dry-run`             |                               | Print what would change without writing, including the permission rules a real run would add.                                    |
| `--publish-mode <mode>` | `review`, `auto`, `full-auto` | Set publish consent non-interactively. Defaults to `auto`, which also writes `Bash(tenjin publish:*)` and `Bash(tenjin edit:*)`. |
| `--no-allow-free-verbs` |                               | Do not write harness permission rules.                                                                                           |
| `--search-hooks <mode>` | `auto`, `remind`, `off`       | Register search hooks in this mode.                                                                                              |
| `--no-hooks`            |                               | Register no hooks this run.                                                                                                      |
| `--no-wallet`           |                               | Create no wallet.                                                                                                                |
| `--refresh`             |                               | Re-materialize what this machine already has, at this build. Never prompts, never creates a wallet, never writes config.         |

`install` is idempotent. Re-run it after upgrading the CLI or changing harnesses.

**`--refresh`** is the narrow, non-interactive half, and it is what [`tenjin update`](#tenjin-update) runs for you after a successful upgrade. It re-renders the wired skills, rewrites the generated hook scripts that are already on disk, and updates the settings.json hook entries this CLI already owns. It adds nothing: a skill that is not wired stays unwired, a hook script that is absent stays absent, an event with no entry of ours gets none, no permission rule is written at all, and the update nudge does not run, so its cache file is not created either. Rules a newer version would grant are reported and left for an explicit `tenjin install`, because widening an agent's allowlist during an unattended upgrade is not a refresh. It refuses `--dry-run`, which this mode dispatches above and so could not honour. On a machine where nothing was ever installed there is nothing to converge, and it says so and **exits non-zero** rather than reporting a refresh that did not happen; a refusal to write (a link where the hooks directory belongs, a settings file that is unreadable or changed underneath) exits the same way.

### Hooks

`install` registers four Claude Code hooks. The WebSearch hook (`hooks.webSearch`, default `auto`) checks Tenjin before a `WebSearch` (and, with the push experiment on, before a `WebFetch`). The dispatch hook (`hooks.agentDispatch`, default `auto`, disjoint from `hooks.webSearch`) asks the same question when a subagent is dispatched, sending at most 100 characters of the dispatch's description plus at most 400 characters of its prompt, best-effort scrubbed of absolute paths, hostnames, email addresses, long hex ids and secret-shaped tokens exactly as the WebSearch hook scrubs its own query (the scrub runs over the prompt's first 1600 characters, cut back to a whole token, and only then is the result truncated to 400, so a secret cut at a boundary cannot ship as a fragment; the scrub is a backstop and not a licence to put a secret in a subagent prompt), at most 10 lookups per session; set it to `remind` or `off` to keep subagent prompts on the machine while the WebSearch hook stays on. **It only names a piece on a strong hit** (the marketplace's own verdict, see [Push](#push-experimental)); weaker matches are recorded to the push ledger and not shown, because a subagent prompt is a work order rather than a question and keyword overlap with a listing means much less there. No `inherit`: both default `auto` and can be set independently. `hooks.searchMode` (shipped in `alpha.14`) still reads as `hooks.webSearch` for one release so an existing `off`/`remind` opt-out carries to both hooks; `hooks.dispatchMode` (including `inherit`) never shipped to npm and is kept only for unreleased `main` testers. The Stop hook (`hooks.stopNag`) reminds you at the end of a turn about searches that are still open. The SessionStart hook (`hooks.sessionPrimer`) prints one paragraph on when to search first; its only network call is made while the push experiment is on, one keyless `GET /api/lookups/stats?days=7` to the configured shelf whose per-trigger counts the push arms' [adaptive cooldown](#push-experimental) reads, and a fetch that fails costs the session nothing but that.

`tenjin push on` registers seven more settings entries, across four scripts, described in [Push (experimental)](#push-experimental) below. Every `tenjin install` WRITES all four of those script files, whether or not push has ever been on — they read `hooks.push` at the top of their own run and exit in milliseconds when it is not `on` — but a machine that has never run `tenjin push on` has no entry pointing at them, so nothing invokes them and the hooks registered stay at these four.

**The Stop hook only ever raises a MISS.** A search that returned candidates is not an open loop, so nothing is reminded about it: a silent end-of-turn after a successful search is the hook working, not the hook broken. It also stays silent once a loop is closed (by `tenjin publish --search-id` or `tenjin outcome`), once a MISS ages past the session window, and after it has raised a given search once. `hooks.stopNag deliberate-only` drops the batch about web-search-hook misses and keeps the reminders about searches you ran yourself. Dispatch misses are never raised at all: they are demand data, not questions you asked to be reminded about. The store keeps every row and evicts nothing, so no amount of fan-out or sidecar activity can push a search you may still want to buy from out of reach.

Hooks are read once at session start, so restart Claude Code after registering them.

### `tenjin uninstall`

Removes what `tenjin install` wrote: Tenjin skills, hook scripts, Tenjin hook entries, Tenjin permission rules, and older pointer lines in `CLAUDE.md` or `AGENTS.md`.

Your wallet, config (including `publish.mode`), library and hook state store under `~/.tenjin` stay in place. The store (`~/.tenjin/state.db`, with its `-wal`/`-shm` sidecars) is kept for the same reason the others are: it holds the error→fix pairings this machine worked out for itself, your outcome history, and the open search loops `outcome --last` and the Stop reminder are raised from — your own record, not something `install` created. A later `install` picks it up exactly as it was. The one thing removed there is the generated hook scripts in `~/.tenjin/hooks`, which `install` wrote and puts back. It is safe to run twice.

The push arms count as hook scripts here: `uninstall` removes `tenjin-push-prompt.mjs`, `tenjin-push-failure.mjs`, `tenjin-push-subagent.mjs`, `tenjin-push-context.mjs` and all of their settings entries whatever `hooks.push` says, since `tenjin push off` deliberately leaves them on disk.

### `tenjin doctor`

Checks the local environment, API reachability, API contracts, skill wiring, session state, wallet state, and balance. With `hooks.push` on it also checks both halves of the push sidecar's wiring — the four scripts on disk and the seven settings entries registered — as a warn-only check that can never fail the run. Human output includes `fix:` lines where useful; `--json` includes the permission recommendation under `permissions`.

### `tenjin update`

Installs the newest version npm offers this build, pinned to the exact version the registry names.

| Flag      | Effect                                                    |
| --------- | --------------------------------------------------------- |
| `--check` | Report whether a newer version exists without installing. |

The manager that owns the install performs it: npm, pnpm, and bun are each driven with their own global-add command. What cannot be driven is refused with the instruction that is correct there, rather than writing a global you never had: a source checkout updates by git, an npx run has nothing installed to replace, a project-local copy updates where it is declared, and yarn is refused because `yarn global add` exists only in yarn 1. `--check` answers from all of them.

**The swap is not the whole upgrade.** The wired skills and the generated hook scripts are copies of a particular version, so after a successful swap `update` runs [`tenjin install --refresh`](#tenjin-install) on the newly installed binary and reports what it did. It runs it **once per profile whose hooks this machine has registered**, with `TENJIN_DATA_DIR` set to each, so a machine installed under a redirected data dir gets the scripts the harness actually fires brought up to date rather than only the profile that typed `update`. Those paths are read out of a settings file this CLI does not own, so a profile whose data dir is not already a directory is reported rather than created, and the list is capped. A refresh that fails, times out, or reports nothing to converge is a warning; it never fails the update, because the swap already happened. Each unrefreshed profile is warned about on its own line, carrying the reason the refresh itself gave and the command that repairs THAT profile, which for a non-default data dir is `TENJIN_DATA_DIR=<dir> tenjin install`. Profiles that did converge are reported alongside them.

Deliberately not in the recommended permission allowlist: it replaces the binary your agent then runs. See [agent-permissions.md](./agent-permissions.md).

### The update check

Once a day, at most, the CLI asks npm whether a newer version exists. It never installs on its own; it reports, and you or your agent decide.

| Surface                                | Who sees it                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| One dim stderr line                    | A human at a TTY.                                                                  |
| `updateAvailable` on the JSON envelope | Anything reading the envelope, including an agent. Carries `current` and `latest`. |
| A line on hook output                  | A harness reading `additionalContext`.                                             |

```jsonc
{
  "schemaVersion": 1,
  "command": "search",
  "ok": true,
  "data": {},
  "updateAvailable": { "current": "0.1.0-alpha.6", "latest": "0.1.0-alpha.7" },
}
```

An agent that sees the field can run `tenjin update` itself, at a moment it chooses. That is deliberate: this CLI starts a fresh process per invocation, so there is no deferred-activation window to hide a binary swap in. "Next start" is "mid-session" for whatever is driving it.

`update.mode` controls the reporting:

| Mode    | Behavior                                         |
| ------- | ------------------------------------------------ |
| `nudge` | Default. All three surfaces above.               |
| `off`   | None of them; the CLI stops asking npm entirely. |

```bash
tenjin config set update.mode off
```

The field is read from the check's cache, never fetched while your command runs, so it costs no request and no delay.

## Search and read

### `tenjin search "<question>"`

Searches public reusable knowledge. The question should be generalized public text, not private project detail.

| Flag                        | Values       | Effect                                         |
| --------------------------- | ------------ | ---------------------------------------------- |
| `--max-price <usd>`         | decimal USD  | Only return candidates at or below this price. |
| `--fresh-within <duration>` | `P<n>[DWMY]` | Freshness window, such as `P30D`.              |
| `--limit <n>`               | `1` to `10`  | Maximum items.                                 |
| `--applies-to <key=v1,v2>`  | repeatable   | Applicability filter.                          |

An honest miss exits 0. Use `tenjin outcome` later so the marketplace learns whether a search helped.

Every search names the arm that fired it: this command (and the MCP `search` tool over it) sends `trigger: cli`, and each hook arm sends its own name (`research`, `dispatch`, `prompt`, `read`, `churn`), which is what the shelf's per-trigger use rates (`GET /api/lookups/stats`) are grouped by. It never changes the result of the search, and a shelf that predates the field records `cli`; the rates it feeds are what the push arms' [adaptive cooldown](#push-experimental) reads back.

### `tenjin inspect <url-or-resource-id>`

Shows a candidate card and preview before purchase. It never pays.

### `tenjin read <url-or-resource-id>`

Delivers free, local-library, or already-owned pieces. It refuses with exit 3 rather than paying.

| Flag                       | Effect                                          |
| -------------------------- | ----------------------------------------------- |
| `--print-body`             | Include the full body in machine output.        |
| `--sections <token-count>` | Include leading sections within a token budget. |

### `tenjin buy <url-or-resource-id>`

Re-checks entitlement and price, then pays through x402.

| Flag                       | Effect                                          |
| -------------------------- | ----------------------------------------------- |
| `--max-price <usd>`        | Hard price cap. Never bypassed by `--yes`.      |
| `--yes`                    | Clear the interactive confirmation only.        |
| `--print-body`             | Include the full body in machine output.        |
| `--sections <token-count>` | Include leading sections within a token budget. |

`read` and `buy` are split so a command named `read` never spends money.

### `tenjin session start`

Mints a read-scoped session key so `tenjin read` can recover pieces you already own without reopening the wallet each time. It spends nothing, but it does open the keystore.

| Flag              | Values | Effect                                            |
| ----------------- | ------ | ------------------------------------------------- |
| `--scope <scope>` | `read` | Session scope. This version only supports `read`. |

## Paying any x402 endpoint

### `tenjin pay <url>`

The standard x402 client verb, for ANY paid endpoint rather than marketplace
pieces: one probe, a 2xx delivers free, a 402 pays (exact scheme, USDC on Base
only) under the same spend policy, price cap, and confirm gates as `buy`, and
retries once. When the 402 advertises the standard sign-in-with-x extension, an
entitlement re-check runs first with a signature bound to the TARGET origin, so
something this wallet already bought re-delivers free. There is deliberately no
library and no dedupe: every paid call pays, so always pass `--max-price` (a
hard cap `--yes` cannot bypass). Flags: `-X GET|POST`, `-d '<json-body>'`
(implies POST), `--max-price <usd>`, `--yes`, `--print-body`.

The configured base URL is always payable, and so is the deployment's other
origin (`tenjin.blog` and `tenjin.sh` are one deployment) when the configured
base is itself one of them: both take the tenjin lane, no `bazaarPay` needed. A
self-hosted or preview base gets no such alias and matches only itself. Every
other https origin is the Bazaar lane: it needs the `bazaarPay` config toggle on
AND a configured
registry listing whose terms the live 402 does not exceed (checked against the
local `discover` cache first, then live); a mismatch refuses with
`REGISTRY_MISMATCH` before anything is signed, and unreachable registries fail
the lane closed. While the toggle is on, the optional `tenjin-pay` skill is
installed beside the others; turning it off removes the skill.

### `tenjin discover [query]`

List (no query) or search the configured x402 discovery registries
(`bazaarRegistries`; defaults to CDP's Bazaar, UltraVioleta, and PayAI's
facilitator). Free, keyless, touches no wallet, and works with the toggle off. Listings are
settlement-derived and unvetted; registries that did not answer are reported so
a partial sweep never reads as a complete one. The sweep is stored (24h) as the
pay lane's registry evidence.

## Reporting outcomes

### `tenjin outcome`

Reports how a search ended.

| Flag                    | Values                                                                   | Effect                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--status <status>`     | `used`, `partially_used`, `rejected`, `regenerated`, `purchase_declined` | Required outcome status.                                                                                                                                                                                      |
| `--search-id <uuid>`    |                                                                          | Search to report against. Repeatable; one status covers all of them.                                                                                                                                          |
| `--last`                |                                                                          | Target the most recent manual `tenjin search`.                                                                                                                                                                |
| `--all-open`            |                                                                          | Close this session's open web-search-hook MISSes. `regenerated` only. Deliberate searches, and hook searches Tenjin answered, are left open and counted. Another session's loops are that session's to close. |
| `--resource <uuid>`     |                                                                          | Resource the outcome concerns.                                                                                                                                                                                |
| `--content-hash <hash>` |                                                                          | Hash of the exact body read.                                                                                                                                                                                  |

## Publishing and editing

### `tenjin publish [file]`

Publishes Markdown with optional metadata and a local safety scan. Hard blocks cannot be bypassed.

| Flag                       | Effect                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| `--finding <id>`           | Publish a stored subagent finding as the body instead of a file.          |
| `--dry-run`                | Print what would be published, whole body included, and write nothing.    |
| `--discard`                | With `--finding`: drop it from the local queue, unpublished, for good.    |

| `--agent <id>`             | Record the publish under the harness agent id that ran it. Gates nothing. |
| `--search-id <uuid>`       | Link the piece to the search it answers. Repeatable, up to 10 per piece.       |
| `--draft`                  | Save privately instead of publishing.                                          |
| `--price <usd>`            | Set the post price.                                                            |
| `--excerpt <text>`         | Public preview.                                                                |
| `--mode <mode>`            | `review`, `auto`, or `full-auto` for this run.                                 |
| `--yes`                    | Clear warning findings and the review confirmation.                            |
| `--question <text>`        | Question this piece answers. Repeatable.                                       |
| `--task <text>`            | Task this piece supports. Repeatable.                                          |
| `--scope <text>`           | What the piece covers.                                                         |
| `--exclusions <text>`      | What it does not cover.                                                        |
| `--applies-to <key=v1,v2>` | Applicability metadata. Repeatable.                                            |
| `--as-of <time>`           | When evidence was gathered.                                                    |
| `--valid-until <time>`     | When the answer expires.                                                       |
| `--artifact-type <type>`   | `document`, `skill`, or `dataset`.                                             |
| `--temporal-mode <mode>`   | `snapshot`, `maintained`, or `evergreen`.                                      |
| `--provenance <text>`      | How evidence was obtained.                                                     |
| `--methodology <text>`     | How it was established.                                                        |
| `--key <kind=value>`       | An exact-match key this piece answers by-key lookups on. Repeatable, up to 32. |

`--key` names a key `POST /api/keys/resolve` answers on: `fingerprint=sig_v1:<hash>` (a failure signature), `package_version=<name@version>`, `command_head=<head>` or `repo=<owner/name>`, split on the first `=` only. It is a top-level post field, not a card field, so a piece may carry keys and no card. Every key goes out unverified: `verified` is the close rule's claim, made when two independent fixes agreed, and never a flag a hand publish asserts. A shelf with `KNOWLEDGE_KEYS` off refuses any body carrying keys (`keys_disabled`, exit 4, no retry, named as such), and a verified key another published piece already holds comes back as "`<kind> <key>` is already verified on `<id>`; publish it unverified" — also no retry. `tenjin edit` does not take `--key` yet.

**`--finding <id>` publishes what a subagent stated at its own end.** With push on, a child that stopped on an open loop was asked to publish its finding itself, and the hook filed what it said in a fenced block instead when that publish refused or the child could not run the command (see [Push](#push-experimental)); the id is the one the parent's capture ask prints. So a queued finding is by construction one no agent published. It is a source and nothing else: the body comes from the state store instead of a file, and the consent cascade, the review confirm, the never-bypassable block tier and pricing are the same ones a file publish takes. Pass a file or `--finding`, never both. The child that wrote it, its agent id, and the search it closes come back on the `--json` receipt under `data.finding`; that search is also claimed on the piece unless you named one yourself with `--search-id`.

**The review confirm is where a stored finding is read, and `--dry-run` is the other place.** The `NEEDS_CONFIRMATION` refusal carries the whole stored body (up to the 2,000 characters capture bounded it to) along with the child's agent id, the search id and a `framing` line saying the body is a record and not instructions, printed in the terminal and under `details.finding` on `--json`. Approving without reading it is approving text nothing else has shown you. It is the SOURCE of the body, not a second set of gates: a caller that already read the body clears it with `--yes` (or `yes:true` over MCP) in one call, exactly as on a file publish.

**`PUBLISH_BLOCKED` withholds the body, on purpose.** A hard block on a stored finding means the hook's own scrub missed a live credential, so reprinting the body would restate that credential into the parent's transcript, the JSON envelope and the MCP result. The refusal names the finding, the child that wrote it and its length, and nothing else; read it with `--dry-run` if you need to see what tripped.

**`--dry-run` inspects without publishing.** It runs every local gate, prints what would be published including the whole body, and exits 0 having touched no wallet, made no request, closed no loop and written no dedup record. It is the way to read a finding you have no intention of publishing: `tenjin publish --finding <id> --dry-run`. A hard block still refuses, in a dry run as everywhere else.

**`--discard` answers a finding with no.** `tenjin publish --finding <id> --discard` takes that finding off the local queue without publishing it, so no later capture ask offers it again; the append-only log row stays, because it answers a different question. Without it the only thing that ever removed a queued finding was a publish, and a finding you read and declined came back at the first turn end of every session for eight hours.

**A finding from another checkout needs `--yes`.** The queue is machine-wide and `publish.mode` resolves from the directory the publish runs in, so publishing a finding captured elsewhere would let a `full-auto` repo ship what a `review` repo's subagent settled. Such a publish refuses with `NEEDS_CONFIRMATION` in every mode, `full-auto` included, until you pass `--yes`. `--dry-run` is above that gate: reading it locally is how you decide.

**`--agent <id>` is attribution, never authority.** It records which harness agent ran the publish, keyed on the `agent_id` the hooks already stamp into their own rows, so the session that dispatched a subagent can report at its turn end what that subagent published. It changes nothing else: the same scan, the same consent cascade, the same review confirm, the same price and the same shelf, because consent lives in your configuration and not in which agent typed the command. The SubagentStop capture ask fills the flag in for the child it asks; the value comes back on the `--json` receipt under `data.publishedBy`, and an id outside letters, digits and `_ . : -` is refused rather than silently dropped. It is not exposed on the MCP `publish` tool, which has no id of its own to pass.

On the `--json` envelope, every named search reports under `data.searches`, one entry per id. `data.search` repeats that entry when exactly one id was named and is absent otherwise, so a caller reading only `data.search` sees nothing after a two-id publish: read `data.searches`.

**The same body is published once per machine.** Before any request, `publish` hashes the body (line endings and trailing whitespace normalized away, so a re-render of the same finding hashes the same) and looks for a `published:<hash>` record in the state store (`~/.tenjin/state.db`). On a hit it exits 0 without touching the wallet or the network, printing `Already published: <url>`; `--json` returns `{"alreadyPublished": true, "url": "..."}`. The record is never aged out. This exists because the Stop-hook capture ask is guarded once per _session_, which dedups nothing when two agents watching related sessions both write up the same finding. `--draft` is exempt in both directions: a draft parks privately, writes no record, and is never deduped against one. The record is written when the body actually goes public, whether by a non-draft `publish` or by promoting the draft with `tenjin edit <post-id> --status published`. It is a same-machine guard, not a guarantee across machines.

The named searches are accepted or refused as one batch: Tenjin matches every id against a search it actually recorded, and one it cannot match refuses the whole publish. That refusal arrives after your wallet has signed, so any id this machine has no record of is named on stderr before anything is signed. It stays a warning rather than a refusal, because a search recorded on another machine is missing here and valid there.

### `tenjin edit <post-id>`

With no change flag, prints one of your posts and its card. With change flags, merge-updates the post.

It accepts the card flags from `publish`, plus:

| Flag                    | Effect                                               |
| ----------------------- | ---------------------------------------------------- |
| `--title <text>`        | New post title.                                      |
| `--body <path>`         | Replace the body from a Markdown file.               |
| `--status <status>`     | `draft` to unpublish, `published` to put a draft up. |
| `--add-question <text>` | Append one question. Repeatable.                     |
| `--add-task <text>`     | Append one task. Repeatable.                         |
| `--clear <field>`       | Empty one card field. Repeatable.                    |

`--status draft` is the reversible way to take a piece off the marketplace: the id
and the body survive, and `--status published` puts it back. It is an ordinary
change flag, so it diffs like the rest (setting the status a post already has
writes nothing) and it runs the same `publish.mode` consent gate. A promotion to
`published` is the draft actually going public, so it settles what the draft
publish deferred: the stored body is re-scanned at the block tier (a draft made
on the web desk was never scanned locally), any searches named by the
`publish --draft --search-id` that created the draft are claimed on the same PUT
and their local loops closed, and the same-body dedup marker is written.

That re-scan can refuse the promotion with `PUBLISH_BLOCKED`, which `--yes` never
clears. On the `--json` envelope, each claimed search reports under
`data.searches` as `{id, closed, relinked?}`, the same entry shape `publish`
uses minus `prefill`; the field is absent when the promotion claimed nothing.

### `tenjin delete <post-id>`

Removes one of your own pieces (soft-delete, owner-scoped `DELETE /api/posts/<id>`). It reads the post first, prints the title, status, price and url, and then **confirms on every run in every `publish.mode`**: the mode is consent to publish and never consent to destroy, so `full-auto` asks here exactly as `review` does.

At a terminal it asks `y/N` inline. Anywhere else, including under an agent, a pipe, or the MCP server, it refuses with `NEEDS_CONFIRMATION` (exit 3) whose `details` carry the post identity, `confirmCommand`, and `reversibleAlternative`; re-run with `--yes` to confirm. A declined prompt is `REFUSED` (exit 3), and a server refusal after the confirmation is `DELETE_FAILED` (exit 4), which means the piece is still live.

| Flag    | Effect                                                                 |
| ------- | ---------------------------------------------------------------------- |
| `--yes` | Confirm the removal without the prompt. Required when there is no TTY. |

Prefer `tenjin edit <post-id> --status draft` when the piece should come down but not be lost. Every successful `publish` prints both commands with the real id, and carries them on the `--json` envelope as `data.undo` (`remove`, plus `unpublish` on a published piece). `data.undo.remove` carries no `--yes`, deliberately: it is the command that STARTS the undo, so each surface's own confirmation still runs. The `--yes` form appears only in a refusal payload's `confirmCommand`, which answers a question the user has already been shown.

### `tenjin profile`

Prints the publisher profile behind this wallet: handle, display name, bio, default price. `profile: null` (and a pointer at `profile set`) for a wallet that has never published or claimed a handle. Owner-scoped, so it signs with your wallet on first use and mints a read-scoped 24h session.

### `tenjin profile set`

Claims or renames your handle and sets what bylines and the desk show. Omitted flags keep their stored value; an empty value is a usage error, not a clear. No consent gate: this is an operator-invoked account edit, not content. Mints a `read+write` session on first use.

| Flag                    | Effect                                        |
| ----------------------- | --------------------------------------------- |
| `--handle <handle>`     | Word-handle, 2–32 chars of `a-z`, `0-9`, `-`. |
| `--display-name <name>` | Display name (≤100 chars).                    |
| `--bio <text>`          | Short bio (≤280 chars).                       |

A taken, reserved, or cooling-down handle comes back as the server's own message with exit 4.

### `tenjin stats`

This month's (UTC) earnings, full reads, and glances across your pieces. `--json` carries `earningsThisMonth` in atomic USDC and `earningsThisMonthUsd` formatted. Per-sale detail lives on the desk URL every publish receipt returns.

## Wallet and funding

### `tenjin wallet create`

Creates a local Base wallet. The key is stored encrypted under `~/.tenjin/wallet.json`; the passphrase comes from `TENJIN_WALLET_PASSPHRASE`, the OS credential store, or an interactive prompt.

| Flag        | Effect                                                    |
| ----------- | --------------------------------------------------------- |
| `--replace` | Archive the existing wallet first, then create a new one. |

### `tenjin wallet show`

Prints the wallet address and key source. It never prints the private key.

### `tenjin wallet balance`

Reads the USDC balance on Base.

### `tenjin wallet fund [amountUsd]`

Opens or prints a Coinbase Onramp checkout for this wallet. The payment itself happens in Coinbase.

| Flag        | Effect                                             |
| ----------- | -------------------------------------------------- |
| `--no-open` | Print the checkout link without opening a browser. |
| `--no-wait` | Return once the link is issued instead of polling. |

### `tenjin send <amount> usdc <to>`

Escape hatch for moving USDC out of the agent wallet. It is deliberately not part of the recommended agent flow.

| Flag    | Effect                                                               |
| ------- | -------------------------------------------------------------------- |
| `--yes` | Skip the interactive confirm. The configured send cap still applies. |

## Configuration

`tenjin config` lists every key with its effective value and source. `tenjin config get <key>` reads one key. `tenjin config set <key> <value>` writes one key.

`set publish.mode` also keeps the harness allowlist in step, since the mode decides whether a publish asks and the allowlist decides whether the harness asks anyway. Moving to `auto` or `full-auto` asks once and writes `Bash(tenjin publish:*)` and `Bash(tenjin edit:*)` on yes; without a terminal, under `--json`, or on a no it writes nothing and prints where the rule goes. Moving back to `review` retracts them without asking. See [agent-permissions.md](./agent-permissions.md).

Common keys:

| Key                         | Default                    | Effect                                                                                                                                                  |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAutoSpend`              | `0`                        | Auto-approve a read up to this amount.                                                                                                                  |
| `sessionBudget`             | `0`                        | Session auto-spend ceiling; `0` means no ceiling once auto-spend is enabled.                                                                            |
| `confirm`                   | `always`                   | When to ask before paying.                                                                                                                              |
| `sendMaxAmount`             | unset                      | Hard per-send cap. Unset means `send` refuses.                                                                                                          |
| `allowlistCreators`         | empty                      | Restrict auto-pay by creator handle.                                                                                                                    |
| `baseUrl`                   | `https://tenjin.blog`      | Tenjin API base URL: what `publish`/`read`/`search` talk to. See [Team shelf](#team-shelf).                                                             |
| `publicShelfUrl`            | `https://tenjin.blog`      | The public marketplace, consume-only: the second shelf a team-mode search falls through to.                                                             |
| `shelfBypassSecret`         | unset                      | The team shelf's protection-bypass secret; setting it turns team mode on. Printed as `set`/`unset`, never echoed.                                       |
| `rpcUrl`                    | `https://mainnet.base.org` | Base RPC endpoint.                                                                                                                                      |
| `evalCohort`                | `false`                    | Opt into 90-day query retention for retrieval evaluation.                                                                                               |
| `publish.mode`              | `review`                   | Publish consent mode.                                                                                                                                   |
| `publish.defaultPrice`      | `0.10`                     | Price used when none is given.                                                                                                                          |
| `publish.ackServerWarnings` | `mode`                     | Whether a yes covers the marketplace scan's warn findings: `mode`, `on`, `off`. See [safety-model.md](./safety-model.md#publishing-boundaries).         |
| `hooks.webSearch`           | `auto`                     | WebSearch hook behavior: `auto`, `remind`, `off`.                                                                                                       |
| `hooks.agentDispatch`       | `auto`                     | Subagent-dispatch hook (most sensitive payload): `auto`, `remind`, `off` (disjoint).                                                                    |
| `hooks.stopNag`             | `on`                       | End-of-turn reminder: `on`, `deliberate-only` (no web-search batch), `off`.                                                                             |
| `hooks.sessionPrimer`       | `on`                       | Session-start search-first primer: `on`, `off`.                                                                                                         |
| `hooks.push`                | `off`                      | Push experiment master switch: `on`, `off`. Set through `tenjin push on/off`, not `config set`, so the wiring step runs alongside it.                   |
| `hooks.capture`             | `off`                      | Publish prompt at a turn end: `block` (you and your subagents), `nudge` (you only, never blocking), `off`. See [Stop-hook capture](#stop-hook-capture). |

## Push (experimental)

The push experiment flips Tenjin from a tool the agent calls into a sidecar that watches beside it: a published finding surfaces next to a failing command, a stuck edit loop, or a subagent's first turn, without anyone asking for it. It is off by default and costs nothing until turned on.

### `tenjin push on`

Sets `hooks.push` to `on` and immediately wires the four push hook scripts (seven settings entries, across six events) into Claude Code's settings (the same idempotent writer `tenjin install` uses, so re-running it is always safe). Two runs do not get that far: with `hooks.webSearch off` the command refuses and leaves `hooks.push` as it was (that key is the wiring switch for every hook this CLI writes), and on a machine whose recorded install harness is set and does not include Claude Code it persists `hooks.push: on` but wires nothing, since these arms are Claude Code hooks — `tenjin install --harness claude` then `tenjin push on` wires them.

| Script                     | Event(s)                                   | Matcher                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenjin-push-prompt.mjs`   | `UserPromptSubmit`                         | —                                 | Looks the prompt up before the turn starts.                                                                                                                                                                                                                                                                                                                                                                       |
| `tenjin-push-failure.mjs`  | `PostToolUse`, `PostToolUseFailure`        | `Bash`                            | On a failing build/test/migrate/install/lint command, replays the fix this machine already recorded for that error signature (a local pairing), or, in team mode, asks the team shelf by fingerprint (`POST /api/keys/resolve`, two hashes on the wire) for a fix a teammate's machine recorded. The error text is never searched and never leaves the machine. A later pass on the same head closes the pairing. |
| `tenjin-push-subagent.mjs` | `SubagentStart`, `SubagentStop`            | —                                 | Hands a subagent the finding the dispatch hook parked for it seconds earlier, at its first turn, one handoff slot per dispatch; at that subagent's end, records its stop and, on an open loop, asks it once for the finding it settled. Every fire that opens the store leaves one heartbeat event row naming why it ended (`no-cache`, `invalid-shape`, `expired`, `weak`, `already-injected`, `delivered`), which is the denominator for the delivery rate. Nothing reads those rows yet: `tenjin push status` summarizes decisions, not events, so until the reporting arm lands they are a hand-SQL question against `~/.tenjin/state.db`. |
| `tenjin-push-context.mjs`  | `PostToolUse` (read), `PreToolUse` (churn) | `Read` / `Edit\|Write\|MultiEdit` | Notices packages a file imports, and a stuck edit loop (the same file edited repeatedly).                                                                                                                                                                                                                                                                                                                         |


A hit is `strong` when the marketplace says so: the top candidate is `corroborated` (both of its retrieval legs agreed on the piece) and its `confidence` is not `low`. Anything else is `none`, is recorded to the ledger as `weak`, and falls through from the team shelf to the public one. Nothing is scored on the machine — the shelf has the embeddings, the full body and both retrieval legs, while a hook has a title and an excerpt. On a strong, free hit the prompt and research arms attach the finding's full body as context (a paid piece is offered as a pointer instead); the subagent arm hands a pointer only, stamped with a delivery marker that also lands in its event row, and a strong free dispatch hit is relayed to that arm rather than injected into the parent, which still reads one line naming the piece and its resource id (a strong paid hit stays with the parent, the only context with buy authority); the failure arm attaches only this machine's own error→fix pairing, never a searched piece, and the context arm is log-only in this phase, recording what it would have said so its precision earns out before it is allowed to speak. No arm can block or change a tool call: the WebSearch/WebFetch hook injects the finding beside the search and lets the search run. Two entries can hold a turn end open instead, each once per session and both behind `hooks.capture`: the Stop hook under `hooks.capture block`, and the subagent arm's finding ask, which returns to the child that is stopping. Every decision, spoken or not, is written to the state store (`~/.tenjin/state.db`) that `tenjin push status` summarizes.

Every hook lookup carries its arm name as `trigger`, so the marketplace's per-trigger stats can tell a prompt lookup from a churn one; a `tenjin search` and the MCP tool over it send `cli`. The read and churn arms additionally send the package they are about as an `appliesTo: {"packages": ["<name>"]}` filter rather than pasting the name in front of the query. That filter is HARD — a piece whose card claims no packages cannot come back to an arm that sent one — and it carries exactly one name, because the marketplace ANDs every value it is given.

**The subagent arm owns both ends of a child, and the stop half is the only place a child's own finding can be caught.** Every `SubagentStop` fire records one row naming the child (its agent id and type) and why the fire ended, whether or not anything else happens. Then, only under `hooks.capture block` (the Stop hook's ask is the only thing that ever reads the queue, so with capture off the ask would buy a child turn for a row nothing surfaces; and a `SubagentStop` hook has no non-blocking channel to the child it is talking to, so asking a child IS blocking it, which is not what `nudge` means. `block` asks you and your subagents, `nudge` asks only you and blocks nobody, `off` asks nobody), only when that child stops on an open loop this session is still carrying (a dispatch lookup that missed within the hour, or a failing command this session's failure arm handled in it), only ONCE PER SESSION however many children stop on that same signal, only on that child's first stop, and only for the one process that wins the atomic claims, the arm ends that child's turn once and asks it to state its durable finding in a fenced ```tenjin-finding block. **What it asks for is a publish, and the fenced block is the fallback.** The child is asked to write its finding to a file and run `tenjin publish <file> --agent <its id> --search-id <the loop that earned the ask>`, or call the `tenjin_publish` MCP tool with that file if it has no shell, while it still holds the evidence behind it — the probe trail, the failed attempts, the exact versions and error text, none of which survive into a summary its parent would relay. That is the SAME publish anyone runs: the same local scan, the same refusals, the same `publish.mode` consent, reaching whatever shelf your configuration names, the public marketplace included. There is no child-specific branch and no capability detection, because consent lives in your configuration and not in which agent runs the command. If the command refuses, or the child cannot run it at all, the ask tells it to state the finding in the fenced block instead; the child continues one turn, the next stop carries its answer, and the hook itself parses the block out of it, bounds it to 2,000 characters, scrubs THAT (in that order: `scrub` is a chain of backtracking regexes and this is the one place it meets text an untrusted child chose), and files it on the local queue for the parent, stamped with the project the child ran in. The opening and closing fences each have to be a line of their own, so a finding may carry a code block and a child that merely mentions the marker does not harvest its own decline.

**Which of the two happens falls out of your own `publish.mode`, not out of a policy in the hook.** Under `review` the confirm needs a TTY, which a child running the CLI through a tool call does not have, so its publish fails closed with `needs_confirmation` exactly as any piped publish does and the fenced block catches it — publishing stays with the parent, which is the context where the human you asked for actually is. Under `auto` the child publishes, and the piece keeps the evidence only the child held. Each mode gets the behaviour its own choice implies. A child publishing from a sidechain nobody reads is answered by visibility rather than by a policy fork: the publish is recorded under that child's agent id, and the parent's own capture ask reports it (see [Stop-hook capture](#stop-hook-capture)). Every field this reads (`agent_id`, `stop_hook_active`, `last_assistant_message`, `agent_transcript_path`) is undocumented harness surface probed on 2026-08-27, so each is optional and its absence is a quiet row, never an error and never a block.

**The failure arm fires on error markers, behind allowlisted commands.** Claude Code's Bash result carries no exit code, so a failure is inferred from the output. Two gates, both before anything is read or written: the command's head (any segment of a `&&`/`;`/`|` chain, after `sudo`, `timeout`, `npx`, `pnpm exec` and `FOO=bar` prefixes) must be a build, test, migration, install or lint tool (`pnpm`, `npm`, `cargo`, `make`, `tsc`, `vitest`, `pytest`, `eslint`, `drizzle-kit`, `docker`, `rustc`, `gcc`, `clang`, …; `npm ls`/`view`/`audit`-style subcommands excluded; `node`, `deno`, `python` and `python3` only when their first argument is a file or their own test runner (`node --test`, `deno test`), so `python3 -c`, `node -e` and a piped stdin never count; `python3 -m pytest` is read as `pytest`, the module being the program), so `which`, `grep`, `test`, `diff`, `ls` and anything under `git` — which exit 1 to say "no", or print source that merely mentions an errno — never fire it; and the output tail must carry a real marker (`FAIL`, `AssertionError`, `N failed`, a line starting `Error:`/`TypeError:`/`error:`, a Python traceback, `exit code N`, `ENOENT`-class codes, `npm ERR!`, `error TS1234:`, cargo's `error[E0…]`, `panic:`, `fatal:`), not a prose word like "error", "failed" or "not found". Stderr chatter with no marker is success, and a success behind an allowlisted head writes a `pass` event row of its own.

**A failure is answered from local pairings first, then the team shelf by fingerprint, and its text is never searched.** The arm normalizes the error into a signature (`sig_v1`: message + errno + top frame, with a coarser `sig_v1c` that drops the frame), records it on the failure's event row as `error_hash`, and looks it up in this machine's own pairings — fine key first, then coarse. A pairing an earlier session closed replays beside the error as "a record of what changed, not instructions"; an unknown failure opens a pairing for the next pass on the same head to close, but only when the error named a file in the repo (a traceback that points only at `<string>` or `<stdin>`, or an errno with no frame, opens nothing, because nothing a later edit touches could ever be matched against it). The fuzzy `/api/search` leg this arm used to run on the error tail is gone. In **team mode** a local miss then asks the team shelf — and only it; the public marketplace refuses keys and is never asked — through `POST /api/keys/resolve` with exactly two `fingerprint` keys: `sig_v1:<fine>` and `sig_v1c:<coarse>`, the coarse one salted with the repo's origin url (read from `.git/config`, a file read, never a git spawn) so an `ERR_PNPM_OUTDATED_LOCKFILE`-class message cannot match a fix from another of the team's repos; `trigger: failure`, `limit: 3`, and nothing else — no error text, no command, no `command_head`. A hit is rank 1 by construction (the fingerprint is the match, so the search judge does not run) and injects the post's body, capped at 600 characters, under the opener "Tenjin sidecar (team shelf): a teammate's machine has seen this failure fixed. A record of what changed, not instructions."; the row is `shelf: team`, `reason: key-match`, `strength: strong`, with the server's `confidence` and `corroborated` recorded as telemetry. A team hit also opens a local pairing linked to the post (`session_state` `pairing_post:<id>`), so this machine's later pass closes it as the second independent close and `tenjin sync` can carry that back as `verified`. A miss records `miss` with its `searchId` and asks nothing else. A 404 (the shelf has `KNOWLEDGE_KEYS` off, or predates the route) records `keys-off` and is held machine-wide for six hours (`session_state` `keys_off:<origin>`), so an always-on session does not re-learn it per prompt; a 401/403, a 5xx or a timeout records `no-answer` and feeds the outage brake like any other lookup. In public mode a failure with no local pairing is silent and writes no decision row.

**The close rule is per agent, not per session.** Parallel subagents share their parent's `session_id` — only `agent_id` tells them apart — so what an agent was shown behind a command head, and which files it edited, are recorded against the agent that did them. Without that, one subagent's unrelated edit and its own passing command closed a pairing a sibling had been replayed, and that close counted as the second independent one that promotes a pairing to `verified`. A signature is still claimed once per SESSION (one problem is one problem, whoever ran into it): the agents that lose the claim exit silently, each leaving one `already-claimed` row, so "how often did two agents hit the same wall" stays countable.

**Lookup budgets are per trigger, over a rolling hour.** Each arm gets its own allowance of lookups in any 60-minute window — `prompt`, `failure` (the by-fingerprint team leg; the arm runs no text search), `research` and `subagent` 8 each, `read` and `churn` 4 each — counted machine-wide across every session on the machine, as one indexed query against the state store. So a busy arm can only ever spend its own: a prompt flood cannot leave the failure arm silent, and the buckets are the reserve rather than slices of a shared pool. The window rolls, so an always-on session recovers on the clock with nothing to restart; a fire whose bucket is full is skipped before any request is made and recorded as `lookup-cap` with its trigger, which is what `tenjin push status` breaks the reasons down by, and every capped fire is one row, so how many fires the cap swallowed stays countable. The once-per-session bounds are unchanged: at most 5 full-form injections per session, and the same finding is never injected twice in one session.

**The cap adapts to evidence, per trigger, and is inert until there is any.** At session start the primer fetches the configured shelf's per-trigger use rates over the last week (`GET /api/lookups/stats?days=7`, keyless) into the session's state (`trigger_rates`: lookups, hits, used, wrong per trigger — counts only), and every cap check reads them. For a trigger, `rate` is `used / (used + wrong)`, the two verdicts an outcome report posts against a lookup (`used`, `rejected`; the grading in tenjin-agent#210): a rate of `0.4` or more doubles that arm's cap for the session; twenty or more hits with a rate under `0.05` cuts it to a third (`8` → `2`, `4` → `1`), and under that cut every 10th fire the cut suppressed goes through anyway (counted per session and trigger in `cooldown:<trigger>`), so a cold arm keeps producing the rows that could warm it back up — a fire the base cap would also have stopped never passes. **A trigger whose row has no graded outcome (`used + wrong` is zero) keeps its base cap whatever its hit count**: without that guard a shelf nothing has graded yet reads as cold for every arm at once. A fetch that fails, a shelf that predates the endpoint, a trigger with no row, or a count that is not one (negative, or the `Infinity`/`NaN` a JSON number can still spell) all leave the cap exactly what the table above says.

### `tenjin push off`

Sets `hooks.push` to `off` and returns immediately. Nothing is unwired: every push script reads this key at the top of its own run and exits in milliseconds when it is not `on`, so the change takes effect on the very next hook invocation with no re-install. One registration outlives it until the next `tenjin install`: `push on` widens the WebSearch hook's matcher to `WebSearch|WebFetch`, and while that stays, a `WebFetch` spawns a hook that reads the key and exits without a word. The next `tenjin install` narrows it back on its own.

To take the scripts and their settings entries away entirely, run `tenjin uninstall`.

### `tenjin push status [--sessions] [--json]`

Reports the push mode, the capture mode (`hooks.capture` — see [Stop-hook capture](#stop-hook-capture) for what it prompts), and BOTH halves of "wired": whether the four scripts are present on disk, and how many of the seven settings entries are actually registered (`present/planned`, with the settings file named). Either half alone reports a healthy sidecar that does nothing — scripts with no entries never run, entries with no scripts fail silently — so `push: on` is flagged as not fully wired unless both agree.

Then a tally of the last 7 days of decision rows: total rows, how many distinct findings they touched, how many denied a tool call outright, the total tokens injected (the `injected` rows alone: a dispatch relay's own line carries its token count on its `relayed` row but is not summed here), and the breakdowns by trigger x action, by shelf (`public`, `team`, or `local` for a replayed error→fix pairing this machine recorded itself), and by `reason` (why a fire said nothing: `miss`, `weak`, `already-injected`, `already-relayed` — this session already handed the same piece to a subagent and that handoff has not expired, so neither a second dispatch nor a parent-facing arm re-announces it — `already-claimed` — a second agent in the session hit the same failure signature, and the first one to claim it does the work — `lookup-cap`, `quiet`, `no-answer`, `no-time` — the first leg spent the shared deadline — `watchdog`, `keys-off` — the team shelf answered the failure arm's `POST /api/keys/resolve` with a 404, because `KNOWLEDGE_KEYS` is off there or the deployment predates the route — and `key-match`, which is not a skip but the reason on a failure-arm row that injected a teammate's fix by fingerprint), sorted by count. The counts are complete for the window: the rows are indexed, so nothing is a floor.

Then one line for the mechanical lane, always printed: the error→fix pairings opened in the same window, how many a later pass closed, how many two independent passes verified, the scope the closed ones landed in (`code` may travel to the team shelf, `user` never leaves the machine, `ambiguous` is counted for the day-14 revisit of the close rule), and the command heads that opened them — zero opened after a week of failing builds means the allowlist is too tight, and one head dominating means it is too loose. Behind these numbers the store also keeps one `events` row per hook fire — `prompt` for every prompt (including the short or slash ones nothing is asked about, marked `skipped`), `edit` per Edit/Write with the file's basename, `failure` with the signature as `error_hash`, `pass` when an allowlisted head succeeds — which is what the `--sessions` report is computed over. Every one of those rows carries the firing agent in the `events.agent_id` column (`NULL` for the main session), because the sequence the score is built on is fail → edit → pass BY ONE AGENT and a session id is shared by every subagent under it. It is the same column, filled by the same reader, that `injections.agent_id` gets — one identity, parsed once, so the finding a child was relayed and the work that child then did are joinable. The `--sessions` report below reads that column: it scores one line per session **and agent**, never a session whole.

Under that, what `tenjin push grade` has made of the rows that were actually shown, one line per arm and split by shelf: `used`, `rejected`, `unobserved`, `ungraded` (shown but not yet judged) and `posted` (verdicts that reached the shelf). Skipped fires are not counted here — nothing was shown, so there is no verdict anybody owes.

Last of the always-printed blocks, one `GET /api/lookups/stats?days=7` per configured shelf — the base URL always, plus the public marketplace when you are in team mode — rendered as `server <shelf> (7d):` with `lookups`, `hits`, `candidates`, `used`, `wrong` and `useRate` per trigger. That is the same window from the shelf's side, summed across every caller it serves, rather than this machine alone. A shelf that cannot be reached prints `server <shelf>: unavailable` and the local counts are still shown: a shelf that is down and a shelf with no demand are different facts.

`--sessions` appends the importance-score report: **one line per session and agent** with an event row in the same window, highest score first, each showing the agent (`''` is the lead's own turn, a named one is a subagent of the session beside it), the score, the number of event rows, whether the Stop hook's capture ask fired (`capture_asked` — a per-session fact, so it is reported on the parent's line only), how many `published:<hash>` or `agent_published:<...>` markers were stamped while the session was open (machine-wide markers attributed by time, so a concurrent session's publish counts here too, and every agent line of one session shows the same count), and the patterns that fired. **A session is not a worker.** Parallel subagents share their parent's `session_id` and are told apart only by `events.agent_id`, so scoring a session whole stitched one agent's failure to a sibling's edit and a third's pass and called the result a fix; each agent's rows are now scanned alone, and a pattern never spans two of them. The two inputs not split yet are `pairing_closes` and `searches`: both now carry an `agent_id` stamped by the same reader as the rest, but the report still reads them per session, so `error-edit-resolved` and `research-then-edit` can still be completed by a sibling's close or search until it partitions on them. The score is five patterns, each counted once per agent — a failure followed by an edit and then a pass or a pairing close (`error-edit-resolved`, 3.0); the same non-markdown file edited before and after a prompt (`edit-across-prompt`, 2.5); a `Write` over a file with at least three earlier edits (`write-over-edited`, 2.5); a failure, an edit of a non-test file, then a pass behind the head the failing command named (`fail-edit-pass`, 2.0); a research hit or a search followed by an edit with no failure between (`research-then-edit`, 2.0) — multiplied by up to `1.3` when the last resolution or reversal was within 300 seconds of the session's end (shown as `x1.30 recency`). It is a report and nothing reads it: the capture gate is unchanged, and the week's question is whether the score would have skipped the asks that published nothing without skipping a session that published. On `--json` it is `data.sessions`, absent without the flag.

### `tenjin push grade [--since 7d] [--session <id>] [--explain] [--label <uid> <status>]`

Decides whether the agent actually used what the arms showed it, and tells the shelf that served each finding. The arms record what they injected and the shelf records what it served; neither can see what happened next, so without this the push experiment has no measure of its own precision.

It reads the session transcript under `~/.claude/projects` (found by session id, so no working-directory guessing), locates the `hook_additional_context` row that carried the injection, and looks at what the agent did after it. A row an arm wrote inside a subagent carries that agent's id and is graded against the child's own transcript (`<session>/subagents/agent-<id>.jsonl`), never the parent's, which holds none of the child's tool calls. **Only tool inputs count.** Prose agreeing with an injection is what an injection makes likely whether or not it helped; a tool call is a decision the agent spent something on. Replayed compaction summaries are skipped, since they carry calls made before the injection existed.

Four verdicts:

A finding relayed to a subagent is the one kind with no anchor row anywhere — the arm hands it to the child as its opening context and no transcript records it — so it is judged from the child's first tool call onward, by the same rules. It also leaves no injected text on disk, so the only spans it can be matched on are the ones in the piece's title, which usually means none: a relayed finding is judged on the strong evidence or not at all.

- **`used`** — an explicit `tenjin read <id>` / `tenjin inspect <id>`, or the injected URL, in any later tool input. Following the pointer counts whenever it happens, so a piece bought twenty tool calls later is still a piece the injection sold. Reported to the shelf as `used`.
- **`used`, weakly** — a backtick span of at least two words from the injected text appearing verbatim in a tool input within the next 10 tool calls. One word is what the agent was going to type anyway, and a copied phrase says something was taken from the piece rather than that the piece answered the question, so this is reported as `partially_used`.
- **`rejected`** — nothing matched _and_ the session is over (`sessions.ended_at`, or a transcript nothing has appended to for 30 minutes). A session still running is left open instead: grading it now would post a verdict its next tool call could contradict, and the shelf keeps the first verdict per lookup and post.
- **`unobserved`** — the finding was never in front of the agent. A finding relayed to a subagent whose id was not recorded (rows written before this version, or by an arm that could read none off its input), which names no transcript to open; and a session whose transcript is genuinely absent — the projects directory was read and holds no file for it — once one would have appeared by now (the session has ended, or the row is older than the 30-minute idle window). A projects directory that could not be read at all is not this: `unobserved` is a verdict and a verdict is never re-graded, so a run under a home directory it cannot read leaves every row alone and says why under `--explain`, rather than closing them all as never-seen.

Verdicts go to the shelf that served the row, which is the origin of the read URL the agent was shown — not whatever the machine is configured for today. A search id is minted by one shelf and means nothing on another, and the outcomes endpoint answers 202 either way (there is no existence oracle, by design), so routing by today's config would silently lose the verdict of any row injected before a base URL moved or team mode was switched. The bypass header rides the row's shelf label, not today's config: a `team` row carries the secret and a `public` row never does, so a team shelf that has moved is still reached with its own key. The origin that key is authorized at is the base URL the arm actually asked, recorded with the search — never the read URL the shelf answered with, which is the shelf's own text and must not be handed the key that opens the private shelf. A row with no usable URL is skipped and stays owed, and a `local` replayed pairing has no shelf to tell. Nothing is ever posted twice — the posted stamp is what the queue is drawn from — and a post that fails leaves the row owed, so the next run retries it. Re-running after a session ends re-grades nothing that already has a verdict.

`--explain` prints, per row, the transcript line the injection landed on, the agent id when the row was written inside a subagent, the file that was actually read, and the evidence behind the verdict (the matched command or span, or the next three tool inputs when nothing matched) — the first thing to look at when a verdict reads wrong. `--label <uid> <status>` sets one verdict by hand (`used` or `rejected`, recorded as a hand verdict) and posts it, for a row the transcript cannot answer for. Only a row an arm actually injected can be labelled: an outcome is a report about a piece the agent was shown, and an arm's decision _not_ to show one was shown to nobody.

```bash
tenjin push on
tenjin push status --json
tenjin push grade --explain
tenjin push off
```

## MCP

`tenjin mcp` runs a local stdio MCP server over the same command cores. It exposes search, inspect, buy, outcome, publish, edit, wallet, and fund tools. The wallet stays local, and the same spend and publish gates apply.

## Team shelf

A team shelf is a **second deployment of Tenjin itself** — the same app, its own empty database, its own domain, Deployment Protection on. A team publishes findings to it freely, consumes from it first, and falls through to the public marketplace when it has nothing. There are no extra commands: `publish`, `search`, `read`, `inspect` and `buy` all work as they always did, against a different `baseUrl`.

Two keys decide it:

| Key                 | Default               | Effect                                                                                                             |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`           | `https://tenjin.blog` | Where `publish` writes and where the first search leg goes. In team mode, the team's own deployment.               |
| `publicShelfUrl`    | `https://tenjin.blog` | The public marketplace, consume-only: the second leg a team-mode search falls through to.                          |
| `shelfBypassSecret` | unset                 | The team deployment's Vercel "Protection Bypass for Automation" secret. **Setting it is what turns team mode on.** |

```bash
tenjin config set baseUrl https://backtrack.tenjin.sh
tenjin config set shelfBypassSecret <secret>
```

`config get shelfBypassSecret` and `config` print `set` or `unset`, never the value, in both the human lines and `--json`. The value itself is in `~/.tenjin/config.json`.

**Both settings are required.** Team mode is "a secret **and** a `baseUrl` that is a shelf of the team's own", not a non-empty secret. The two commands above are independent, so a machine can end up with the secret while `baseUrl` is still the marketplace — running them in the other order, or the secret line alone on a second machine. That state stays in **public mode**, with the scan's warn tier and the full confirm cascade on, rather than treating tenjin.blog as a private shelf. `config set` says so when it happens, and `tenjin doctor` carries a `team shelf` check.

The mirror half is `baseUrl` on a shelf of your own with no secret. Doctor warns there too, from the settings alone, before the network says anything. And when a protected deployment answers the probes with its protection page, `api-contract`, `search-contract` and `read-path` say so and point at `shelfBypassSecret` rather than at the base URL, which was the setting that was already right. The signal comes from the response itself: an HTML content-type, a 401 or 403, or a landing on a host other than the one asked for. A 401 or 403 in the API's own JSON envelope is not called a protection page, since that is an honest refusal rather than a wall, but on a shelf of your own it still points at the key, because a missing or stale secret is the likeliest thing being refused. The remedy follows what the probe did. With no secret configured the fix is to set one; when the key WAS sent and still did not get past (a stale or rotated key, or a proxy, WAF or another sign-in layer answering instead) the fix is to update it, never to set the secret this machine already has. A blocked redirect names the key only when its `Location` leaves the host asked for, since a same-host 3xx is what an `http://` base URL or a non-canonical host name gets with a perfectly good key; that one says the URL redirects and to point `baseUrl` at the host it lands on. Naming the key at all needs a key this machine could actually use: the marketplace takes none, and a `--base-url` or `TENJIN_BASE_URL` override pointing anywhere but the configured shelf carries none, so a page arriving from either is reported as a proxy or a sign-in wall with no credential prescribed.

### What changes in team mode

- **The bypass header.** Every request to the **configured** `baseUrl`'s origin carries `x-vercel-protection-bypass`. Nothing else ever does, in three separate ways: the header is attached from the request URL, not from the call site's intent, so a request to `publicShelfUrl` cannot carry it however it is issued; the key is paired with the origin in `config.json`, so a run re-pointed with `--base-url` or `TENJIN_BASE_URL` carries no key at all and runs as an ordinary public-mode run; and a request carrying the key refuses to follow a redirect, so a 3xx on the shelf origin cannot hand it to another host. The generated hook scripts apply the same rules to their own fetches (they have no flag or env layer to be re-pointed through).
- **Search asks two shelves.** `tenjin search`, the dispatch hook, and every push hook that searches (the failure arm searches nothing; it answers from local pairings and then asks the team shelf alone, by fingerprint) query `baseUrl` first (labelled `team`), and only when that returns nothing do they query `publicShelfUrl` (labelled `public`). The two legs share one lookup deadline, so a two-shelf lookup costs no more wall clock than a one-shelf one and a hook's latency does not change with team mode. A team shelf that errors rather than missing is treated as a miss: the search falls through and the failure is reported alongside the result, rather than taking down the command. The human output labels each block by shelf, team first; `--json` carries the answering shelf's response verbatim plus a `shelves` array naming both legs and their searchIds. The state store's `shelf` field records which one a row came from (`team`, `public`, or `local` for a pairing this machine replayed out of its own record).
- **A close goes to the shelf that answered.** Each search entry records the base URL of the leg that minted its searchId, so `tenjin outcome` posts to that shelf — a public-shelf id to the public marketplace, carrying no bypass key, even while `baseUrl` is the team shelf. The two shelves have separate databases, so the alternative is a report about a search the receiving shelf never ran. A `tenjin publish --search-id` naming the other shelf's search does not claim it: the id is dropped from the publish body (the server stores it set-once, so a foreign id would misfile permanently), the loop stays open, and stderr names the shelf to close it on. An entry with no recorded shelf, and every public-mode run, routes to the configured base as before.
- **`read`, `inspect` and `buy` accept candidates from either origin**, since a search surfaced both. A `buy` signs its SIWX header for the shelf the URL is actually on, never for whichever origin happens to be configured.
- **The installed skills say the team's rules, not the marketplace's.** `tenjin install` renders `tenjin-search` and `tenjin-publish` from the same packaged source either way, but the sections whose guidance DIFFERS are replaced rather than annotated: in team mode the search gate says a project-specific question is worth asking (the shelf holds quirks of this codebase, probe results and past decisions), and the publish criteria say teammate-useful, free by default, with the warn tier down to the credential checks. A public-mode install's skills are byte-for-byte what they always were. Nobody reads guidance for the mode they are not in, and no skill states one rule and then an exception to it. The mode is read from the stored `baseUrl` and `shelfBypassSecret`, never from a `--base-url` on the run, because the file outlives the command that wrote it. Changing either key makes the wired copies stale, which `tenjin doctor` reports and the next ordinary command silently fixes — no re-install needed. The hosted `tenjin` skill is not shaped: it is the mirror of `tenjin.blog/skills.md` for agents with no CLI, and so no config to have a mode in.
- **`publish` goes to `baseUrl` only,** never to `publicShelfUrl`, and the price defaults to `0` instead of `publish.defaultPrice` (an explicit `--price` or a frontmatter `price` still wins). One gate changes: **the scan's WARN tier is skipped, except for the four credential checks `secret-assignment`, `hex32-value`, `high-entropy-string` and `env-dump-block` and the injection check `embedded-instruction`.** Those warnings ask "is this safe to make public" — a repo slug, an internal hostname, an employer's name — and a team shelf is not public, so on a team shelf every one of them fires on exactly the findings the shelf exists to hold. **Exactly six things survive the skip, and not one of them is asking about publicness:** the whole hard BLOCK tier, the four warn-tier credential checks `secret-assignment` (a secret-named assignment such as `DEPLOY_API_KEY="pk_live_…"`, whose shape no block detector matches), `hex32-value` (a `0x` + 64-hex value in hash context — the same detector as the blocking `raw-private-key`, demoted to a warn only because a block is permanently non-bypassable and a receipt or basescan tx hash must not be hard-blocked, so warn there means surfaced-for-review, not safe), `high-entropy-string` (the catch-all behind the named shapes, which fires only where no named detector did, so `SEGMENT_WRITE_KEY=<base62>` or `Authorization: Basic <base64>` is a live key nothing else in the scan recognizes) and `env-dump-block` (three or more consecutive `KEY=VALUE` lines carrying a substantial literal: a pasted `.env` file, which is what the Stop hook's transcript and tool-output capture produces), and the warn-tier injection check `embedded-instruction` (an "ignore all previous instructions" imperative or a `BEGIN SYSTEM PROMPT` header). That last one asks a third question, not the credential one: injection risk does not shrink with the audience, because the body is fed to a model either way, and team-shelf bodies are precisely the ones the push sidecar injects into teammates' agents unasked. Every other warn check is dropped. The survivor set is data rather than a list in code: the `teamSurvives` flag on the rule in `src/lib/scan-rules.json`, so the next credential detector joins the survivors by marking itself instead of by a second edit somebody has to remember. **The hard secret block still applies, on every shelf and in every mode, and no `--yes` clears it**: a team shelf is a hosted database with logs and a shared door key, so a live credential published there is still a live credential loose. The five warn-tier survivors are kept as warns rather than promoted, so the cascade governs them as it does on the marketplace: `review` and `auto` confirm on them, `full-auto` and `--yes` clear them unseen. The consent cascade is otherwise unchanged — `review` still asks once per note; `auto` is promptless on every team note that carries no secret-named assignment, no 64-hex value, no unrecognized high-entropy token, no pasted `.env` block and no embedded instruction. Clearing `shelfBypassSecret` puts the rest of the warn tier back.

Public mode — no `shelfBypassSecret` — is unchanged in every one of those respects.

### Automatic sync

When the failure arm records a fix (a build/test/migrate/install/lint failure this machine later made pass by changing a tracked file), that error→fix pairing is local. `tenjin sync` is what carries a **code-scoped** pairing to the team shelf, so the next machine that hits the same failure sees the fix beside its error through the shelf's by-fingerprint lookup — nobody writes a note, and the error text never leaves either machine (only two fingerprint hashes travel).

It runs on its own. **The Stop hook**, after a session ends, checks this project for closed code-scoped pairings the shelf has not seen yet; if there are any, it spawns `tenjin sync` detached and returns — the publish runs outside the hook's budget, in the background, not on the turn. The CLI path it spawns is the one baked in at `tenjin install` (hooks run under the harness's environment, not a shell, so `PATH` is not consulted); if that path is unknown, nothing is spawned. A machine-wide claim (a `session_state` row with a two-minute TTL) means several sessions ending in the same minute run one sync between them, not one each — the concern on a shared 16 GB laptop.

`tenjin sync` is **team mode only** (it hard-refuses in public mode: a synced pairing is reachable only through the team shelf's by-key route, and a public-mode machine has neither the route nor a private shelf to hold it). For each pairing it POSTs to the shelf a keyed, card-less, `price: 0` post titled `Fix: <command head> — <errno or file>`, whose body is the failing command, the fix, the touched files, the verify command and a `pkg:` line, capped at 300 characters. Its keys are the fine fingerprint (`sig_v1:<hash>`), the coarse fingerprint salted with the repo's origin URL (`sig_v1c:<hash>`, so an `ERR_PNPM_OUTDATED_LOCKFILE`-class error does not match across every repo the team has), and the command head (stored for a future ranking, never queried); `verified` mirrors the pairing's local status. A pairing this machine published that became verified after it was first synced is updated to `verified: true` on the shelf. A pairing the failure arm opened beside a **teammate's** post and this machine then closed is the second, independent close: the teammate's post cannot be updated from this wallet (every post route is owner-scoped), so sync publishes this machine's own record of the fix with its keys `verified`. If another teammate's published piece already holds a fingerprint verified, the shelf returns a 400 naming the holder — the pairing is marked synced (never retried) and the holder recorded, rather than fighting for the key. A post of this machine's that is gone from the shelf (a 404 on the update) is likewise marked synced and skipped, so one dead link cannot hold up the rows behind it.

Only **code-scoped** pairings ever sync. A `user`-scoped pairing (an env var, a port, a missing tool, `$HOME`) never leaves the machine, and an `ambiguous` one does not travel either. The scan that gates every publish runs here too, over the title and body, with the warn tier filtered exactly as a team-shelf `publish` filters it (the block tier and the five surviving warn checks): a stray credential in a command line or a filename stays on the machine. There is nobody to `--yes` an automatic run and the body is the same next time, so a row with a finding is marked synced and skipped, like a row the shelf's own ingest gate refused, rather than blocking the rows behind it. The `skipped` count in the result and in the `hook: 'sync'` events row is those rows.

The one case the automatic run cannot recover on its own is signing: a session key that expired while the OS keychain is locked. `tenjin sync` then leaves the unsynced rows as they are, records the coded failure, and the next Stop retries — and the Stop ask prints a one-line fallback telling the operator to run `tenjin sync` by hand in a terminal where the wallet can unlock. That fallback line appears only in that case. Any other abort (an outage, a 5xx, a rate limit) also leaves the remaining rows unsynced and records the error code on the run's events row (as `error`, not `code`, so the fallback line stays quiet: running it by hand is no answer to an outage); the next Stop retries it too.

### Stop-hook capture

When enabled (`hooks.capture`), the Stop hook checks whether the session had a research signal — a search the session itself asked for (`tenjin search`, the WebSearch hook, the dispatch hook), a row in the state store where an arm actually surfaced something, or an **unpublished finding this machine still holds**. The sidecar's own log-only telemetry does not count, so a session that only read and edited code is never asked. The finding half of that check reads the queue a publish deletes, not the append-only log, and it is machine-wide on purpose: a session whose parent `Stop` never ran leaves its child's finding stranded, and only a later session can still publish it, so a dead parent delays a finding rather than erasing it.

Once per session it ends the turn (`block`) or adds a line (`nudge`) asking the agent to publish what it settled, naming the resolved `publish.mode` so the agent knows whether it may run the command without asking. The bar differs by mode: in public mode it is the marketplace's (public, durable, rights-clean); in team mode it is "anything a teammate on this project would want to know" — a quirk of this codebase, a probe result, a version-specific gotcha, a workaround, a decision and why.

The ask also **names every unpublished finding a subagent on this machine queued**. With push on, a subagent that stopped on an open loop was asked to publish its finding itself, and what it said in a fenced block instead was filed on a local queue (see the subagent arm above); the capture ask lists every one of them, each with its id, the child that settled it and the search it answers, because this is the one moment a context with publish authority is already being asked what to write down. Publishing a finding takes it off that queue, so the list is what nothing has published. **It is not limited to this session.** `SubagentStop` fires per child while a parent `Stop` may never fire at all — a crash, an interrupt, a session ended from the UI — so a finding routinely outlives the run that produced it, and a session-scoped list would make it invisible rather than merely late; a finding from an earlier session is named and marked as such, inside the same 8-hour window the open loops use. An id and a one-line preview is what naming a finding costs, so none are left out. The preview is cut and marked `[clipped]` when the body runs past it; the stored body is whole either way, and `tenjin publish --finding <id>` publishes it under the same scan and the same `publish.mode` consent as any other publish, with `--dry-run` printing it whole and publishing nothing, and `--discard` taking it off the queue so no later ask offers it again. A finding harvested in a **different checkout** is marked as such, and publishing one from here needs an explicit `--yes`: `publish.mode` resolves from the directory the publish runs in, and this queue is machine-wide. Each child's words are framed in the ask as a record of what that child settled, not as instructions to the agent reading it.

The ask also **reports what this session's children published themselves**, above the queue, as one line per publish with the child that made it. Every publish is listed, not each child's latest: a child that published something objectionable and then something innocuous must not be reported as having done only the second. Nothing is asked about them; they are already on a shelf. This is what answers the supervision asymmetry a child publish creates: without it a piece reaches the marketplace from a sidechain nobody reads and the context supervising the work never learns it happened. Only children this session actually asked are reported, matched on the agent id the ask handed each one.

The ask **waits until no subagent launched from this session is still running** — a turn paused on background work has not yet learned the thing the ask is about, and the marker below would spend the one ask on that pause. Running subagents are read from the tail of the session transcript (the last 4 MB); a launch older than that is not seen, a background launch with no completion notice for 45 minutes is read as finished (a crashed subagent delays the ask rather than cancelling it), and the check fails toward asking on any transcript it cannot read.

The ask fires **once per session, plus once for anything that arrives after that**: a `capture_asked` record for the session is written to the state store, so the next Stop is silent whatever the agent did with it. Publishing and simply stopping again are both valid answers, and there is no command to run to say "nothing to save". The exception is something the ask could not have named — a subagent launched after it fired, or one whose launch had already fallen out of the transcript tail the running-subagent check reads. That record therefore carries a watermark, and a later Stop re-asks when either half of the report holds something newer than it: a queue row, **or a child publish**, which writes no queue row at all and would otherwise go unreported after the session's first ask. The watermark is taken from what the ask actually NAMED rather than from the clock, so a row committed while the ask was reading is newer than the mark and is named next time instead of being skipped forever. A re-ask names only what is new.

While capture is on it **replaces** the open-loop MISS reminder rather than joining it: both arms end a turn by saying "publish what you learned", and one turn end does not need three of them. This is a deliberate trade, not a side effect: the ask fires at most once per session while the reminder fired every turn, so a MISS left open early in a session goes unmentioned for the rest of it, and the reminder stays suppressed on turns where the ask itself had nothing to say. `tenjin config set hooks.capture off` restores the reminder.
