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

`install` registers four Claude Code hooks. The WebSearch hook (`hooks.webSearch`, default `auto`) checks Tenjin before a `WebSearch` (and, with the push experiment on, before a `WebFetch`). The dispatch hook (`hooks.agentDispatch`, default `auto`, disjoint from `hooks.webSearch`) asks the same question when a subagent is dispatched, sending at most 100 characters of the dispatch's description plus at most 400 characters of its prompt, at most 10 lookups per session; set it to `remind` or `off` to keep subagent prompts on the machine while the WebSearch hook stays on. **It only names a piece on a strong hit** (the marketplace's own verdict, see [Push](#push-experimental)); weaker matches are recorded to the push ledger and not shown, because a subagent prompt is a work order rather than a question and keyword overlap with a listing means much less there. No `inherit`: both default `auto` and can be set independently. `hooks.searchMode` (shipped in `alpha.14`) still reads as `hooks.webSearch` for one release so an existing `off`/`remind` opt-out carries to both hooks; `hooks.dispatchMode` (including `inherit`) never shipped to npm and is kept only for unreleased `main` testers. The Stop hook (`hooks.stopNag`) reminds you at the end of a turn about searches that are still open. The SessionStart hook (`hooks.sessionPrimer`) prints one paragraph on when to search first, and makes no network call.

`tenjin push on` registers six more settings entries, across four scripts, described in [Push (experimental)](#push-experimental) below. Every `tenjin install` WRITES all four of those script files, whether or not push has ever been on — they read `hooks.push` at the top of their own run and exit in milliseconds when it is not `on` — but a machine that has never run `tenjin push on` has no entry pointing at them, so nothing invokes them and the hooks registered stay at these four.

**The Stop hook only ever raises a MISS.** A search that returned candidates is not an open loop, so nothing is reminded about it: a silent end-of-turn after a successful search is the hook working, not the hook broken. It also stays silent once a loop is closed (by `tenjin publish --search-id` or `tenjin outcome`), once a MISS ages past the session window, and after it has raised a given search once. `hooks.stopNag deliberate-only` drops the batch about web-search-hook misses and keeps the reminders about searches you ran yourself. Dispatch misses are never raised at all: they are demand data, not questions you asked to be reminded about. The store keeps every row and evicts nothing, so no amount of fan-out or sidecar activity can push a search you may still want to buy from out of reach.

Hooks are read once at session start, so restart Claude Code after registering them.

### `tenjin uninstall`

Removes what `tenjin install` wrote: Tenjin skills, hook scripts, Tenjin hook entries, Tenjin permission rules, and older pointer lines in `CLAUDE.md` or `AGENTS.md`.

Your wallet, config (including `publish.mode`), library and hook state store under `~/.tenjin` stay in place. The store (`~/.tenjin/state.db`, with its `-wal`/`-shm` sidecars) is kept for the same reason the others are: it holds the error→fix pairings this machine worked out for itself, your outcome history, and the open search loops `outcome --last` and the Stop reminder are raised from — your own record, not something `install` created. A later `install` picks it up exactly as it was. The one thing removed there is the generated hook scripts in `~/.tenjin/hooks`, which `install` wrote and puts back. It is safe to run twice.

The push arms count as hook scripts here: `uninstall` removes `tenjin-push-prompt.mjs`, `tenjin-push-failure.mjs`, `tenjin-push-subagent.mjs`, `tenjin-push-context.mjs` and all of their settings entries whatever `hooks.push` says, since `tenjin push off` deliberately leaves them on disk.

### `tenjin doctor`

Checks the local environment, API reachability, API contracts, skill wiring, session state, wallet state, and balance. With `hooks.push` on it also checks both halves of the push sidecar's wiring — the four scripts on disk and the six settings entries registered — as a warn-only check that can never fail the run. Human output includes `fix:` lines where useful; `--json` includes the permission recommendation under `permissions`.

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

| Flag                       | Effect                                                                   |
| -------------------------- | ------------------------------------------------------------------------ |
| `--search-id <uuid>`       | Link the piece to the search it answers. Repeatable, up to 10 per piece. |
| `--draft`                  | Save privately instead of publishing.                                    |
| `--price <usd>`            | Set the post price.                                                      |
| `--excerpt <text>`         | Public preview.                                                          |
| `--mode <mode>`            | `review`, `auto`, or `full-auto` for this run.                           |
| `--yes`                    | Clear warning findings and the review confirmation.                      |
| `--question <text>`        | Question this piece answers. Repeatable.                                 |
| `--task <text>`            | Task this piece supports. Repeatable.                                    |
| `--scope <text>`           | What the piece covers.                                                   |
| `--exclusions <text>`      | What it does not cover.                                                  |
| `--applies-to <key=v1,v2>` | Applicability metadata. Repeatable.                                      |
| `--as-of <time>`           | When evidence was gathered.                                              |
| `--valid-until <time>`     | When the answer expires.                                                 |
| `--artifact-type <type>`   | `document`, `skill`, or `dataset`.                                       |
| `--temporal-mode <mode>`   | `snapshot`, `maintained`, or `evergreen`.                                |
| `--provenance <text>`      | How evidence was obtained.                                               |
| `--methodology <text>`     | How it was established.                                                  |

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

| Key                         | Default                    | Effect                                                                                                                                          |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAutoSpend`              | `0`                        | Auto-approve a read up to this amount.                                                                                                          |
| `sessionBudget`             | `0`                        | Session auto-spend ceiling; `0` means no ceiling once auto-spend is enabled.                                                                    |
| `confirm`                   | `always`                   | When to ask before paying.                                                                                                                      |
| `sendMaxAmount`             | unset                      | Hard per-send cap. Unset means `send` refuses.                                                                                                  |
| `allowlistCreators`         | empty                      | Restrict auto-pay by creator handle.                                                                                                            |
| `baseUrl`                   | `https://tenjin.blog`      | Tenjin API base URL: what `publish`/`read`/`search` talk to. See [Team shelf](#team-shelf).                                                     |
| `publicShelfUrl`            | `https://tenjin.blog`      | The public marketplace, consume-only: the second shelf a team-mode search falls through to.                                                     |
| `shelfBypassSecret`         | unset                      | The team shelf's protection-bypass secret; setting it turns team mode on. Printed as `set`/`unset`, never echoed.                               |
| `rpcUrl`                    | `https://mainnet.base.org` | Base RPC endpoint.                                                                                                                              |
| `evalCohort`                | `false`                    | Opt into 90-day query retention for retrieval evaluation.                                                                                       |
| `publish.mode`              | `review`                   | Publish consent mode.                                                                                                                           |
| `publish.defaultPrice`      | `0.10`                     | Price used when none is given.                                                                                                                  |
| `publish.ackServerWarnings` | `mode`                     | Whether a yes covers the marketplace scan's warn findings: `mode`, `on`, `off`. See [safety-model.md](./safety-model.md#publishing-boundaries). |
| `hooks.webSearch`           | `auto`                     | WebSearch hook behavior: `auto`, `remind`, `off`.                                                                                               |
| `hooks.agentDispatch`       | `auto`                     | Subagent-dispatch hook (most sensitive payload): `auto`, `remind`, `off` (disjoint).                                                            |
| `hooks.stopNag`             | `on`                       | End-of-turn reminder: `on`, `deliberate-only` (no web-search batch), `off`.                                                                     |
| `hooks.sessionPrimer`       | `on`                       | Session-start search-first primer: `on`, `off`.                                                                                                 |
| `hooks.push`                | `off`                      | Push experiment master switch: `on`, `off`. Set through `tenjin push on/off`, not `config set`, so the wiring step runs alongside it.           |
| `hooks.capture`             | `off`                      | End-of-session publish prompt: `block`, `nudge`, `off`. See [Stop-hook capture](#stop-hook-capture).                                            |

## Push (experimental)

The push experiment flips Tenjin from a tool the agent calls into a sidecar that watches beside it: a published finding surfaces next to a failing command, a stuck edit loop, or a subagent's first turn, without anyone asking for it. It is off by default and costs nothing until turned on.

### `tenjin push on`

Sets `hooks.push` to `on` and immediately wires the four push hook scripts (six settings entries, across five events) into Claude Code's settings (the same idempotent writer `tenjin install` uses, so re-running it is always safe). Two runs do not get that far: with `hooks.webSearch off` the command refuses and leaves `hooks.push` as it was (that key is the wiring switch for every hook this CLI writes), and on a machine whose recorded install harness is set and does not include Claude Code it persists `hooks.push: on` but wires nothing, since these arms are Claude Code hooks — `tenjin install --harness claude` then `tenjin push on` wires them.

| Script                     | Event(s)                                   | Matcher                           | What it does                                                                                                               |
| -------------------------- | ------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `tenjin-push-prompt.mjs`   | `UserPromptSubmit`                         | —                                 | Looks the prompt up before the turn starts.                                                                                |
| `tenjin-push-failure.mjs`  | `PostToolUse`, `PostToolUseFailure`        | `Bash`                            | On a failing build/test/migrate/install/lint command, looks up the error signature and attaches a known finding beside it. |
| `tenjin-push-subagent.mjs` | `SubagentStart`                            | —                                 | Hands a subagent the finding the dispatch hook cached for it seconds earlier, at its first turn.                           |
| `tenjin-push-context.mjs`  | `PostToolUse` (read), `PreToolUse` (churn) | `Read` / `Edit\|Write\|MultiEdit` | Notices packages a file imports, and a stuck edit loop (the same file edited repeatedly).                                  |

A hit is `strong` when the marketplace says so: the top candidate is `corroborated` (both of its retrieval legs agreed on the piece) and its `confidence` is not `low`. Anything else is `none`, is recorded to the ledger as `weak`, and falls through from the team shelf to the public one. Nothing is scored on the machine — the shelf has the embeddings, the full body and both retrieval legs, while a hook has a title and an excerpt. On a strong, free hit the prompt, failure, research and subagent arms attach the finding's full body as context (a paid piece is offered as a pointer instead); the context arm is log-only in this phase, recording what it would have said so its precision earns out before it is allowed to speak. No arm can block or change a tool call: the WebSearch/WebFetch hook injects the finding beside the search and lets the search run. Every decision, spoken or not, is written to the state store (`~/.tenjin/state.db`) that `tenjin push status` summarizes.

Every hook lookup carries its arm name as `trigger`, so the marketplace's per-trigger stats can tell a prompt lookup from a churn one. The failure, read and churn arms additionally send the package they are about as an `appliesTo: {"packages": ["<name>"]}` filter rather than pasting the name in front of the query. That filter is HARD — a piece whose card claims no packages cannot come back to an arm that sent one — and it carries exactly one name, because the marketplace ANDs every value it is given.

**The failure arm fires on error markers, behind allowlisted commands.** Claude Code's Bash result carries no exit code, so a failure is inferred from the output. Two gates, both before any lookup: the command's head (any segment of a `&&`/`;`/`|` chain, after `sudo`, `timeout`, `npx`, `pnpm exec` and `FOO=bar` prefixes) must be a build, test, migration, install or lint tool (`pnpm`, `npm`, `cargo`, `make`, `tsc`, `vitest`, `pytest`, `eslint`, `drizzle-kit`, `docker`, `git`, `rustc`, `gcc`, `clang`, …; `npm ls`/`view`/`audit`-style subcommands excluded), so `which`, `grep`, `test`, `diff`, `ls` and `git diff --exit-code` — which exit 1 to say "no" — never fire it; and the output tail must carry a real marker (`FAIL`, `AssertionError`, `N failed`, a line starting `Error:`/`TypeError:`/`error:`, a Python traceback, `exit code N`, `ENOENT`-class codes, `npm ERR!`, `error TS1234:`, cargo's `error[E0…]`, `panic:`, `fatal:`), not a prose word like "error", "failed" or "not found". Stderr chatter with no marker is success.

**Lookup budgets are per trigger, over a rolling hour.** Each arm gets its own allowance of lookups in any 60-minute window — `prompt`, `failure`, `research` and `subagent` 8 each, `read` and `churn` 4 each — counted machine-wide across every session on the machine, as one indexed query against the state store. So a busy arm can only ever spend its own: a prompt flood cannot leave the failure arm silent, and the buckets are the reserve rather than slices of a shared pool. The window rolls, so an always-on session recovers on the clock with nothing to restart; a fire whose bucket is full is skipped before any request is made and recorded as `lookup-cap` with its trigger, which is what `tenjin push status` breaks the reasons down by, and every capped fire is one row, so how many fires the cap swallowed stays countable. The once-per-session bounds are unchanged: at most 5 full-form injections per session, and the same finding is never injected twice in one session.

### `tenjin push off`

Sets `hooks.push` to `off` and returns immediately. Nothing is unwired: every push script reads this key at the top of its own run and exits in milliseconds when it is not `on`, so the change takes effect on the very next hook invocation with no re-install. One registration outlives it until the next `tenjin install`: `push on` widens the WebSearch hook's matcher to `WebSearch|WebFetch`, and while that stays, a `WebFetch` spawns a hook that reads the key and exits without a word. The next `tenjin install` narrows it back on its own.

To take the scripts and their settings entries away entirely, run `tenjin uninstall`.

### `tenjin push status [--json]`

Reports the push mode, the capture mode (`hooks.capture` — see [Stop-hook capture](#stop-hook-capture) for what it prompts), and BOTH halves of "wired": whether the four scripts are present on disk, and how many of the six settings entries are actually registered (`present/planned`, with the settings file named). Either half alone reports a healthy sidecar that does nothing — scripts with no entries never run, entries with no scripts fail silently — so `push: on` is flagged as not fully wired unless both agree.

Then a tally of the last 7 days of decision rows: total rows, how many distinct findings they touched, the total tokens injected, and the breakdowns by trigger x action, by shelf (`public`, `team`, or `local` for a replayed error→fix pairing this machine recorded itself), and by `reason` (why a fire said nothing: `miss`, `weak`, `already-injected`, `lookup-cap`, `quiet`, `no-answer`, `no-time` — the first leg spent the shared deadline — and `watchdog`), sorted by count. The counts are complete for the window: the rows are indexed, so nothing is a floor.

Under that, what `tenjin push grade` has made of the rows that were actually shown, one line per arm and split by shelf: `used`, `rejected`, `unobserved`, `ungraded` (shown but not yet judged) and `posted` (verdicts that reached the shelf). Skipped fires are not counted here — nothing was shown, so there is no verdict anybody owes.

Last, one `GET /api/lookups/stats?days=7` per configured shelf — the base URL always, plus the public marketplace when you are in team mode — rendered as `server <shelf> (7d):` with `lookups`, `hits`, `candidates`, `used`, `wrong` and `useRate` per trigger. That is the same window from the shelf's side, summed across every caller it serves, rather than this machine alone. A shelf that cannot be reached prints `server <shelf>: unavailable` and the local counts are still shown: a shelf that is down and a shelf with no demand are different facts.

### `tenjin push grade [--since 7d] [--session <id>] [--explain] [--label <uid> <status>]`

Decides whether the agent actually used what the arms showed it, and tells the shelf that served each finding. The arms record what they injected and the shelf records what it served; neither can see what happened next, so without this the push experiment has no measure of its own precision.

It reads the session transcript under `~/.claude/projects` (found by session id, so no working-directory guessing), locates the `hook_additional_context` row that carried the injection, and looks at what the agent did after it. **Only tool inputs count.** Prose agreeing with an injection is what an injection makes likely whether or not it helped; a tool call is a decision the agent spent something on. Replayed compaction summaries are skipped, since they carry calls made before the injection existed.

Four verdicts:

- **`used`** — an explicit `tenjin read <id>` / `tenjin inspect <id>`, or the injected URL, in any later tool input. Following the pointer counts whenever it happens, so a piece bought twenty tool calls later is still a piece the injection sold. Reported to the shelf as `used`.
- **`used`, weakly** — a backtick span of at least two words from the injected text appearing verbatim in a tool input within the next 10 tool calls. One word is what the agent was going to type anyway, and a copied phrase says something was taken from the piece rather than that the piece answered the question, so this is reported as `partially_used`.
- **`rejected`** — nothing matched _and_ the session is over (`sessions.ended_at`, or a transcript nothing has appended to for 30 minutes). A session still running is left open instead: grading it now would post a verdict its next tool call could contradict, and the shelf keeps the first verdict per lookup and post.
- **`unobserved`** — the finding was never in front of the agent. Every subagent injection, which reaches no transcript at all; and a session whose transcript is genuinely absent — the projects directory was read and holds no file for it — once one would have appeared by now (the session has ended, or the row is older than the 30-minute idle window). A projects directory that could not be read at all is not this: `unobserved` is a verdict and a verdict is never re-graded, so a run under a home directory it cannot read leaves every row alone and says why under `--explain`, rather than closing them all as never-seen.

Verdicts go to the shelf that served the row, which is the origin of the read URL the agent was shown — not whatever the machine is configured for today. A search id is minted by one shelf and means nothing on another, and the outcomes endpoint answers 202 either way (there is no existence oracle, by design), so routing by today's config would silently lose the verdict of any row injected before a base URL moved or team mode was switched. The bypass header rides the row's shelf label, not today's config: a `team` row carries the secret and a `public` row never does, so a team shelf that has moved is still reached with its own key. The origin that key is authorized at is the base URL the arm actually asked, recorded with the search — never the read URL the shelf answered with, which is the shelf's own text and must not be handed the key that opens the private shelf. A row with no usable URL is skipped and stays owed, and a `local` replayed pairing has no shelf to tell. Nothing is ever posted twice — the posted stamp is what the queue is drawn from — and a post that fails leaves the row owed, so the next run retries it. Re-running after a session ends re-grades nothing that already has a verdict.

`--explain` prints, per row, the transcript line the injection landed on and the evidence behind the verdict (the matched command or span, or the next three tool inputs when nothing matched) — the first thing to look at when a verdict reads wrong. `--label <uid> <status>` sets one verdict by hand (`used` or `rejected`, recorded as a hand verdict) and posts it, for a row the transcript cannot answer for. Only a row an arm actually injected can be labelled: an outcome is a report about a piece the agent was shown, and an arm's decision _not_ to show one was shown to nobody.

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
- **Search asks two shelves.** `tenjin search`, the dispatch hook, and every push hook query `baseUrl` first (labelled `team`), and only when that returns nothing do they query `publicShelfUrl` (labelled `public`). The two legs share one lookup deadline, so a two-shelf lookup costs no more wall clock than a one-shelf one and a hook's latency does not change with team mode. A team shelf that errors rather than missing is treated as a miss: the search falls through and the failure is reported alongside the result, rather than taking down the command. The human output labels each block by shelf, team first; `--json` carries the answering shelf's response verbatim plus a `shelves` array naming both legs and their searchIds. The state store's `shelf` field records which one a row came from (`team`, `public`, or `local` for a pairing this machine replayed out of its own record).
- **A close goes to the shelf that answered.** Each search entry records the base URL of the leg that minted its searchId, so `tenjin outcome` posts to that shelf — a public-shelf id to the public marketplace, carrying no bypass key, even while `baseUrl` is the team shelf. The two shelves have separate databases, so the alternative is a report about a search the receiving shelf never ran. A `tenjin publish --search-id` naming the other shelf's search does not claim it: the id is dropped from the publish body (the server stores it set-once, so a foreign id would misfile permanently), the loop stays open, and stderr names the shelf to close it on. An entry with no recorded shelf, and every public-mode run, routes to the configured base as before.
- **`read`, `inspect` and `buy` accept candidates from either origin**, since a search surfaced both. A `buy` signs its SIWX header for the shelf the URL is actually on, never for whichever origin happens to be configured.
- **The installed skills say the team's rules, not the marketplace's.** `tenjin install` renders `tenjin-search` and `tenjin-publish` from the same packaged source either way, but the sections whose guidance DIFFERS are replaced rather than annotated: in team mode the search gate says a project-specific question is worth asking (the shelf holds quirks of this codebase, probe results and past decisions), and the publish criteria say teammate-useful, free by default, with the warn tier down to the credential checks. A public-mode install's skills are byte-for-byte what they always were. Nobody reads guidance for the mode they are not in, and no skill states one rule and then an exception to it. The mode is read from the stored `baseUrl` and `shelfBypassSecret`, never from a `--base-url` on the run, because the file outlives the command that wrote it. Changing either key makes the wired copies stale, which `tenjin doctor` reports and the next ordinary command silently fixes — no re-install needed. The hosted `tenjin` skill is not shaped: it is the mirror of `tenjin.blog/skills.md` for agents with no CLI, and so no config to have a mode in.
- **`publish` goes to `baseUrl` only,** never to `publicShelfUrl`, and the price defaults to `0` instead of `publish.defaultPrice` (an explicit `--price` or a frontmatter `price` still wins). One gate changes: **the scan's WARN tier is skipped, except for the four credential checks `secret-assignment`, `hex32-value`, `high-entropy-string` and `env-dump-block` and the injection check `embedded-instruction`.** Those warnings ask "is this safe to make public" — a repo slug, an internal hostname, an employer's name — and a team shelf is not public, so on a team shelf every one of them fires on exactly the findings the shelf exists to hold. **Exactly six things survive the skip, and not one of them is asking about publicness:** the whole hard BLOCK tier, the four warn-tier credential checks `secret-assignment` (a secret-named assignment such as `DEPLOY_API_KEY="pk_live_…"`, whose shape no block detector matches), `hex32-value` (a `0x` + 64-hex value in hash context — the same detector as the blocking `raw-private-key`, demoted to a warn only because a block is permanently non-bypassable and a receipt or basescan tx hash must not be hard-blocked, so warn there means surfaced-for-review, not safe), `high-entropy-string` (the catch-all behind the named shapes, which fires only where no named detector did, so `SEGMENT_WRITE_KEY=<base62>` or `Authorization: Basic <base64>` is a live key nothing else in the scan recognizes) and `env-dump-block` (three or more consecutive `KEY=VALUE` lines carrying a substantial literal: a pasted `.env` file, which is what the Stop hook's transcript and tool-output capture produces), and the warn-tier injection check `embedded-instruction` (an "ignore all previous instructions" imperative or a `BEGIN SYSTEM PROMPT` header). That last one asks a third question, not the credential one: injection risk does not shrink with the audience, because the body is fed to a model either way, and team-shelf bodies are precisely the ones the push sidecar injects into teammates' agents unasked. Every other warn check is dropped. The survivor set is data rather than a list in code: the `teamSurvives` flag on the rule in `src/lib/scan-rules.json`, so the next credential detector joins the survivors by marking itself instead of by a second edit somebody has to remember. **The hard secret block still applies, on every shelf and in every mode, and no `--yes` clears it**: a team shelf is a hosted database with logs and a shared door key, so a live credential published there is still a live credential loose. The five warn-tier survivors are kept as warns rather than promoted, so the cascade governs them as it does on the marketplace: `review` and `auto` confirm on them, `full-auto` and `--yes` clear them unseen. The consent cascade is otherwise unchanged — `review` still asks once per note; `auto` is promptless on every team note that carries no secret-named assignment, no 64-hex value, no unrecognized high-entropy token, no pasted `.env` block and no embedded instruction. Clearing `shelfBypassSecret` puts the rest of the warn tier back.

Public mode — no `shelfBypassSecret` — is unchanged in every one of those respects.

### Stop-hook capture

When enabled (`hooks.capture`), the Stop hook checks whether the session had a research signal — a search the session itself asked for (`tenjin search`, the WebSearch hook, the dispatch hook), or a row in the state store where an arm actually surfaced something. The sidecar's own log-only telemetry does not count, so a session that only read and edited code is never asked.

Once per session it ends the turn (`block`) or adds a line (`nudge`) asking the agent to publish what it settled, naming the resolved `publish.mode` so the agent knows whether it may run the command without asking. The bar differs by mode: in public mode it is the marketplace's (public, durable, rights-clean); in team mode it is "anything a teammate on this project would want to know" — a quirk of this codebase, a probe result, a version-specific gotcha, a workaround, a decision and why.

The ask **waits until no subagent launched from this session is still running** — a turn paused on background work has not yet learned the thing the ask is about, and the marker below would spend the one ask on that pause. Running subagents are read from the tail of the session transcript (the last 4 MB); a launch older than that is not seen, a background launch with no completion notice for 45 minutes is read as finished (a crashed subagent delays the ask rather than cancelling it), and the check fails toward asking on any transcript it cannot read.

The ask fires **once per session and no more**, whatever the agent does with it: a `capture_asked` record for the session is written to the state store before the ask, so the next Stop is silent. Publishing and simply stopping again are both valid answers, and there is no command to run to say "nothing to save".

While capture is on it **replaces** the open-loop MISS reminder rather than joining it: both arms end a turn by saying "publish what you learned", and one turn end does not need three of them. This is a deliberate trade, not a side effect: the ask fires at most once per session while the reminder fired every turn, so a MISS left open early in a session goes unmentioned for the rest of it, and the reminder stays suppressed on turns where the ask itself had nothing to say. `tenjin config set hooks.capture off` restores the reminder.
