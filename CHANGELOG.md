# tenjin-cli

## 0.1.0-alpha.16

### Minor Changes

- 720f868: Grade a finding against the transcript it actually landed in, including a
  subagent's own.

  **Every arm now records the subagent it fired inside.** The harness stamps
  `agent_id` on a hook input that fires inside a subagent and leaves it off in the
  main session, while `session_id` stays the parent's either way — so until now a
  row written inside a child pointed only at a parent transcript that holds no
  word of what the child did. `events`, `injections`, `searches` and
  `pairing_closes` all gain an `agent_id` column in one step, and the prompt,
  failure, pass, edit, research, dispatch and subagent arms all stamp it. The
  subagent arm records the child the finding was relayed TO, which is the file the
  verdict has to come out of; the close on a pairing records the worker that made
  it, and counts for nothing — the promotion to `verified` still asks for two
  independent SESSIONS, because two subagents of one conversation are one laptop
  in one checkout.

  **Schema version 2, and tenjin-agent#247 is what it is.** Anything after this
  takes version 3. A fresh file is CREATED at the current shape and steps nothing;
  a file that already exists is altered in place by the first open of either the
  CLI or a hook, keeping every row. The step also BACKFILLS `events.agent_id` from
  the `data.agentId` that tenjin-agent#242 has been writing since 2026-08-28, so
  the fortnight of rows in between are still the worker's rather than the lead's.
  `ALTER TABLE ADD COLUMN` is not idempotent, so the version is re-read inside the
  `BEGIN IMMEDIATE` and the create and migrate branches are exclusive — pinned by
  a dozen hook processes racing one version 1 file, and by a version 1 hook core
  writing to a version 2 file, which is the ordinary state of a machine that
  upgraded the CLI without re-running `tenjin install`.

  **One identity, parsed once.** The prelude has a single reader, `identityOf`,
  answering the session and the agent together; an id that is not `[A-Za-z0-9_-]`
  of 1–128 characters is refused rather than stripped, because it is also a
  transcript filename and stripping a separator out of one id spells another id
  exactly. `NULL` is the main session everywhere and never "unknown", with the one
  place it becomes the `''` a `session_state` key segment needs spelled out as
  `agentKey` — so `edited::<path>`, `edits::<path>` and `replayed::<head>` are
  byte-for-byte the keys the lead's rows already sit under. The importance score
  reads the `events` column instead of a JSON field, which is what makes "this
  child was shown a finding" and "this child then fixed something" the same worker
  rather than two.

  **An id the harness stamps but this build cannot use is not the lead.** It fails
  the bound, so it names no transcript and no partition; filing the fire under the
  main session instead would hand a child's search, edit or close to its parent,
  and the score would then read that work as the lead's. Every arm drops such a
  fire whole — no lookup, no event row, no decision row — rather than inventing a
  reason bucket for a row that should not exist.

  **`tenjin grade` reads that file.** A row with an agent id is judged against
  `<session>/subagents/agent-<id>.jsonl`, never the parent's. A relayed finding has
  no anchor row in any transcript — the child is handed it as its opening context
  and nothing records it — so it is judged from the child's first tool call onward,
  by the same evidence rules everything else gets. It also leaves no injected text
  on disk, so its span evidence comes from the piece's title alone, which usually
  means a relayed finding is judged on the strong evidence (an explicit read, or
  the URL) or not at all.

  **`unobserved` narrows to what it always meant:** nothing to read and nothing
  that ever will be. Every subagent injection used to land there unconditionally,
  which closed the whole handoff as never-seen; now only a relayed row with no
  agent id recorded does — rows written before this version, or by an arm that
  could read none off its input. `--explain` names the agent and the file that
  answered.

- 79b8862: Codex runs the same loop. `tenjin install` on a machine with Codex writes seven `command` entries to `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`), all through the shim, beside the Claude Code set; `doctor` reports them as configured and observed in the ledger; `uninstall` removes only the entries it wrote. The daemon serves `/hook/codex` with an adapter built on payloads captured from codex-cli 0.153.4: root prompt lookups, per-child identity through `agent_id`, multi-file `apply_patch` edits marked in one fire, and the capture ask delivered as a Stop `decision: block`.

  Shared boundary corrections that a second harness forced: the tool an arm reads is canonical (`command`, `paths`, `task`, `query`, `url`) rather than a vendor argument bag; a stored session is namespaced by harness (`claude:<id>`, `codex:<id>`), so `loop.db` state from before this release does not join new sessions; `tenjin search` stamps the thread it ran inside (`CODEX_THREAD_ID`) as `agent_id`, and the capture ask names a CLI miss only to the actor that opened it. A Codex shell result carries no exit status, so its completion stays unknown (an error marker is still a failure) and no pairing closes on it; the spawn tool's task is opaque on the wire, so no dispatch handoff runs for Codex.

- 00b382a: Take a publish back from the CLI. `tenjin delete <postId>` removes one of your own
  pieces through the owner-scoped soft-delete at `DELETE /api/posts/<id>`, and
  `tenjin edit <postId> --status draft|published` is the reversible half: `draft`
  unpublishes without losing the id or the body, `published` puts a draft up. Both
  reuse `edit`'s signing path, and the MCP server exposes them as `tenjin_delete`
  (annotated destructive) and a `status` argument on `tenjin_edit`.

  **`delete` confirms in every mode, and never reads `publish.mode`.** The mode is
  consent to publish, not consent to destroy, so `full-auto` asks here exactly as
  `review` does. At a terminal it asks `y/N` inline; anywhere else, including under
  an agent or the MCP server, it refuses with `NEEDS_CONFIRMATION` (exit 3) carrying
  the title, status, url, the `--yes` command that confirms, and the reversible
  `--status draft` alternative, which is the same exit-3 channel `publish` and `edit`
  already use. `--status` is an ordinary change flag by contrast: it diffs, it prunes
  when it already matches, and it rides the ordinary `publish.mode` gate.

  Every successful `tenjin publish` now prints the exact undo commands with the real
  post id, and carries them on the `--json` envelope as `data.undo`, so an agent
  reporting a publish hands over a real command instead of guessing one. The printed
  removal command carries no `--yes`: it starts the undo, so each surface's own
  confirmation still runs, and `--yes` appears only in a refusal payload's
  `confirmCommand`, which answers a question the user has already been shown.

  A server refusal after the confirmation is the new `DELETE_FAILED` (exit 4), whose
  message says the piece is still live. No refused delete leaves a write credential
  behind: the owner-scoped read that the preview is built from signs with a
  `read`-scoped session, and only an actual approval mints `read+write`, so both a
  headless refusal and a declined prompt end with nothing on disk that a later write
  could reuse. An approved prompt pays one extra in-memory signature for that, with
  no second keystore prompt and no extra round trip. `tenjin delete` is never
  allowlisted: no mode carries it, and it is not delegable to a subagent.

  Promoting a draft settles what the draft publish deferred. `edit --status
published` re-scans the stored body at the block tier (a draft made on the web
  desk was never scanned locally), claims the searches a
  `publish --draft --search-id` parked on the draft (the ids ride the same PUT and
  their local loops close), and writes the same-body dedup marker, so the next
  publish of the promoted body dedups instead of creating a duplicate. The
  server-returned post id is shape-checked as a uuid before it can reach the undo
  line or the delete confirm payload.

- 9656c04: The failure arm fires behind a fixed allowlist of command heads; every search names its arm; `publish --key` (tenjin-agent#212, PR A).

  **The allowlist is fixed.** `git` is no longer a head the arm fires behind: every record it opened had come from `git show … | grep ENOENT` over source that merely mentions an errno. `node`, `deno`, `python` and `python3` count only when their first argument is a file or their own test runner (`node --test`, `deno test`), so `python3 -c`, `node -e` and a piped stdin never do; `python3 -m pytest` and `python -m unittest` are read as `pytest` and `unittest`, the module being the program.

  **`tenjin search` names itself too.** The hook arms already send `trigger` on each `/api/search` body; this release adds the manual half, so `tenjin search` and the MCP `search` tool over it send `cli` explicitly rather than relying on the server's default. The arms that send one are `research`, `dispatch`, `prompt` and `failure`. Telemetry only; a shelf that predates the field records `cli`.

  **`tenjin publish --key <kind=value>`** (repeatable, up to 32; the MCP publish tool's `key`) sends exact-match keys on the post body — `fingerprint`, `package_version`, `command_head`, `repo` — bounded before the wallet signs. Keys go out unverified; `verified` is the shelf's own claim about a key. A shelf with `KNOWLEDGE_KEYS` off refuses a keyed body as `keys_disabled`, and a verified key another published piece holds comes back as "`<kind> <key>` is already verified on `<id>`; publish it unverified"; neither is retried.

- 861a48f: The turn-end ask names the failures this turn HIT, off the ledger row the failure already left.

  **Nothing new is stored.** The deleted `pairings` table is replaced by no table at all: `fires` already carries a failure's question key and its masked error line on every outcome, so the row the arm leaves behind is the whole record. The ask reads it back per actor.

  **The line asserts nothing.** "You fixed `<line>`" was a claim the machine could not make — behind it was a pairing closed by the next passing run of the same command, which is "something passed later", not "you understood it". The line now says only what the row says: this came up, and the shelf had nothing for it. The publish is offered conditioned on the agent's own judgement, with `--key fingerprint=` filled in when the failure has a fingerprint to file under.

  **A failure's question key is composed, not hashed over the line alone.** `sig_v1:<hash>|sig_v1_test:<hash>|line:<hash>`, in that order, and any part may be absent. A key over the error line alone is the same bytes for the identical TypeError in two different files, and the once-per-question gate then serves the second failure the first's cached miss — its fingerprint sitting right there, never resolved. The fingerprints in front of the line hash are what keep them apart.

  **A child's failures go to the child, not to the lead** (principle 5): the actor that hit the wall is the one that can explain it. The lead no longer sees what its children hit.

  **The ask re-arms on a new failure, and only on a new one.** An actor asked at its first stop and then sent into a wall it had to climb out of is asked again, the same way a child's newer finding re-arms the lead. In practice that is the lead's: an already-asked child is on its answer turn and is harvested instead. A failure the last ask already named is not repeated and does not re-arm anything, however many times the same command is re-run — the line says a failure came up this turn, and re-offering its `--key fingerprint=` would ask for a publish the agent may already have made.

- 861a48f: The failure arm gets a second round: when neither fingerprint resolves, it asks the team shelf in WORDS, using the failure's own error line.

  **Two rounds, ordered, never merged.** Round one is `/api/keys/resolve` under `sig_v1` and `sig_v1_test`. Round two runs only when round one answered nothing (the kernel already stops at the first stage that answers) and sends the error line as the runner printed it, masked, to `/api/search`. A key resolves a failure someone already published a key for; the write-up a teammate wrote about the same error in prose carries no fingerprint at all and used to be unreachable from a failing command.

  **A round-one answer this actor has already been shown still ends the plan.** The kernel stops at the first stage that answers, and it discovers the piece was already injected once only afterwards, so that failure gets no words round and is not named at turn end either. It is the kernel's own selection rule rather than the arm's, and it is unchanged here.

  **`sig_v1` normalizes the frame it keys on.** The message half was already reduced — hex runs to `H`, digits to `N` — and the top-frame basename was concatenated raw, so a stack through a bundler-generated file (`chunk-4f2a91.js`) keyed the identical failure differently on every rebuild and resolved nothing it had been published under. The frame now goes through the same reduction, which also folds `main2.rs` and `main3.rs` together: a piece published under a `sig_v1` whose frame carried digits has to be re-keyed to resolve again.

  **The team shelf only.** There is no public leg in either round: the marketplace holds none of this team's errors, and every hit in a 150-search census of this shelf came from the team side. The verdict is unchanged too — the shelf's own `strong`, no relaxed acceptance rule.

  **A failure with an error line but no fingerprint now asks something.** `sigV1` refuses a line with no errno and no frame, and the arm used to fall silent there; it now asks in words.

  **The once-per-question gate now keys on the error line as well as the fingerprints**, so two failures with different messages are two questions, and so are two failures that print the same message from different files.

  **A totals row is no longer the end of the scan.** When the last error-shaped line is a runner's totals row and its block holds no diagnostic, the search now continues into the failure block the same run printed directly above it, across up to four blank lines. The arm splices stdout, stderr and the failure string with a newline apiece, which turns the single blank vitest prints before its summary into two — and two blanks are a block boundary, so a vitest failure with an ENOENT and a frame three lines up used to key nothing at all. The hop is one block and requires a runner header, so a totals-only output, or one with free text or an earlier command's error above it, still yields nothing.

- 6788644: One redact module, one rule table. `src/lib/redact.ts` replaces `scan.ts`: `findings(text,
scope)` is the publish scan with the audience as a parameter (`publish` reports every rule,
  `team` reports only the rows scoped to it, so `publish`, `edit` and `sync` pass a scope and
  filter nothing), and `mask(text)` is the new query-side verb the hook templates render inline
  from the same table. `redact-rules.json` carries `scopes: ('query' | 'publish' | 'team')[]` per
  rule instead of a `teamSurvives` flag; `secret-assignment` gains a second entry for the
  space-separated `--api-key <v>` flag form, so a flag-passed key is caught on a team shelf
  (tenjin-agent#281).
  One fixture set, `redact.fixtures.json`, replaces `scan-corpus.json`.

  **`mask()` is precise, and it masks rather than deletes.** For a query, only the rows scoped
  `query` — vendor-prefixed tokens (`ghp_…`, `sk-ant-…`, `AKIA…`), a password inside a connection
  URI, an `Authorization: Bearer` header, and a `NAME=value` secret assignment — are replaced,
  each by a masked stub (`ghp_…[redacted 36 chars]`) that keeps the type-identifying prefix, never
  the matched value. Nothing else is touched: a path, a hostname, an IPv4 literal, a commit SHA,
  an env-var name, an email address and ordinary prose all ship whole, because those are the
  identifiers the shelf's search ranks on. Measured on 3,760 real prompts before this decision:
  the old scrub altered 604 of them and deleted 1,032 paths, URLs and ids to stop 2 vendor tokens
  total. The hook templates (`push-scripts.ts`, `hook-scripts.ts`) now render `mask()` inline from
  the table's `query` rows at generation time, replacing the standalone `SECRET_*_RE` list and
  `scrub(text, mode)` entirely; every caller that used to pass `'secretsOnly'` now calls `mask()`.

  **Publishing: the local scan is warn-only, and the marketplace is the only blocker.** `publish`
  and `edit` route every local finding through the standing `publish.mode` consent flow — `review`
  asks, `auto` returns `NEEDS_CONFIRMATION`, `full-auto` clears it — including a block-tier shape;
  the local hard-block branch and its "never clearable" wording are gone. The marketplace's own
  ingest scan is the one place a write can still be refused outright (`PUBLISH_BLOCKED`, vendor
  tokens, private keys, seed phrases, DB passwords, bearer headers), unchanged, and no `--yes` or
  mode clears that. `sync` stops scanning locally: it sends every Fix note now, and the server's
  existing refusal is counted under `skipped`, as before, and covers what a local scan used to hold back.

  **Which rows a shelf flags is data.** `team` scope (both the local flag list and the shelf's own
  "is this safe to make public" triage) is now the block-tier rows plus `secret-assignment` (and
  `hex32-value`, `raw-private-key`'s warn form) — down from six survivors to two; `high-entropy-
string`, `env-dump-block` and `embedded-instruction` are public-only. `private-repo-reference`
  and `scan-context.ts` are deleted: a public-only nicety about the author's own repo slug, and the
  only rule that needed caller context.

  Docs, the `tenjin-publish` skill and `docs/safety-model.md` are
  updated to match: no more local "hard block", the team-shelf survivor list, and the hook
  template's masked-not-deleted behavior.

- 35ab151: The CLI reads and writes `loop.db` (PR E).

  `state.db` is gone: the search record, the publish-dedup facts and the loop's own reports all live on the loop database the daemon already owns, and `tenjin doctor --prune` deletes the retired store and the five files it replaced rather than importing them. `tenjin sync` is deleted — the failure arm keys a failure exactly, once, and a fix this session closed is named in the turn-end ask with the key it was recorded under, for the agent to publish itself with `publish --key fingerprint=<key>`, which stamps the pairing. `outcome --last` and the per-session importance report are deleted: the CLI knows the harness session but never the agent inside it, so in a fan-out either one could rate a sibling's work.

- c646d9a: The loop daemon and its kernel (PR B of the loop redesign). `tenjin daemon
start|stop|status` runs one local process per data dir, bound on 127.0.0.1 with
  a derived port and a bearer token, that serves every hook fire on the machine
  through `POST /hook/claude` and exits after `loop.idle_exit_min` minutes without
  one. The kernel is one lifecycle for every arm (`runFire`: actor, deadline,
  gates, staged legs, one ledger row) over a new `~/.tenjin/loop.db`; the Claude
  Code adapter decodes the native hook payload and encodes the response. Config
  gains `loop.*` (four budget numbers plus `idle_exit_min` and `port`) and
  `team.publicFallback`. Nothing is wired into a harness settings file yet: the
  arms and the install wiring are the next PR, and the existing hook scripts keep
  running unchanged.
- 6ed0a53: The local and handoff arms on the kernel (PR D of the loop redesign). Every
  hook entry `install` registered now has an arm behind it; nothing to install,
  nothing to restart.

  **What an agent sees differently.** A failing build, test or lint command is
  matched in one round against this machine's own error-to-fix record and the
  team shelf's fingerprint keys, the teammate's piece first; a pairing this
  machine closed before comes back as a record inside the same fence every other
  answer uses. A child you dispatch opens with the piece its work order matched,
  whole when free, and its parent hears nothing about it. A child that did work
  (any search, fetch, read or edit of its own, or a work order no shelf could
  answer) is asked once, when it stops, to publish while it still holds the
  evidence, and a `# ` heading inside its fallback fence is its title. Your own
  turn end asks once per session, lists what this session's children queued, and
  re-arms only when a child queues something new. A session opens with the
  search-first primer again, team or public by your shelf.

  **What is gone.** The ask no longer waits for running children, reads no
  transcript, and names no finding from another session; a person lists the
  machine's whole queue with `tenjin publish --finding`. The failure arm remembers
  nothing about a shelf that refused keys and asks again next time; a checkout
  with no git origin still sends its fine keys. Every timer, cap and slice those
  arms carried in the generated scripts is deleted; the loop keeps one clock, the
  fire deadline.

- 9e69d8b: The lookup arms and the install cutover (PR C of the loop redesign). Claude Code's
  hook entries are now **eleven**, written by `tenjin install` as one whole set: nine
  POST the harness's own payload to the loop daemon on `127.0.0.1`, and two run the
  shim so a daemon is up before the turn's first tool call. Nothing spawns a
  generated `.mjs` script any more. Three arms answer over one factory, one search
  leg and one delivery: `prompt` (your prompt, before the turn starts), `research`
  and `fetch` (a `WebSearch` query, and a `WebFetch`'s url plus its prompt —
  separate arms with separate claims, so a run of page fetches cannot spend the
  search's), and `context`, which asks nothing and only stamps the local marks the
  other arms read. The failure, dispatch, subagent, stop and
  primer arms land in the next release; until then their entries fire, and the
  daemon records each fire and answers with nothing.

  **What an agent sees differently.** Every question is masked and nothing else is
  stripped, the WebSearch query included — it used to travel raw. A search query is
  never condensed (condensing damaged 131 of 184 real ones; `pgvector testcontainer
collation` came out empty), and neither is a prompt. A hit is the first of three
  candidates the shelf marks `strong`, so a strong rank 2 lands over an un-strong
  rank 1; with none of the three marked strong nothing is injected — the fire is a
  miss, reason `no-hit`, because the client has no quality rule of its own and rank 1
  on nobody's word is not an answer, though the leg row still records what the shelf
  offered. `confidence` and `corroborated` are no longer read on this side; each
  leg row records the shelf's `calibration`, so a lookup whose meaning step never ran
  is not mistaken for an empty shelf. A finding arrives **whole** when the shelf
  sends a body — free rows carry one, paid rows do not — with no per-session cap on
  full bodies and no second request to fetch one; a shelf that sends none yet gives
  pointers, as before. The shelf sends the whole free piece and the CLIENT owns the
  cut, at 6,000 characters on a word boundary, because what a long body costs is the
  reading agent's context and the shelf cannot see that budget; a cut body carries one
  line naming the resource id, which is how the agent learns it has a preview and that
  `tenjin read <id>` is the rest. Nothing published today is long enough to reach it. **The client-side rate limit is deleted**: it refused 246
  research fires for every 25 that reached an agent, and the runaway guard is the
  shelf's own 429, recorded as `rate-server`. The loop keeps two numbers,
  `loop.human_wait_ms` and `loop.tool_wait_ms`; `loop.rate_per_min` and `loop.burst`
  are gone.

  **What an operator does: run `tenjin install`.** That is the whole upgrade.
  Install converges rather than merges — it drops every entry of ours, appends the
  eleven, and deletes the previous release's eight generated scripts by name — so a
  re-run is byte-identical and **`tenjin uninstall` first is not needed**. It brings
  a healthy daemon up _before_ it writes `settings.json`, because Claude Code picks
  that file up through a watcher and an entry naming a daemon that is not there turns
  a live session's next tool call into an `HTTP hook error`; the file is written mode
  0600, since it now carries the daemon token as a literal. Turning an arm on or off
  is a config write and nothing else — no wiring step, no re-install, effective on
  your next prompt, and it neither adds nor removes an entry. `tenjin update` fetches the
  new build and refreshes the profile it ran under; the bundles are the same bytes for
  every profile now, so there is nothing to hunt for. `tenjin uninstall` takes the
  entries out first, then stops the daemon and removes its files, keeping `loop.db`.
  `tenjin doctor` compares the port the entries name to the daemon
  answering `/health`, and warns on a settings file wider than 0600.

  **Hermes is gone.** `tenjin install --harness hermes`, its Python plugin and its
  native wiring are deleted; nobody used it, and the adapter comes back against the
  frozen kernel if anyone ever does. `loop.db` is deleted rather than migrated across
  this series.

- b230842: One hook surface, and install and doctor reshaped around it (PR E2).

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
  the daemon behind them, with `--json`. `tenjin hooks enable|disable <arm>` writes the same
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
  arms, `docs/agent-permissions.md` describes each one in a line — when it fires,
  what it does, what leaves the machine — and the README and
  `docs/safety-model.md` carry the rest. `tenjin help <command>` stays, filed
  under Setup rather than left ungrouped, because gh, git, cargo and docker all
  take both spellings. The audit that came with the reshape took the dead surface
  with it: `(default: [])` stops trailing the nine repeatable flags, and the
  globals still parse after a subcommand without being re-listed under every one. The README's "Core commands" list, which
  restated all of this and had fallen behind it, goes the same way, and the arm
  table stays what `tenjin hooks` prints rather than a snapshot in help.

- f3f888a: No scrubbing: an agent's question is now exactly what it typed, with its secrets
  masked, and nothing else (PR C2 of the loop redesign). Every hook's text goes
  through `mask` and then the search leg's cut at the shelf's 512 characters on a
  word boundary. That is the whole list. A prompt is not condensed, a url is not
  split into words, a file name is not turned into a phrase, and no arm invents a
  question out of something it read.

  **What an agent sees differently.** Your prompt travels as the sentence you
  typed, so the shelf ranks on your words rather than on this machine's summary of
  them — condensing dropped stopwords and short clauses, and a summary is a
  different question. The two length skips are gone with it: a 78-character
  question is a question and gets asked, and a 5,000-character paste is asked
  about too, cut at 512 like everything else. Three prompt skips remain, each its
  own reason on the row: `slash` (a harness command), `words` (fewer than three
  words of three characters once masked), and a new `harness` for text the tooling
  sent through the prompt channel — `<task-notification>`, `<agent-message`,
  `[SYSTEM NOTIFICATION`. A `WebFetch` now asks about the page's address and the
  prompt attached to it, both as written; the address stops at its first `?` or `#`; everything after that character is dropped,
  because a signed url keeps its credential in a parameter value whose shape
  masking has no rule for. The `identifiers` list is no longer sent beside the
  query at all: the shelf lifts identifiers out of the query itself, so sending a
  second, client-computed copy only added a way for the two to disagree.

  **The read and churn lookups are deleted.** Reading a source file no longer
  asks the shelf about a package it imports, and the fourth edit of one file no
  longer asks about the file. Both invented a question out of a file rather than
  carrying one an agent asked, and neither ever produced the precision number that
  was the reason to keep them log-only. `trigger` on the wire is now `prompt` or
  `research`, and `read` and `churn` are gone from it.

  **The context arm stays, and only writes marks.** It is registered on the same
  events and still stamps what other arms read: a `Bash` call's start time
  (`bashstart`), every edited path (`edited:`), and the lead's own inspection and
  mutation activity (`activity:`). It asks nothing, so every fire on it is
  recorded with the reason `no-question` — which is the truth, not a silent exit.
  The per-file edit counter that fed the fourth-edit trigger is gone with the
  trigger.

  Owner decision, 2026-09-06: minimal alteration of what leaves the machine. A
  transform that is not masking is a guess about what the agent meant, and a guess
  this side makes is one the shelf never gets to see past.

- 4564f3f: Two account verbs, so a CLI-only publisher is not listed under a bare 0x address
  (tenjin-agent#208). `tenjin profile` shows the handle, display name, and bio behind
  the wallet; `tenjin profile set --handle <h> [--display-name <n>] [--bio <t>]`
  claims or renames the handle and sets the rest (omitted flags keep their stored
  value). `tenjin stats` prints this month's earnings, full reads, and glances. All
  three ride the same session-key auth `publish` and `edit` use, so a team shelf
  needs nothing extra and a cached session means no wallet prompt. No consent gate
  and no permission-tier entry: these are operator-invoked account edits, not content.
- c223903: **Breaking.** A finding is a publish document, and that is the only shape:
  frontmatter carrying `title` plus the answer-card keys, then the body.
  `tenjin publish <file>` is the only command that takes one.

  - The document is validated before anything is written. A missing title, or an
    answer card missing a rubric key, is refused with exit 2 naming the exact
    frontmatter keys to add, above the scan, the dedup answer, the confirm, the
    wallet and the network. `--draft` skips the card check and nothing else.
  - The card check is a quality policy mirroring the server's completeness rubric.
    What it buys is judgement, not rank: the card is the pre-purchase decision
    payload, since the rank-1 card inlines the questions, the scope and the
    exclusions, so a searcher judges fit without paying. An incomplete card is
    labelled `no answer card` or `incomplete answer card` in every searcher's
    `matchReasons`. Explicit filters remain independent: `freshWithin` requires
    an in-window `asOf` for snapshots, and `appliesTo` requires every requested
    value. A cardless piece fails both filters. Completeness changes neither
    relevance nor rank.
  - The title is frontmatter `title`, else the body's first level-1 `# ` heading.
    No other heading level counts.
  - Removed: `--dry-run` (validate-before-write is the preview), `--finding` and
    `--discard` with the local finding queue behind them, and every card-authoring
    flag on `publish` (`--question`, `--task`, `--scope`, `--exclusions`,
    `--applies-to`, `--as-of`, `--valid-until`, `--artifact-type`,
    `--temporal-mode`, `--provenance`, `--methodology`). The card is frontmatter or
    it is nothing. The same fields are gone from the `tenjin_publish` MCP tool,
    which is no longer annotated destructive; `tenjin edit` keeps its flags.
  - The CLI fills nothing content-bearing. A named `--search-id` no longer copies
    its question into `questionsAnswered`; every card entry is the author's.

  On the daemon side, the turn-end ask names the command and nothing else: the
  fenced fallback, the harvest that read it, and the queued-findings lines are all
  gone, and a stop after the ask writes its row and says nothing. A subagent's Read
  on its own no longer earns it an ask.

- 9a6f2aa: Let the child publish its own finding, and stop a queued one from going unseen (tenjin-agent#228). This adds a seventh `SubagentStop` settings entry (seven entries across six events), so run `tenjin install` once after upgrading or the arm never fires; `finding`, `dryRun` and `discard` join the MCP `publish` schema, and the arm is gated by `hooks.publish`:

  - **The `SubagentStop` ask now asks the child to publish.** It used to ask for words the parent then had to relay: a summary of a summary, stripped of the probe trail, the failed attempts and the exact versions and error text that only the child ever held. Capability was never the blocker — a capable child could always have run the command, and the dogfood found zero child publishes — so what was missing was the ask, at the one moment the evidence is still in context. It is the SAME publish anyone runs: same command, same `publish.mode` resolution, same scan tiers, same refusals, reaching whatever shelf your configuration names, the public marketplace included. No child-specific branch, no shelf restriction and no capability detection, because consent lives in your configuration and not in which agent runs the command.
  - **The fenced block is the fallback, and a REFUSAL is what triggers it.** If the publish refuses, or the child cannot run the command at all, it is asked to state the finding in a marked block instead, which the next fire harvests onto a local queue as before. Which of the two happens falls out of your own mode rather than a policy in the hook: under `review` the confirm needs a TTY that a child running the CLI through a tool call does not have, so its publish fails closed with `needs_confirmation` and publishing stays with the parent, the context where the human you asked for actually is; under `auto` the child publishes.
  - **`tenjin publish --agent <id>`, and the parent reports what its children published.** A child publishing from a sidechain nobody reads is answered by visibility, not by taking the publish away from it. The flag records the publish under the harness agent id the ask handed that child, keyed on the same `agent_id` the hooks already stamp into their rows, and it gates nothing at all: same scan, same consent, same price, same shelf. The capture ask then names those publishes as urls, above the queue, matched to the children this session actually asked. It is not exposed on the MCP `publish` tool, which has no id of its own to pass.
  - **The capture ask surfaces unpublished findings from earlier sessions.** `SubagentStop` fires per child while a parent `Stop` may never fire at all — a crash, an interrupt, a session ended from the UI — so a finding routinely outlives the run that produced it, and a session-scoped list made it invisible rather than merely late. The queue is machine-wide now, inside the same 8-hour window the open loops use, and a finding from another session is named and marked as such. Publishing one takes it off that queue, so "held locally and unpublished" is true of everything the ask lists.
  - **A late finding is no longer orphaned in the session that produced it, and no cursor decides which findings exist.** A subagent launched after the capture ask fired, or one whose launch had already fallen out of the transcript tail, queued its finding behind an absolute once-per-session gate that exited before it ever read the queue. A watermark fixed that and introduced a worse one: `SubagentStop` runs one process per child and `publish` runs in another again, so the order rows are minted in is not the order they become visible in, and a row that commits after the ask that read past it sits below the cursor forever. Three cursor shapes lost a row that way (the newest `at` plus a millisecond, the greatest uid, and the (at, key) pair). The ask now stamps each row it names, and both the gate and the two lists read the rows that carry no stamp: a late commit is picked up by the next ask, a named row is not restated, and nothing assumes an ordering. The stamp is machine-wide, so a finding is named to one context rather than re-listed to every session for eight hours; one nobody acts on is not re-offered and stays reachable by id.
  - **`tenjin publish --finding <id>`, with `--dry-run`.** The id the ask prints is an argument to the command the ask already names. It is a source and nothing else: the body comes from the store instead of a file and takes the same consent cascade, the same review confirm, the same never-bypassable block tier and the same pricing. The review confirm is the read gate, so it carries the whole stored body with the child's agent id and the search id; `--dry-run` prints the same thing and exits having touched no wallet, made no request and written nothing. The child, its agent id and the loop it closed come back on the receipt, and that search is claimed on the piece unless you named one yourself.
  - **The capture ask lists every queued finding.** It named the five newest, which dropped exactly the sessions with the most to publish. One line is what naming a finding costs the parent, so all of them are named, bounded only by the runaway guard and the reason's character budget.
  - **The child's own publish closes the loop it was asked about.** The ask splices the search id its signal came from into the command, so the preferred path answers the dispatch MISS and prefills the piece's answer card; only the fallback used to close it. The ask also names the `tenjin_publish` MCP tool for a child with no shell, on the same principle the child pointer ladders on, and spells the refusal codes as the CLI emits them.
  - **A queued finding survives a session that never ended cleanly.** The research gate counted findings under the CURRENT session while the list it heads is machine-wide, so a stranded row (its parent `Stop` never fired) was invisible to every later session that had done no research of its own: a dead parent erased the finding instead of delaying it. That gate now reads the same machine-wide unpublished queue the list reads, so any session that can still publish is offered it.
  - **A child publish re-arms the report, and a re-ask names what a clock watermark used to swallow.** A successful child publish writes no queue row, so after a session's first ask every later child publish went unreported, and visibility is the only thing standing behind letting a child publish at all. The re-ask gate now fires on either half. The watermark is also taken from what the ask actually NAMED rather than from the clock at the moment it marked, so a finding committed while the ask was reading is named at the next turn end instead of being skipped permanently.
  - **`agent_published:` is one row per publish.** Keyed on the agent id alone it upserted, so a child that published something objectionable and then anything innocuous left the parent's report showing only the second. The ask lists every publish now.
  - **The harvest is bounded before it is scrubbed, and `scrub`'s secret-name classes are bounded.** `scrub` ran on up to 20,000 characters an untrusted child chose, and its unbounded name classes backtrack super-linearly on a keyword-dotted run (227 ms at 2k, 1.8 s at 4k, 14.7 s at 8k). A synchronous regex cannot be pre-empted by the hook watchdog, so the harness timeout killed the process mid-scrub and the harvest was lost with no row at all. Cut first, then scrub, with the name classes capped at 64 characters, which changes no match.
  - **The fences are anchored.** The parse closed at the first ``` after the opener, so a finding carrying a code snippet was truncated silently and the truncation was what got published; and it opened at the first marker, so a child that MENTIONED the marker while declining harvested its own decline. Both fences are now a line of their own, nested code fences are counted, and the last opener wins.
  - **`PUBLISH_BLOCKED` no longer reprints the body.** A hard block on a stored finding is the signal that the hook's scrub missed a live credential (a BIP-39 mnemonic passes every scrub rule whole), and the refusal attached the whole body to the terminal, the JSON envelope and the MCP result. It now names the finding and withholds the body; the review confirm keeps it, where it is the read gate.
  - **A finding carries the project it was captured in.** The queue is machine-wide and `publish.mode` resolves from the current directory, so a finding harvested in a private repo under `review` was publishable from an unrelated `full-auto` repo with no confirm. The row now stores its project, the ask marks a row from another checkout, and publishing one from elsewhere needs an explicit `--yes` in every mode.
  - **`tenjin publish --finding <id> --discard`, so no is final.** Only a publish ever removed a queued finding, so a declined one came back at the first turn end of every session for eight hours. `discard` is on the MCP `publish` tool too.
  - **The composed ask is bounded by characters, and the bound costs a turn rather than a finding.** 200 queue rows and 200 published rows composed a six-figure string inside a blocking reason. Cutting the composed text was not enough: the cut ran after the ask had already moved past every row it read, so past ~70 rows a finding was dropped from the text and never named again. Each list now fills a character budget item by item and stamps only what it kept, so what does not fit is named at the next turn end.
  - **The ask carries no part of a finding's body.** Capture runs the query scrub and no scan tier, and the secret classes the block tier exists for pass every scrub rule whole, so a clipped 160-character preview put the same live credential `PUBLISH_BLOCKED` refuses to echo into the parent's blocking reason one turn earlier. A finding is named by its id, its author, the search it answers and its length; `--dry-run` is the read path and runs the scan.
  - **`publish --finding <id> --dry-run` now works on a blocked finding.** The block threw above the dry-run return, so the one command four different texts named as the way to read a blocked finding re-threw and printed nothing. `--dry-run` runs above the block, prints the body, reports the blocking findings and still publishes nothing; a real publish refuses in every mode as before.
  - **A block the hook cannot record degrades to a nudge.** The mark that bounds a re-ask was written and its result discarded, and the test for it only asked whether the session's row existed, which on a re-ask it already did. A lost write therefore left a block firing with the same reason at every turn end for the rest of the window: a session the operator could not end. Both the session row and every per-row stamp now report whether they landed, and a block degrades on either.
  - **`--discard` takes the gates `--finding` takes.** It resolved and dequeued with no project check and no `--yes` while the ask hands a parent every cross-project id it holds, so an agent in one project could permanently drop another's finding. It now takes the same cross-project confirm, the not-found error enumerates only this project's ids, and the MCP `publish` tool is marked destructive and says so.
  - **The three `SubagentStop` claims fail closed.** `claimState` reports a win on a write the store swallowed, which is what a SQLITE_BUSY during a fan-out looks like, so a swallowed session-budget insert left the budget unheld while the per-child claim landed and every later child in the hour was blocked for a turn. All three are `claimStateFresh` now, windowed to the same hour the arming signal is read over.
  - **The install receipt and both permission references describe what the arm actually does**, which is ask the child to PUBLISH, rather than the earlier fence-to-the-parent design.
  - **The child-publish report claims only publishes made after this session asked.** `agent_id` is an undocumented probed field and the publish rows are machine-wide, so matching on the id alone would report another session's child's work as this parent's on any harness whose ids repeat. A publish that predates this session's own ask of that id is not its answer. Two live sessions sharing one id still cannot be told apart; that needs a session on the row and a flag on `publish` to carry one.
  - **The lifecycle row sits directly under the claims that spend the session's one child ask**, so a process killed in that gap leaves a row saying why rather than a budget spent in silence. A lease is the dispatch arm's answer to the same shape and is deliberately not taken here: a session budget that expires after the fire's own ceiling is a budget of one ask every eight seconds.
  - **A stored finding is itself a research signal.** `didResearch` gated the capture ask on a session-owned search row or a qualifying injection, and a capture triggered by a FAILURE leaves neither: the lookup missed, or was weak, local, skipped, or never injected. The ask therefore never fired for exactly the case the child-boundary ask was built to catch. An unpublished finding inside the ask's own window now clears the gate on its own. It counts the QUEUE a publish deletes rather than the append-only log, so after a child publishes under `auto` the session no longer fires a bare ask with an empty list.

- 4fe280c: Close the loop's own loop: record whether the agent used what the hooks showed
  it, locally and on the shelf that served it.

  **`tenjin grade [--since 7d] [--session <id>] [--explain] [--label <uid>
<status>]`.** The arms record what they delivered and the shelf records what it
  served; neither can see what happened next, so nothing has ever measured the
  loop's precision. This reads the session transcript, finds where the
  injection landed, and judges what the agent did after it. Only tool inputs
  count: prose agreeing with an injection is what an injection makes likely
  whether or not it helped, while a tool call is a decision the agent spent
  something on. An explicit `tenjin read|inspect <id>` or the injected URL is
  `used` whenever it appears; a two-word backtick span copied out of the injected
  text within the next ten tool calls is the weaker `partially_used`; nothing at
  all, once the session has ended, is `rejected`; and a finding that was never in
  front of the agent — every subagent injection, which reaches no transcript — is
  `unobserved`. A session still running is left open rather than called rejected,
  because the shelf keeps the first verdict per lookup and post and the next tool
  call could contradict it, and so is a session whose transcript this machine
  could not go looking for: `unobserved` is permanent, and an unreadable home
  directory is a fact about the run rather than about the row. Verdicts go to the
  shelf that actually served the row — the origin of the URL it was shown with,
  since a search id means nothing on another shelf and that endpoint answers 202
  either way — with the team bypass header only when that origin is the configured
  team shelf's. A landed verdict is never re-posted and a failed one is retried on
  the next run. `--explain` shows the anchor line and the evidence; `--label` sets
  one verdict by hand, on an injected row only.

  **One store, not two.** `lib/search-store.ts` was a second module over the same
  `searches` table, left over from when that ledger was a file. Its helpers move
  into the store, and two queries stop scanning on the way: `buy <resourceId>` and read attribution now ask one
  statement over `json_each` instead of walking 500 rows' candidate arrays, and a
  search is looked up by id case-insensitively rather than filtered out of the
  same 500. Behaviour is unchanged, with one break: the `candidate` value is gone
  from the resolution vocabulary, where it was retained only so a value written by
  an older build would parse.

- 2eca443: The hook sidecar: a team shelf, two-shelf search, and a capture loop.

  **A team shelf is a second Tenjin deployment, not a new thing to learn.** Point `baseUrl` at
  it and set `shelfBypassSecret` to its Vercel protection-bypass secret; that one key is what
  turns team mode on. `publish`, `search`, `read`, `inspect` and `buy` all work as they always
  did, against a different origin. There are no new commands. Every request to `baseUrl` carries
  the bypass header and nothing else ever does — the header is attached from the request URL, in
  one place, so it cannot follow a call site's mistaken belief about which shelf it is talking
  to. `config get shelfBypassSecret` prints `set` or `unset`, in `--json` too.

  **Search asks two shelves, team first.** `publicShelfUrl` (the public marketplace,
  consume-only) is the fallback: `tenjin search` and every hook arm query `baseUrl` first, and
  only on a miss do they ask the public shelf. Human output labels each block by shelf; `--json`
  carries the answering shelf's response plus a `shelves` array naming both legs. `read`,
  `inspect` and `buy` accept candidates from either origin, and a `buy` signs its SIWX header for
  the shelf the URL is actually on. In public mode there is one shelf and none of this is
  visible.

  **Publishing to a team shelf is free, and loses the warn tier only.** It goes to `baseUrl`
  only, never to the public shelf, with the price defaulting to `0`. The scan's WARN tier is
  skipped, except for the two credential checks `secret-assignment` and `hex32-value` and the
  injection check `embedded-instruction`: the rest of those warnings ask "is this safe to make
  public", and a team shelf is not public, so every one of them fires on exactly the findings the
  shelf exists to hold. The three exceptions ask something a private audience does not answer —
  is this a live credential, and would this text steer the agent that reads it — and `review` and
  `auto` still confirm on them. **The hard secret
  block still applies on every shelf**, in every mode, clearable by nothing — a team shelf is a
  hosted database with logs and a shared door key. The consent cascade is unchanged as well;
  `review` still asks once per note. Clearing `shelfBypassSecret` puts the warn tier back.

  **A closed loop reaches the shelf that answered.** Every search entry records the base URL of
  the leg that minted its searchId, so `tenjin outcome` posts there rather than to whatever
  `baseUrl` currently is, and a `--search-id` the other shelf answered is dropped from the publish
  body and left open rather than misfiled on a post row.

  **The arms put a finding in front of you without being asked.** Hooks watch for the moments
  where an answer is worth more than a search — a failing Bash command, a submitted prompt, a
  subagent dispatch, a stuck read/edit loop — and surface a match from whichever shelf answered.
  Every decision, delivered or not, is recorded with the shelf it came from. No arm ever cancels
  or changes a tool call: each one only adds context beside a call the harness makes anyway.

  **Capture closes the loop.** A session that actually did research is asked once, at Stop, to
  publish anything durable it settled, with the resolved `publish.mode` named in the ask. The bar
  follows the mode: public, durable and rights-clean on the marketplace; "anything a teammate on
  this project would want to know" on a team shelf. The ask fires once per session whatever the
  agent does with it. Sessions that only read and edited code are never asked, and the arms' own
  lookups do not count as research.

  `shelfBypassSecret` is unset by default, so an existing install picks up no team shelf until it
  opts in.

- 861a48f: The failure arm's mechanical error-to-fix record is deleted. It only asks now.

  **The local pairing lane is gone.** The daemon no longer opens, closes, verifies or replays a record of its own: it inferred the fix from whichever files an agent edited plus a later passing command, and measured against ten real fixes it matched none of them, while an unrelated `pnpm test` could close a failed `pnpm db:migrate` through a file that only shared a basename. `pairings` and `pairing_closes` are DROPPED from `loop.db` on the next open, deliberately and permanently — there is no migration ladder, and a table nothing lists is a table nothing would ever clean up.

  **The failure arm now only asks.** Round one sends the failure's `sig_v1` and `sig_v1_test` fingerprints to `/api/keys/resolve`; round two, only if the first answered nothing, sends the error line in words to the team shelf. A machine with no team origin asks nothing at all behind a failing command, where it used to read a test report and consult itself.

  **The `local` shelf and its opener are gone**, so nothing is ever injected as a record from this machine. A parked handoff still reaches a starting child, under the shelf its own answer came off.

  **The turn-end ask no longer names fixed-but-unwritten errors**, and `doctor` no longer counts them: a fix this machine inferred was never a fix to begin with. `tenjin publish --key fingerprint=sig_v1:<hash>` survives as the hand flag for the server-side key registry that round one resolves against, and the ask now fills it in from the failure's own ledger row rather than from a record of its own.

  **`~/.tenjin/loop.db` is still kept by uninstall**, for the search record and the outcome history.

- 7da12bf: Answer the marketplace's server-side publish scan instead of failing on it. The
  `tenjin` backend now runs the same rule corpus in its shared write path, so a
  publisher not running this CLI is gated too. Until now its refusals reached
  `publish` and `edit` as opaque post-consent write failures (exit 4), which is
  the wrong shape for a decision the operator can actually act on.

  Both writing commands now map the gate's two codes into the consent flow they
  already have. A `scan_blocked` is a hard failure, exit 3, with the redacted
  findings rendered: the block tier has no acknowledgement path server-side, so
  there is none here either. A `scan_needs_ack` merges the server's findings with
  this run's local scan, deduped by detector and offset so the same secret renders
  once, and refuses as `NEEDS_CONFIRMATION`; an explicit yes re-runs the identical
  content carrying the server's ack token, and exactly once, since the token is
  bound to that content and that finding set.

  A confirmation covers the findings it post-dates, so a `--yes` clears the
  server's hold only when the merge added nothing the local pass had not already
  rendered. The `--yes` was an answer to a payload built before any server call,
  and the marketplace's set is strictly larger than the local one (its semantic
  checks have no local counterpart at all), so reading that yes as an answer to
  findings it could not have contained is reading it as an answer to a question
  nobody asked. `review` and `auto` therefore stop on a server-only warn even with
  `--yes`, render it marked `[server]` with its tier, and say in the fix that the
  yes did not cover it. `full-auto` still acknowledges unasked: clearing soft
  findings unasked is that mode's contract.

  New config key `publish.ackServerWarnings` sets a standing answer without
  changing the mode. `off` never acknowledges, which is the off switch an
  unattended `full-auto` machine needs; `on` lets a `--yes` cover the server's
  findings too, which is what a non-interactive machine sets once instead of
  re-running forever; `mode` (the default) derives the answer as above. It reads
  from the global config only, never from a project `.tenjin.json`, because it can
  only ever loosen what a yes covers; a project file that names it is ignored with
  a stderr line rather than silently. The held payload's `fix` is derived from the
  same decision the acknowledgement is, so it never advises a `--yes` that the
  mode, the setting or the caller has already ruled out, and the Stop hook's
  `publish.mode=full-auto` line says when `off` still stops a publish. In-process callers whose answer is not the
  operator's to configure still pass `ackServerWarnings: false` and never
  acknowledge at all.

  Findings travel as data — detector id, tier, redacted excerpt, offset — so a
  detector this release has never heard of renders faithfully rather than being
  dropped, and the server stays authoritative under version skew. Findings the
  gate contributed are marked as such in the rendered lines, because "fix your
  file" and "the marketplace refused this" are different instructions.

  While the backend's warn tier is still advisory it rejects nothing and reports
  its findings on the success response instead. Those now reach the receipt as a
  `scan` field and the human summary as informational lines. They never block, and
  the `checks.semantic` marker rides along with them.

- 0a9d8ef: One SQLite store for the hook sidecar (tenjin-agent#209).

  **Breaking: Node 24 is now the floor** (`engines: >=24`), because the store is Node's built-in `node:sqlite` and the hooks import nothing else. **Local hook state resets**: there is no import path from the file-per-concern era, and the sidecar starts clean.

  - **One store replaces nine files**, opened with `busy_timeout` set before `journal_mode=wal` (probed: eight concurrent hooks on a fresh database kill one of them at that pragma in the other order). Every failure — an old Node, an unwritable dir, a corrupt file, a busy database — returns null, and the arm then behaves exactly like a missed lookup: no shelf is asked, nothing is injected, exit 0, one stderr line. Failing open means going quiet, not losing the caps: with no store the per-arm lookup cap, the per-session injection cap, the outage brake and the dedup would otherwise all read zero at once.
  - **One already-shown set across every hook.** The WebSearch and dispatch hint paths never touched the push ledger, so the same note re-showed for every new question — six times in one session. Every arm consults and writes the same table now, so a piece is offered once per session whichever arm found it.
  - **The append-only push ledger, the per-session JSON, the capture markers and the publish-dedup markers are gone**, and with them the 24h pruner that had to be told not to sweep a live session's marker (a pinned mtime past the retention window asked a still-running session to capture a second time). The mkdir mutex goes too: the generated hooks had to reimplement the CLI's lock protocol byte for byte, and the 50-entry cap needed a hand-rolled demand budget — mirrored in both writers — so a subagent fan-out could not drain the slots the CLI depends on. Rows are rows now; nothing evicts anything.
  - **The ledger tallies count the whole window.** The `tail` field and the "retained tail only; these are floors" line are gone: the tally used to read the last 256 KB of an append-only file and report a floor as a total.
  - **Local error→fix replay ships with it.** The failure arm keys a failure with `sig_v1` (first message line + errno + top-frame basename, normalized; a signature with neither errno nor frame is below the specificity floor and is not stored), opens a `pairing`, and closes it when the same allowlisted command head later passes AND a tracked file changed that the error named. One close reads as "someone once fixed this by touching X"; two independent closes make it `verified` and it injects as a fix. A local match is injected **before any shelf is asked**, and demoted to "was true at pkg@X" when the recorded package versions no longer match what is installed. Mechanical throughout — no model, no `git` invocation.
  - **`tenjin doctor` probes `node:sqlite`**, because the hooks fail open without it and a sidecar that has quietly stopped remembering anything looks exactly like one with nothing to say.

- 2eca443: Shape the installed skills by team mode, replacing the guidance that differs
  rather than annotating it.

  A public-mode install is unchanged: `tenjin-search` and `tenjin-publish` render
  byte-for-byte what they rendered before markers existed, and a digest pin in
  `src/skills-text.test.ts` says so. On a machine in team mode — a shelf of the
  team's own plus its door key — the sections whose guidance actually differs are
  REPLACED. Nobody reads guidance for the mode they are not in, and no skill states
  a rule and then an exception to it.

  In team mode `tenjin-search` says a project-specific question is worth asking,
  because the shelf holds quirks of this codebase, probe results and the reasoning
  behind past decisions, where the marketplace would be a guaranteed miss.
  `tenjin-publish` says teammate-useful instead of public-and-durable, free instead
  of priced, and a scan that asks about credentials only — the whole block tier plus
  `secret-assignment` and `hex32-value`, with the rest of the warn tier dropped.

  One thing the team arm says that the previous appended paragraph did not: search
  has no way to suppress the public leg. A team miss sends the SAME question string
  to `publicShelfUrl`. So a team shelf relaxes the TOPIC, never the wording, and a
  question must still be one you would accept being logged on a shelf that is not
  yours. Secrets, credentials, customer and account names stay out in both modes.

  The seam #147 left inert is now live, and gains an `else` arm so a region can be
  replaced rather than added to: the two arms are exclusive by construction, so no
  flag value can render both or neither. `skillContentFlags` is the one mapping from
  machine facts to marker flags, and all five comparers go through it — `install`,
  the post-command self-heal, the optional-skill placer and `doctor`'s staleness
  compare materialize directly, and `scripts/pack-smoke.sh`, which cannot run the
  resolver against a packed tarball, asserts the rendered properties instead.

  Two behaviors worth knowing. Changing `baseUrl` or `shelfBypassSecret` makes the
  wired copies stale, which `doctor` reports and the next ordinary command fixes with
  no re-install. And a config that cannot be read or parsed heals NOTHING rather than
  defaulting to public: guessing public on a team machine would rewrite every wired
  skill to the other mode's guidance, under a notice claiming it now matches this
  CLI. An absent config still reads as public, because no shelf is configured.

  The mode is read from the stored config, never from a `--base-url` on the run: the
  file being written outlives the command that wrote it.

  `skills/tenjin/SKILL.md` is untouched. It is the byte-for-byte mirror of
  `tenjin.blog/skills.md` that skill-drift CI diffs after re-running the sync, and
  its reader has no CLI and so no mode.

- 9d4cdbe: The failure arm gains a second, additive key lane for test failures — `sig_v1_test` (tenjin-agent#267) — because `sig_v1` keys on the error's first line plus its errno, and a vitest assertion has no errno and no two byte-identical runs.

  **`sig_v1_test` keys on the test runner's own identity instead: file + suite + test.** Never a replacement for `sig_v1` — it still runs first, locally and on the wire — this lane only adds a second local pairing and, on a vitest-shaped failure, a second wire key beside it.

  **Identity comes from a structured artifact first, a console breadcrumb second.** A repo that adds a second vitest reporter (`reporters: ['default', ['json', { outputFile: '.vitest-report.json' }]]`) gets the file/suite/test read straight off the JSON report, mtime-checked against the failing run; a repo with none falls back to a conservative parse of vitest's own `FAIL  <file> > <suite> > <test>` recap header, requiring the `>` breadcrumb so a bare "N failed" summary (already below `sig_v1`'s own specificity floor) cannot fire it. A repo with neither loses only precision, never gains a false match.

  **A match on it gets the same full treatment a `sig_v1` match does**, and it costs no extra request: the team leg's one `/api/keys/resolve` call carries `sig_v1`'s key and the test lane's beside it, so an ordinary (non-test) failure's request shape is unchanged.

  This repo's own `vitest.config.ts` opts into the reporter as its own dogfood.

- 483797b: `tenjin update` re-materializes what `install` wrote, instead of swapping only
  the binary.

  The skills and the generated hook scripts are copies of a particular version, so
  an upgrade left them at the previous one until someone re-ran `tenjin install` by
  hand. The highest-volume request path kept reporting the old version, and agents
  kept reading the previous release's guidance. `update` now spawns
  `tenjin install --refresh` on the freshly installed entry once the swap
  succeeds, and the stale "New builds pick it up immediately" line is replaced by a
  report of what the refresh actually did.

  `install --refresh` is a new non-interactive mode: it re-renders the wired
  skills, rewrites the hook scripts already on disk, and updates the settings.json
  hook entries this CLI already owns. It adds nothing. A skill that is not wired
  stays unwired, a script that is absent stays absent, an event with no entry of
  ours gets none, and no permission rule is written at all: rules a newer version
  would grant are reported and left for an explicit `tenjin install`, because
  widening an agent's allowlist during an unattended upgrade is not a refresh. It
  never prompts, never creates a wallet, and never writes config. It refuses
  `--dry-run`, which the mode dispatches above and so could not honour. On a
  machine where nothing was ever installed there is nothing to converge, and it
  says so and exits non-zero rather than reporting a refresh that did not happen.

  The refresh runs once per profile whose hooks this machine has registered, with
  `TENJIN_DATA_DIR` set to each. `install` bakes its data dir into the scripts it
  generates, so a machine set up under a redirected data dir has hooks belonging to
  that profile while a bare `tenjin update` resolves the default one; refreshing
  only the invoking profile would leave the scripts the harness actually fires
  stale forever. A new `detectHookOwners` reads those profiles back out of the
  harness settings, tolerating anything it finds there. Each pass converges only
  the entries already pointed at its own data dir, so two profiles on one machine
  never repoint each other's hooks, and a shelf profile with the push experiment on
  cannot widen the default profile's matcher.

  A failed, refused or timed-out refresh, or one that found nothing to converge, is
  a warning naming `tenjin install` and never fails the update: the swap already
  happened, and it is what was asked for.

  Those profile paths come out of a settings file this CLI does not own, so a
  detected data dir that is not already a directory is reported rather than
  created, the list is capped, and the children run with the update check off so a
  refresh materializes no tree and makes no registry request of its own.

  Two things the refresh will not do. It does not re-execute an entry path that
  names a version: under pnpm `process.argv[1]` points into the virtual store,
  whose directory names pin one, so running it after the swap would execute the
  build that was just replaced and report success over the previous version's
  bytes. The version-free link beside the store is derived and used when it is
  there, and otherwise the profile is reported unrefreshed. And it rewrites a hook
  script only when the bytes on disk carry the generated header marker, never
  through a symlink standing where a script should be, and not at all when the
  `hooks` directory has itself been replaced by a link: an unattended writer takes
  its paths from settings.json, which anything on the machine can write, so a path
  of the right shape is not proof that the file at it is ours. Symlinks above the
  data dir are left alone, since those are ordinary machine layout.

- 5e86f49: BREAKING: `tenjin fund` is now `tenjin wallet fund`.

  Funding operates on the wallet and nothing else, so the verb moves under the
  wallet group beside `wallet show` and `wallet balance`: one uniform group in
  `--help`, in the skill, and in the permission allowlist, where the free-tier
  rule is now `Bash(tenjin wallet fund:*)`. Update any allowlist carrying the old
  `Bash(tenjin fund:*)` line; there is no compat alias, the same clean-break
  posture as the candidate-pen removal. The behavior, flags, and output are
  unchanged, and the MCP tool keeps its flat `tenjin_fund` name: MCP names do not
  nest, and renaming the tool would break MCP consumers for no grouping gain.

- 7a17fb5: `tenjin` becomes an x402 router for Claude Code. `tenjin install` writes two
  hook entries and one permission rule, registers the `x402` MCP server, and sets
  the spend limits a lookup runs under; `tenjin mcp` carries one `request` tool
  that pays for a routing decision and then pays the provider, through the same
  spend gate `tenjin pay` uses. `tenjin status` reports the local window.

  This release registers core (`install`, `uninstall`, `update`, `wallet`, `pay`,
  `config`, `doctor`) plus router (`hook`, `mcp`, `status`). The shelf product's
  commands are NOT registered and do not ship: `search`, `inspect`, `read`,
  `discover`, `buy`, `publish`, `edit`, `delete`, `profile`, `stats`, `hooks`,
  `grade`, `daemon`, `outcome`, and the shelf MCP server. Their source stays until
  a follow-up removes it. Needs `X402_ROUTER_API=on` on the backend.

### Patch Changes

- 5b0c31e: Treat answer-card completeness as public buyer context rather than a retrieval or
  answer-eligibility signal. Card prose and completeness do not change relevance,
  rank or placement, candidacy, or whether `POST /api/answer` may use a piece. Explicit
  `freshWithin` and `appliesTo` filters still require matching stored claims, and a
  present `validUntil` remains an expiry gate. CLI receipts, installed publishing
  guidance now state that distinction. The vendored plain-HTTP skill must be resynced
  from canonical server output after the companion server release is deployed.
- e200c31: Every payment this CLI brokers now carries Tenjin's ERC-8021 builder code
  (`bc_kc0altv3`) as the client service code, so CLI-brokered volume is
  attributed, where the facilitator encodes it.

  `buildExactPayment` registers the SDK's `BuilderCodeClientExtension` before it
  signs, which puts the code in the payload's `s` field. Both `buy` and `pay` sign
  through that one function, so first-party and Bazaar-lane payments are covered
  by the same line. The SDK fires the hook only for sellers whose 402 advertises
  the standard `builder-code` extension; a seller who never declared it still gets
  an extension-free payload, and nothing about the payment terms changes either
  way: same amount, payee, network, and asset, with attribution riding as
  metadata beside them.

  Attribution, not proof. The suffix reaches the chain only when the settling
  facilitator has the builder-code extension registered, and `s` is
  unauthenticated and seller-writable, so an occurrence of the code is not
  evidence that this CLI brokered the payment.

- ffa742e: Push hooks in team mode now ask the team shelf and the public shelf at the same time instead of one after the other. A slow team leg used to spend the shared search budget and leave the public leg with no time (`no-time`), or on fixed timeouts overrun the prompt arm's own budget with a hit computed and never emitted. Joined, the lookup's wall clock is the slower leg plus a body fetch, which is the sum every watchdog was already sized for; the request count doubles on team-mode fires, and so does what a fire spends of its trigger's hourly lookup allowance: both legs' rows count, so 60 lookups is 30 team-mode fires. The cap and quiet gates now run once per fire, sized to the legs it will spend, rather than once per leg — a per-leg check read the same count twice and passed both legs at one lookup left, and bumped the cold arm's escape counter twice per fire so every other escape pass landed on a leg whose answer was then discarded. `tenjin search` and the dispatch hook keep their sequential legs.

  The verdict reads the top three candidates rather than rank 1 alone: the first one the shelf corroborated and did not call `low` is the hit, and when none qualifies rank 1 is recorded on the `weak` row as before. Push arms ask the shelf for three candidates (`limit: 3`); the WebSearch hint still asks for two.

  A new ledger reason, `shadowed`, marks a strong public answer on a fire the team shelf also answered strongly: the team answer is delivered, the public one is recorded, and the ledger counts it with the other reasons.

  The hourly lookup allowance is now counted **per session** rather than per machine. Machine-wide, ten concurrent sessions shared one hourly allowance and burned it in the first half hour, so every session that started later was capped before it had asked anything and the sidecar went quiet exactly when the laptop was busiest. Each session now gets its own 60 lookups per rolling hour per trigger, and there is deliberately no machine ceiling over the top: a stuck loop is one session, and it is still bounded by that same 60 an hour per arm.

  A team hit the session has already been shown no longer swallows the public answer. `shelfDeliver` returns nothing for a piece already injected or relayed this session, and shadowing the public hit behind it spent the fire on two strong answers and emitted neither; the public answer now stands on its own, exactly as it does under a team miss.

  One leg of a team-mode fire can no longer take the other down. Both legs run under one `Promise.all`, so anything that threw while reading a shelf's response rejected the pair and the fire emitted nothing and wrote no row for either shelf; a leg that throws is now recorded as the `no-answer` it is, and the other shelf's answer is delivered.

- 7a94028: The adaptive cooldown's cold floor counts graded verdicts, not all lookups.

  The cold rule cut a push arm's cap to a third when it had `20` hits or more and
  a use rate under `5%` — but the two numbers came from different populations.
  `hits` is every lookup that returned a candidate, while `rate` is
  `used / (used + wrong)` over only the lookups something graded. So the floor,
  whose whole job is "wait until enough outcomes back the rate", was clearing on
  lookups nobody had judged: an arm with 40 hits and five grades, none of them
  `used`, cleared a floor that reads as "we have seen enough of this arm" and lost
  its cap `8` → `2` on the strength of five outcomes.

  The floor is now on graded verdicts (`used + wrong >= 20`; the two columns
  overlap, so a lookup graded both ways counts in each), the same count the rate
  is drawn from. The hot rule (`rate >= 0.4` doubles the cap) has no floor
  and is unchanged, as is the guard that leaves an ungraded trigger at its base
  cap; with the floor counting grades, that guard is now the floor's first step
  rather than a separate rule. `hits` stays in the stored `trigger_rates` row as
  telemetry and no longer feeds any decision.

- 2540e93: `tenjin install --refresh` no longer re-reports a declined allowlist as pending.

  A machine installed with `--no-allow-free-verbs` used to have its
  `permissions.pending` recomputed from the settings file on every later
  `--refresh`, which `update` spawns after each version swap — a settled
  decline had no persisted trace, so the full free-verb rule set came back as
  "NOT written; run `tenjin install`" forever (tenjin-agent#234). A decline now
  persists the EXACT rules that were pending in `install.freeVerbsDeclined` (a
  list, not a flag), and `--refresh` subtracts that list from what it recomputes
  instead of nagging about all of it forever. Per-rule rather than a single
  suppress-everything switch, so a later version's genuinely new rule still gets
  reported even on a machine sitting on an old decline.

  This is a nag-silencer, not a consent record: it clears whenever an install
  actually wires the allowlist, whether that is an explicit grant, a headless
  settle with nobody there to answer, or finding the allowlist already fully
  satisfied — installing Tenjin is the operator's consent, per existing policy,
  so any of those is enough to retire a stale decline. It stays recorded when the
  write itself is refused (an unreadable or concurrently-changed settings file):
  the next refresh still honors it instead of re-nagging about rules the
  operator already declined.

- ab486f2: `tenjin doctor` names the half-wired team shelf instead of blaming the base URL.

  A machine with `baseUrl` on a team deployment and no `shelfBypassSecret` used to
  emit no `team shelf` check at all, and every probe ran unauthenticated. On a
  protected deployment the probes were answered by the hosting platform's
  protection page, so doctor reported `CONTRACT_MISMATCH: OpenAPI document was not
valid JSON` and told the operator to point `baseUrl` at a Tenjin API, which is
  the one setting that was already correct.

  Two changes. `checkTeamShelf` now warns on that half too, from the settings
  alone, so it is reported before the network says anything and on a deployment
  that is not protected yet. It fires only on a `baseUrl` that came from config: a
  `--base-url` or `TENJIN_BASE_URL` override is this run's choice, and the existing
  withheld-key warn already names an override. Empty secret plus the public
  marketplace stays silent.

  And `fetchJson` now reports whether the response looked like an access gate (an
  HTML content-type, or a followed redirect that landed on another host, reported
  separately because only the second proves a sign-in redirect), on the 2xx that
  failed to parse and on a 401/403, because the transport is the only place
  holding the response. All three baseUrl probes read that signal and say a page
  answered instead of the API, claiming no more than the signal proves. They point
  at `shelfBypassSecret` only on a machine where that key is a remedy, meaning a
  shelf of the team's own that this run actually sends the key to, and the wording
  follows what the probe did: with no secret configured the fix is to set it, and
  when the key was sent and still did not get past (a gate page, a 401/403, or the
  blocked redirect interstitial a rotated key gets) the fix is to update the stale
  key. A blocked redirect counts only when its `Location` leaves the host asked
  for: a same-host 3xx is what an `http://` base URL or a non-canonical host name
  gets with a perfectly good key, so that one says the URL redirects and to point
  `baseUrl` at the host it lands on. A same-origin JSON 401 or 403 is still not
  classified as a protection page (an API refusing in its own envelope is an
  honest refusal), but on a shelf of the team's own the fix names the key anyway,
  because a missing or stale secret is the likeliest thing being refused. Against the public marketplace the key is refused anyway, and an override
  pointing anywhere but the configured shelf carries none, so both get a line
  about a proxy or a sign-in wall and no credential to write. An override that
  repeats the configured shelf does send the key, so it is named there too. No check output carries the secret's
  value, only the key's name.

- 23d448e: Fixed two grader defects: a backtick span that is standing boilerplate before
  the injection anchor (e.g. `CI=true pnpm format:check` named in a subagent's
  own work order) no longer reads as "copied from the note" whether or not an
  injection happened, and a command named in prose with no backticks now scores
  against a new `used-likely` tier instead of always coming back `rejected`,
  however precisely the agent followed it.

  `used-likely` extracts command heads and file basenames from the note's full
  body and credits a match within the grading window, ranked below `read` and
  `span`. Verdict's `by` field gains `'likely'` alongside `'read' | 'span'`;
  `grade`'s `wireStatus()` reports it as `partially_used`, same as `span`,
  since both are weaker-than-a-followed-pointer evidence.

  Review follow-ups on the same fix: the pre-injection exclusion window is now
  bounded to the same `SPAN_WINDOW` on both sides instead of the whole session,
  and both the exclusion and the forward match now compare at a token boundary
  instead of by plain substring, so a longer token on either side
  (`db:generate-types`) can neither erase credit for nor manufacture credit
  against a shorter genuine one the note actually named (`db:generate`); the
  injection template's own opener, body fence and closing line are excluded
  from `used-likely` candidates so the grader never credits its own
  boilerplate; `tenjin grade`'s default line now breaks `used=` down by tier
  (`read`/`span`/`likely`, plus `hand` when a `--label` verdict is present)
  instead of only under `--explain`, and the same breakdown is
  `data.graded.byTier` on `--json`.

- e65b5a4: Hook noise fixes (tenjin-agent#211):

  - The push failure arm fires only behind build/test/migrate/install/lint command heads (never `which`, `grep`, `test`, `diff`, `ls`, or `git diff --exit-code`, which exit 1 to mean "no"), and only on a real error marker in the output tail (`FAIL`, `AssertionError`, `N failed`, `Error:`-class lines, tracebacks, `exit code N`, errno codes, toolchain prefixes) rather than prose words like "error", "failed" or "not found". Stderr chatter with no marker is success. `which codex` no longer injects an unrelated note.
  - A session remembers when a full lookup bucket refills; later capped fires on that arm write their `lookup-cap` row with `cached: true` and skip the 256 KB ledger-tail parse. Interim until the state store in #209.

  - The subagent-dispatch hook now names a piece only on a **strong** hit. A subagent prompt is a work order rather than a question, so keyword overlap with a marketplace listing means much less there: three Agent calls produced six pointer lines and none of them applied. A moderate or absent match is recorded to the ledger (the dispatch arm, delivered nowhere) and never shown, and a strong hit names rank 1 alone rather than every candidate the shelf returned. The ledger row is written whether or not the arm is enabled, since the noise it replaces was identical either way.
  - The Stop-hook capture ask now **waits for background subagents**. Claude Code fires `Stop` when the parent's turn pauses, which is not the end of a turn that still has subagents running — the ask arrived before the session had learned what it was being asked to write down, and, because the marker is written at first ask, it never came back at the real end. Running launches are read from the tail of the session transcript; a transcript that cannot be read fails toward asking, exactly as before, and a background launch with no completion notice for 45 minutes is read as finished so a crashed subagent cannot hold the ask open for a whole session.
  - In team mode the dispatch hook now falls through to the public marketplace when the team shelf's best candidate is short of `strong` (before, any team candidate at all — and a search has no floor — shadowed the public shelf entirely; probed: ten team-mode dispatches, public asked zero times). The public answer replaces the team one only when it is stronger.

- f80216b: fix(inspect): `inspect`/`read`/`buy` now resolve a bare id that no local search knows about — the id `tenjin publish` itself just printed — through the public `GET /api/posts/<id>/public` route (tenjin#803), instead of refusing with `RESOURCE_NOT_FOUND` until a `tenjin search` happened to surface it first. The by-id response's own `id` is checked against the id that was asked for, and its `slug`/`creator.handle` are constrained to a single safe path segment, before either is trusted to build the payable read URL.
- f6aaf81: `tenjin install` creates your wallet again when there is none, and ends with a
  short summary: set up, your wallet address, the spend limits, and the next step
  (`tenjin wallet fund`, then restart Claude Code). `--no-wallet` skips the wallet.
  The package no longer ships a `prepare` script, so `npm i -g tenjin-cli` prints
  no install-script warning.
- e8ae560: The hook lookup cap is a runaway guard now, not a budget: 60 an hour per trigger, machine-wide.

  At `8` an hour per trigger, counted across every session on the machine, four or five concurrent sessions left each one about two prompt lookups an hour — 65 `lookup-cap` skips in a week on one machine, eleven in a row inside the one confusion a teammate's note would have answered (tenjin-agent#255, #258). A lookup is one short search and one embedding call, so the cap was rationing something that costs nothing to spend, and while the team experiment is being measured every skipped lookup is a data point lost. Every bucket (`prompt`, `failure`, `research`, `subagent`, and the default for an unnamed arm) is `60` now — 360 lookups an hour machine-wide, 720 with the hot rule doubling every arm, the only client-side bound on shelf egress; the rolling window, the per-trigger buckets, the machine-wide count and the adaptive cooldown are unchanged, so a stuck loop is still stopped and a graded arm still scales on evidence.

- f31484e: fix(build): keep the `node:` prefix on `import('node:sqlite')` in the bundle. tsup's default `removeNodeProtocol` shipped it as `import('sqlite')`, so `tenjin doctor` reported the store missing and the CLI-side store (the ledger reports, search recording, publish dedup) failed open on every Node; the generated hooks were unaffected. The packed-artifact smoke now pins the specifier.
- 13c1def: Every hook arm and `tenjin search` send up to 8,000 characters, the shelf's one
  query bound, so a long prompt reaches the shelf whole. Needs BackTrackCo/tenjin#853
  on the shelf; an older shelf answers a long non-dispatch query with a 400.
- c9becc4: `tenjin doctor --prune` now also removes the retired pre-daemon hook files
  `hook-nags.json` and `hook-health.json`, which nothing has read since the loop
  database replaced them. Installed search guidance points hook-arm state at bare
  `tenjin hooks` instead of a `config get hooks` subtree that never existed, and the
  search skill is tightened throughout (228 to 207 lines) with no fact dropped.
- c2cbd4d: Accept Markdown on standard input for publishing and body edits:

  - `tenjin publish -` reads stdin explicitly.
  - Bare `tenjin publish` reads stdin only when it is non-interactive.
  - `tenjin edit <post-id> -` replaces a post body from stdin.

  Interactive bare publishes still return usage immediately, and MCP stdio is never
  exposed to either command as content.

  The installed publish skill and capture hooks now prefer the stdin form. When a
  regular file is used instead, they require `tenjin publish <file>` to run as its own bare
  shell/tool command so the installed `Bash(tenjin publish:*)` prefix permission
  can recognize it.

- 21ce314: Remove the MIT license grant. The LICENSE file is deleted with no replacement, the `license` field is dropped from package.json, and the README/NOTICE MIT claims are removed. Third-party attributions in NOTICE.md are unchanged.
- 86e17da: A live status line names each lookup while it runs: `routing`, then the provider
  endpoint actually called with its bounded, redacted parameters, then the outcome
  and the price. `tenjin install` registers `tenjin status-line` as Claude Code's
  status line when that key is free; a status line you already set is never
  replaced, and `--status-line compose` appends ours to it.
- 717e693: Publish-safety scan hardening. Twenty new detectors, and the rule corpus moves
  out of code into `src/lib/scan-rules.json` as data (detector id, tier, pattern,
  description, attribution) so the same corpus can be enforced server-side.

  Block tier: BIP-39 seed phrases (twelve or more consecutive wordlist words) and
  `otpauth://` TOTP URIs close the wallet-shaped gap a hex-key-only scanner had;
  OpenSSH private keys pasted without PEM framing; and Supabase, Twilio, SendGrid,
  Hugging Face, Vercel, Notion, Linear, Figma, GitLab, Docker Hub, Cloudflare, and
  Databricks token shapes. Warn tier: RFC1918/loopback endpoints, collaboration
  workspace links (Google Docs/Drive, Notion, Figma, Slack archives, Linear,
  Jira), cloud resource ids (AWS ARNs, GCP resource names, Azure subscription
  paths, bucket URIs), pasted `.env` blocks, and a generic Shannon-entropy
  catch-all for unknown credential formats.

  Placeholder suppression drops docs-shaped matches (`sk-xxxx`, `<YOUR_KEY>`,
  `user@example.com`) before they reach the findings list, so a documentation
  sample cannot teach an operator to skim findings. Warn tier only: the block tier
  stays non-bypassable, and its own suppressions are anchored to the captured
  secret value rather than matched as a substring, so a live password containing
  `<`, `>`, `{`, `}` or an `x` run still blocks.

  The `raw-private-key` to `hex32-value` demotion widens, so quoting a public
  32-byte value no longer refuses a publish: the label set gains `salt`, `id`,
  `topic`, `root`, `digest`, and `commitment`; a label may now sit up to two short
  tokens before the value, across markdown and quote punctuation, so the inline-code
  form prose actually uses is covered; and well-known public constants such as the
  ERC-20 `Transfer` event topic0 are recognized from a data list. Only the
  separators loosened, never what counts as a label. Demotion is to warn only, an
  unlabeled bare 64-hex still blocks, a secret-named assignment still blocks however
  it is formatted, and a real key mislabeled `hash` still surfaces for review.

  A labeled fixture corpus (`src/lib/scan-corpus.json`, positives and benign
  lookalikes for every detector, plus an adversarial transcript-shaped sample)
  holds per-detector precision and recall at 1.0 in CI, so a detector edit shows
  its false-positive cost. The same suite enforces the redaction invariant — a
  finding carries a detector id, a tier, offsets, and a masked excerpt, never the
  matched secret — and a ReDoS budget against transcript-scale input, which caught
  and fixed four quadratic paths (`email`, `internal-hostname`,
  `db-connection-uri`, and the hash-label lookback).

- 97424b5: Let team-shelf capture ask once after bounded, content-free root repository activity, and give captured repo findings a retrievable, privacy-safe snapshot brief.
- c771484: The SessionStart primer now has a team-mode wording, chosen at run time from the config the hook reads: the public paragraph told a team machine to skip private-repo questions and warned that a hit costs cents, which points away from exactly what a team shelf holds, while the team one asks for questions about this codebase, its services and its past decisions. Both paragraphs are shorter (555 to 375 characters public, 441 to 379 team) and both keep the sentence that carries Tenjin into a research or subagent prompt. Neither warns the agent that its question may travel to the public marketplace on a team miss: an agent warned about its own question sentence hedges it, and a hedged sentence is a worse query against both shelves. The team capture ask lists "a decision and why" among the things worth publishing again, alongside the conclusion-first finding and the durable code map, matching the team criteria the sidecar design already states.

## 0.1.0-alpha.15

### Minor Changes

- 18385e4: Add a working native Hermes Agent integration. `tenjin install --harness hermes`
  now installs the Tenjin skills, adds a conservative MCP entry, and enables a
  stdlib-only Hermes plugin that checks Tenjin before `web_search`, attaches a hit
  to that tool's result, and surfaces unresolved searches through
  `transform_llm_output` for publish-back.

  Hermes reuses the same generated, bounded, fail-open retrieval/store/nag scripts
  as Claude Code instead of carrying a second payment-facing implementation. The
  installer honors an absolute `HERMES_HOME`, embeds absolute executable paths,
  preserves unsupported or user-owned YAML byte-for-byte, never overrides
  `plugins.disabled`, keeps automatic detection inert until explicit activation,
  and adds a warn-level doctor check. It adds no `TENJIN_HARNESS` policy selector
  and does not copy or couple wallet state.

  Hook consent and plugin activation are two separate decisions. `--no-hooks` and
  `--search-hooks off` withhold the Hermes scripts, plugin, and activation exactly
  as they withhold Claude's `settings.json` entries; the `mcp_servers.tenjin` entry
  is a server registration, so it is still written. Where the stored
  `hooks.searchMode` is what holds the plugin back, install and `tenjin doctor` say
  `tenjin config set hooks.searchMode auto` rather than an install command that
  cannot move the blocker. Withholding a write is not an uninstall, so install
  reports it as `skipped` and names any enabled plugin an earlier run left behind.

  Re-pointing the MCP entry (an nvm switch, a pnpm-vs-npm global) rewrites the
  managed block in place, leaving one marker comment and any neighbouring comments
  untouched. `tenjin doctor` tolerates a relative `HERMES_HOME` set for some other
  tool, reports a baked MCP command that no longer exists as stale rather than
  green, and shares the installer's classifier so its fix cannot point into a
  conflict it did not predict.

- ba09366: Close a batch of open search loops in one call, and let the WebSearch hook say
  which requests are its own.

  The hook now leads its `User-Agent` with `tenjin-websearch-hook/<version>`
  instead of the CLI product, so a query that rode along with a web search is
  separable from a question an agent deliberately looked up. Tenjin attributes a
  request to the first `User-Agent` product, so that position is the whole
  mechanism: it lands as `client_name` on the search row, and the marketplace's
  /trending questions tier filters on that exact name rather than showing readers
  queries nobody vetted. A deliberate `tenjin search` is unchanged and still
  identifies as `tenjin-cli`. The caller handoff still composes behind whichever
  product leads. `tenjin install` rewrites the hook scripts.

  `tenjin outcome --search-id` now repeats, reporting one status against every id
  named, and `--all-open` closes this session's open hook loops. Both report per
  id in the JSON envelope, and both refuse the whole batch before sending anything
  if one target's id or status could not be right. A batch that closed some and
  failed others says exactly which.

  The sweep is per session because the loop is: a session's open loops are its
  own, and one that ends leaves its unpublished debt to decay rather than handing
  it to whichever session stops next. The session comes from `TENJIN_SESSION_ID`,
  then `CLAUDE_CODE_SESSION_ID`, the same resolver `search` stamps entries with,
  and an entry no harness could attribute stays in scope everywhere rather than
  nowhere. There is no machine-wide sweep.

  `--all-open` reports `regenerated` and nothing else, and sweeps MISSes only. The
  other statuses are claims about what a specific search did for the agent, and a
  blanket `used` over queries nobody examined one by one is attribution the
  marketplace would be right to trust and wrong to believe. A hook search Tenjin
  answered is left alone for the same reason one step further in: that is the
  search where a piece may have been bought and read, and `regenerated` would
  overwrite the only positive attribution the loop collects. Deliberate searches
  are never swept. Both kinds are counted and named in the output, so a blanket
  close cannot look more complete than it is.

  A batch stops at the first rate limit or transport failure and reports the rest
  untouched, rather than spending an agent's outcome budget on requests that will
  fail the same way: an open loop is the safe state, and the Stop hook raises it
  again.

  The Stop hook's end-of-turn reminder now names ONE close command for the whole
  batch of hook misses instead of a per-id one. Seventeen open loops meant
  seventeen `outcome` calls, which is enough friction that the honest close stops
  happening at all.

- 01daf8b: Search now speaks schemaVersion 3 to `POST /api/search` with
  `view: "decision"`. `POST /api/agent/search` is a deprecated alias that answers
  410 after one deprecation window (BackTrackCo/tenjin#137), so nothing in the CLI
  still calls it: not `tenjin search`, not the MCP `tenjin_search` tool, and not
  the WebSearch/dispatch hook scripts `tenjin install` writes.

  The v3 request is not the v2 request with a new path. `question` becomes the
  documented `query`, `view` is named explicitly rather than left to the server
  default, and `freshWithin`/`maxPrice`/`appliesTo` move under a nested `filters`
  object. That nesting matters: the v3 route STRIPS an unknown top-level key into
  a non-fatal `warnings` array instead of rejecting it, so a top-level `maxPrice`
  would have run the search unfiltered with no error anywhere.

  The response envelope changed with it. `decision` + `candidates[]` became
  `matched` + `items[]`, and the MISS `browse[]` tail is gone — the decision view
  draws no fallback shelf, so a miss is an empty result plus a `hint` pointing at
  `GET /api/articles`. `--json` carries the server's envelope verbatim, so an
  agent parsing `decision` or `candidates` must move to `matched` and `items`. The
  local search store keeps its CANDIDATES/MISS vocabulary, because `tenjin
outcome` branches on it and older entries carry it; it is derived from whether
  anything matched rather than read off a field that no longer exists.

  `tenjin doctor`'s search-contract probe looks for `/api/search` in the
  deployment's OpenAPI paths. A deploy advertising only the alias now warns, which
  is the case the probe exists for.

- e91f3eb: Two new harness hooks, so an agent looks before it researches rather than after.

  **A SessionStart primer.** `install` now writes `~/.tenjin/hooks/tenjin-sessionstart.mjs`
  and registers it for `startup`, `clear` and `compact`. It prints one paragraph:
  what Tenjin is, the entry gate (public, durable, costly to reproduce), the
  instruction to state the question in one line and search first, the reminder to
  name Tenjin when enumerating research sources for a subagent, and what to skip.
  It makes no network call and reads no state. Nothing else may join it — no update
  line, no publish nudge, no open-loop summary — because the measured bottleneck is
  the retrieval reflex, and a paragraph that grows stops being read. `tenjin config
set hooks.sessionPrimer off` silences it at run time with no re-install.

  **A research-dispatch hook.** `~/.tenjin/hooks/tenjin-dispatch.mjs` fires on
  `PreToolUse` for `Agent|Task`, the two names one subagent dispatch goes by across
  Claude Code versions. The WebSearch hook only ever saw a question the agent had
  already decided to ask the web; the expensive research is the work it delegates to
  a subagent, and this rides along with that. It sends the dispatch's description
  plus at most 400 characters of its prompt — a privacy bound, not a display one —
  and on a CANDIDATES decision mentions at most two tested answers in the WebSearch
  hook's own format, in the parent's context only, since the tool input is already
  formed by then. It shares that hook's whole boundary: no `permissionDecision`, a
  2s fetch budget under the harness's 5s kill, and a silent exit 0 on every failure.
  `hooks.searchMode` governs it, so `off` and `remind` behave as they do for web
  searches, and the disclosure at install time now names the subagent prompt and its
  400-character bound.

  **Two bounds on a fan-out.** The same question is asked once per session, because
  a fan-out dispatches near-identical prompts and the answer is already in the
  store, and a session gets at most 10 dispatch lookups however wide it fans out, so
  a ten-way research turn cannot put the fetch budget in front of every subagent.
  Nothing fires on a `WebFetch`.

  Dispatches record into the CLI's own `searches.json` under a new `dispatch-hook`
  source, so a HIT still attributes a later purchase and `buy <resourceId>` still
  resolves the read URL. They are never nag material: the Stop hook's strong arm
  stays `cli`-only and its weak arm stays `websearch-hook`-only, an entry from any
  other source is skipped unnagged rather than promoted, and `outcome --last` skips
  them for the same reason it already skipped web-search entries. Because nothing
  ever closes one, they also hold at most 15 of the store's 50 slots: a demand entry
  is telemetry, and the store's other two jobs are resolving a payable read URL and
  finding the last deliberate search, so a wide fan-out must not be able to drain
  either.

  `install` discloses both hooks and what leaves the machine, `uninstall` removes
  both scripts and both entries, and the wiring stays idempotent: each script owns
  exactly one settings.json entry, which is why the dispatch hook takes one
  alternation matcher rather than an entry per tool.

- 014932a: `tenjin pay`, `tenjin discover`, and the `bazaarPay` toggle: the standard x402
  client verb, for every paid endpoint instead of only marketplace pieces.

  `tenjin pay <url> [-X GET|POST] [-d <json>] [--max-price <usd>] [--yes]` probes,
  delivers a 2xx free, and pays a 402 through the same money gates as `buy`
  (spend policy, price cap, session budget, confirm; `--yes` clears only the
  confirm), signing with `buildExactPayment`'s existing exact-scheme,
  canonical-USDC-on-Base pin; the deny/confirm/release ceremony itself is now one
  shared gate (`lib/spend-gate`) both `buy` and `pay` run, so the two verbs
  cannot drift. When the 402 advertises the standard sign-in-with-x extension,
  `pay` runs the same sequence as `buy`: one SIWX re-check bound to the TARGET
  origin (never the configured deployment's, so nothing origin-bound can leak),
  an entitled wallet re-reads free, and an unentitled one pays the fresh
  challenge with the same price-bump refusal as `buy`. Redirects fail closed on
  both legs, and there is deliberately no library dedupe: every paid call pays,
  and the session budget and `--max-price` are the brakes. The configured base
  URL is always payable, which covers Tenjin's paid `/api/answer` and
  `/api/phone-lookup` today and every future paid route without a CLI release.

  Any other https origin is the Bazaar lane, off by default. It opens only when
  the operator turns the new `bazaarPay` config key on (`tenjin install` asks
  once, default no, both answers remembered; headless installs never enable it)
  AND a configured registry (`bazaarRegistries`, default CDP's Bazaar and
  UltraVioleta, both verified keyless) publicly lists the exact resource with
  terms the live 402 does not exceed: same scheme, network, asset, and payTo,
  live amount at most the advertised one, looked up by the live payTo so a
  tampered 402 finds nothing. A mismatch is the new `REGISTRY_MISMATCH` refusal
  (exit 3) before anything is signed; unreachable registries fail the lane
  closed. This is provenance, not endorsement: listings are settlement-derived
  and unvetted, and the spend policy still bounds the money.

  `tenjin discover [query]` lists or searches those registries via the SDK's own
  bazaar client: free, keyless, wallet-untouched, available with the toggle off
  (a stderr hint says the lane is off), MCP-type listings counted but not shown.

  The lane's teaching is a new OPTIONAL skill, `tenjin-pay`, and PRESENCE is the
  whole mechanism: the skill is on disk exactly while the toggle is on, so an
  agent is never taught a lane the operator turned off. `install` places or
  removes it after the decisions, `config set bazaarPay` converges every wired
  skills directory immediately, the self-heal keeps a present copy current,
  doctor compares it when present and never requires it, and `uninstall` removes
  it. No conditional content and no markers: the unit of consent stays the one
  the pipeline already has, a skill directory. `tenjin pay` joins the opt-in
  permission tier beside `buy`, with the same never-a-spend-grant caveats.

### Patch Changes

- Replace the hand-maintained `HOOK_SCRIPT_VERSION` counter and its pinned script
  digests with a `tenjin-cli/<version>` header stamp. The installer already
  rewrites a hook whose bytes on disk differ from what the build would write, so
  the counter guarded nothing, and the digest pin failed on every release PR
  because the generated scripts embed the package version.
- 9ec8da8: Treat the deployment's known origins as one deployment, so the `tenjin.sh`
  cutover (tenjin#402) does not break an installed CLI.

  The server builds search candidate URLs from its own global, not from the request
  host, so the moment that global flips, every candidate arrives on the new origin
  while a configured `baseUrl` still names the old one. `assertOnBaseOrigin` then
  refused the whole response with `CONTRACT_MISMATCH`, taking `search`, `read`,
  `buy`, and `inspect` down together. `src/lib/production-origin.ts` now carries
  the deployment's origin set and `isSameDeployment`, which `assertOnBaseOrigin`,
  the `pay` lane, and the generated WebSearch hook all consult.

  The check is not loosened. Aliasing applies only when the configured base is
  itself one of the deployment's origins: a self-hosted, preview, or localhost
  `baseUrl` keeps the exact comparison it has today, a differing scheme or port is
  still a different origin, and any origin outside the set is refused with the same
  code, the same message, and the same fix line, which still never coaches
  re-pointing the CLI at the URL that just failed.

  `PRODUCTION_ORIGIN` does not move here; the shipped default flips in a later
  release. Stored config is not rewritten, so nothing an operator set is touched.
  `HOOK_SCRIPT_VERSION` moves to 19 because the generated hook body changed; the
  installer rewrites hooks on the next `tenjin install`.

- aa6ff29: Rename `hooks.searchMode` → `hooks.webSearch` and `hooks.dispatchMode` → `hooks.agentDispatch`, both `auto|remind|off` disjoint defaults `auto`. `hooks.searchMode` (shipped in `alpha.14`) still reads as `hooks.webSearch` for one release and a legacy `off`/`remind` correctly carries to `agentDispatch` so an existing opt-out doesn't re-enable dispatch after upgrade; `hooks.dispatchMode` (including `inherit`) never shipped to npm and is kept only as a read alias for unreleased `main` testers. `HOOK_SCRIPT_VERSION 22->23`. Replaces the `hooks-dispatch-mode` changeset which described the now-removed `inherit` semantics.
- e0eff8b: Read the production Tenjin origin from one constant, `PRODUCTION_ORIGIN` in
  `src/lib/production-origin.ts`.

  The shipped `baseUrl` default, the generated WebSearch hook's fallback, the
  `User-Agent` comment, the pinned `fund` origin, the `config set` URL hint, the
  install hook copy, and the hosted-skill replacement warning all derived their own
  copy of `https://tenjin.blog`. They now import it, so no shipped string can be
  left behind by a partly-applied sweep.

  The cutover is not a single edit. Shipped code reads the constant, but three
  places deliberately do not: `fund.test.ts` and `client-meta.test.ts` each keep
  their own written-out copy, so re-pointing the wallet-signed `fund` mint or the
  `User-Agent` costs two files in one PR, and `package.json`'s `homepage` is JSON
  that cannot import. All three are pinned, so the flip commit reds until each is
  edited on purpose.

  No behavior changes: every string those call sites emit is byte-identical, the
  generated hook scripts hash the same (so `HOOK_SCRIPT_VERSION` does not move and
  no installed hook is rewritten), and dual-serve semantics are untouched.
  `fund` keeps its hardcoded production origin with no override surface.

  `production-origin.test.ts` is the anti-half-flip guard: it pins each of those
  modules to the constant, pins the two skill-mirror scripts (which run outside the
  bundle and cannot import it) to the same origin, and sweeps `src/` for any
  non-comment line that spells the host out. The sweep is advisory, an
  honest-mistake catcher rather than a boundary: it reads raw lines, so a host
  assembled at runtime walks past it.

- 384006c: One piece can now claim every search it answered.

  `tenjin publish --search-id` repeats, up to ten searches per piece. A research
  thread fans out into many searchIds — one investigation last month logged ten
  MISSes for what was a single question — and until now the piece published back
  against one of them while the other nine were closed one at a time as
  `regenerated`. That was false twice over: they were not re-derived, they were
  answered by the same piece, and MISS-to-publish conversion counted every sibling
  of the thread as a failure.

  Every named id closes its own local loop with publish attribution, re-linking one
  an `outcome` already closed exactly as a single id does today, and the JSON
  envelope reports each id separately (`searches`), so an id this machine has never
  recorded warns for itself instead of taking the rest down with it. A lone id
  keeps the flat `search` field callers already read. Repeats collapse. A `--draft`
  still answers nobody and sends no attribution at all.

  Before anything is signed, any named search this machine has no record of is
  warned about by id. Tenjin accepts or refuses the named searches as one batch, so
  a single id it cannot match refuses the whole publish, and that refusal used to
  arrive only after the wallet had signed.

  On the wire, one id ships as the bare string it has always been, so a
  single-search publish is byte-identical to what shipped before; several ship as
  an array, which the live post-create takes.

## 0.1.0-alpha.14

### Minor Changes

- 6b960e1: Let the agent that runs the CLI travel in the same `User-Agent` field, behind the
  `tenjin-cli` product: export `TENJIN_CALLER_USER_AGENT` when you launch it.

  Composition happens in one place (`composeUserAgent` in `lib/client-meta.ts`) and
  is idempotent: the caller value is decomposed into products, any copy of our own
  product or comment is dropped from it, and the field is rebuilt from the package
  identity. A retry, a nested helper, or an agent re-exporting the env it received
  therefore cannot mint a second `tenjin-cli` token, and the caller's own products
  survive byte for byte in their original order. The write still runs through the
  Headers API, so a call-specific `User-Agent` in any casing cannot erase the
  composed field or add a second one.

  The handoff accepts a product sequence and nothing else, which is what keeps a
  user, wallet, session, hostname, or machine identifier structurally out of it. A
  value that is not printable ASCII, not a bare product sequence, or long enough to
  push the composed field past the 512 characters the server accepts is omitted
  whole: the CLI identity travels alone rather than as a truncated token that would
  read as a different client. It is self-reported telemetry, never trusted policy
  input, and no signed header set changes: the payment and RFC 9421 signatures
  cover the same material they did before.

  The generated WebSearch hook script carries the identity too. It is the CLI's
  highest-volume request path and it imports nothing, so it had been sending Node's
  default `User-Agent: node` and every hook-driven search was landing as a
  synthetic client named `node` that was in fact this CLI. It now composes the same
  field, from constants interpolated out of `lib/client-meta.ts` at generation time
  and the caller handoff read at run time, with a test that runs the shipped bytes
  and the real composer over the same inputs so the two cannot drift. Because the
  version is baked when the script is written, an installed hook keeps reporting
  the version that wrote it until `tenjin install` is re-run: `tenjin update`
  replaces the binary and leaves hook scripts alone.

- 77244fd: Publish-back loop DX (tenjin-agent#161, #162), plus a skill diet.

  The Stop hook's weak arm now fires at most once per session. A research fan-out
  mints new searchIds every turn, so per-searchId dedupe never rate-limited it and
  the batch read as harness debug output. `hooks.stopNag` gains `deliberate-only`,
  which drops that arm and keeps the deliberate-search one, so silencing the noise
  is no longer the cliff `off` is. Whatever the hook raises now leads with the
  resolved publish.mode, which an agent otherwise had to run `tenjin config get`
  mid-publish to discover. That line resolves the mode in the CLI's own order,
  global config then a project `.tenjin.json` found by walking up from the session's
  cwd then `TENJIN_PUBLISH_MODE`, so the hook, `publish`, and `doctor` agree on what
  the next publish in that directory will actually run under. That walk stops where
  the CLI's stops: at the repo root, never above `$HOME`, and skipping a
  `.tenjin.json` owned by another user. A project `full-auto` conservatively reads
  as `auto`.

  `tenjin publish --search-id <id>` re-links a loop something else already closed,
  so a MISS closed as `regenerated` while the answer was still being written can
  still be attributed to the piece that answered it. A repeat publish against a
  loop an earlier publish already closed now says so instead of reporting a fresh
  close it did not make.

  `tenjin publish --search-id <id>` now sends that id to the server, which accepts
  and documents it as the attribution for the MISS the piece answers. It never
  reached the wire before, so every publish that named a search still went out
  unlinked, the thing #161 is actually about. The id is validated at the command
  edge against the shape the server declares rather than the CLI's looser uuid, so
  a bad one costs a message instead of a 400 collected after the wallet signature.
  A `--draft` publish sends no attribution, matching the local ledger, which has
  always treated a draft as answering nobody.

  ## Installing Tenjin is the consent for auto-publishing

  Every install settles `publish.mode` at `auto` unless told otherwise, and the
  first install, headless included, writes the two mode-gated rules
  `Bash(tenjin publish:*)` and `Bash(tenjin edit:*)` alongside the nine free ones.
  The terminal says it in plain words, two lines and a link: what the agent will now
  do, how many rules are allowed, and the one command that turns it off. The
  complete disclosure (both rule strings, unattended keystore access, the read+write
  session credential minted on disk, publishing the contents of any local file the
  agent can read, the `--base-url` and `--yes` caveats, all three undos) is
  unchanged in docs/agent-permissions.md, in `tenjin doctor --json`, and in this
  command's own `--json` envelope.
  `edit` travels with `publish` because it runs the identical consent gate, touches
  only posts the wallet already owns, spends nothing, and creates no new public
  content; an auto mode that can publish a post unattended but cannot fix that
  post's price is the asymmetry the mode exists to remove.

  `tenjin config set publish.mode` syncs the pair at the moment the mode changes.
  Loosening to auto or full-auto asks once at a real terminal, naming both rules,
  and writes on yes; no terminal, `--json`, or a decline writes nothing and points
  at `tenjin install`. Tightening back to `review` retracts both unprompted through
  a retraction-only pass that never appends, so it retracts on any machine
  carrying them, including one whose free tier no longer matches what this release
  ships. `uninstall` reclaims both. The bare CLI, with no install ever run, still
  defaults to `review`.

  `tenjin install` and `tenjin config set` now preserve `~/.claude/settings.json`'s
  file mode, so a `chmod 600` on a file holding an `env` block survives a write.

  Every install line that reports the allowlist says what a `review` run took back,
  and names the file it took it from. The retraction runs above the guards that
  decline a write, so a run can retract and then skip, and two skip lines described
  the file as untouched: "unchanged" under `--no-allow-free-verbs`, and "not wired
  (Claude Code only)" under another `--harness`, which read as "your Claude settings
  were left alone" on the run that had just deleted two rules from them.

  Moving to `review` retracts on every install path. The retraction sat below the
  `--no-allow-free-verbs` and `--harness` guards, so a run that declined the free-verb
  WRITE also silently declined the REVOCATION: `install --publish-mode review
--no-allow-free-verbs` wrote `mode: review` and left both rules allowed. It also
  returned before the additive pass, so one review-install retracted the pair,
  claimed a free tier it had not written, and stranded a legacy rule for a second
  run to clear. It now runs first and falls through: one run retracts, wires the
  tier, and sweeps legacy rules, and the summary stops describing `publish` and
  `edit` as "commands that no longer exist".

  `tenjin doctor` resolves `publish.mode` from the project `.tenjin.json` like
  `config get` and `publish` do. It read the global file and env only, so inside a
  repo pinned to `review` under a global `auto` it reported the machine as needing a
  grant the next publish there would never use.

  The install prompts are shorter. The permissions question is two sentences and a
  link rather than a tier inventory, no prompt recites a `Bash(...)` rule an
  operator has not met yet, the search-hook question drops its "(Escape skips,
  registering nothing)" hint, and the summary no longer promises that "your harness
  still shows each command for approval", which the same mode writes a rule to
  remove.

  `tenjin search --json` no longer writes the publish-back hint to stderr. It went
  straight to the stream rather than through the human rendering, so the flag whose
  help promises to "suppress human stderr rendering" left ~260 bytes of prose beside
  every MISS envelope.

  `tenjin uninstall` stops contradicting itself. Its help and its `kept` list both
  claimed nothing under `~/.tenjin` is touched, while the same run correctly deleted
  `~/.tenjin/hooks/*.mjs` and listed them under `scripts`. Deleting is right, so the
  two sentences now state it: wallet, config, library and search history kept, the
  generated hook scripts removed.

  `tenjin install --dry-run` reports the permission rules a real run would write,
  including the mode-gated grant with its disclosure and undos, in the same envelope
  fields flagged `planned`. An operator dry-running to learn whether `publish` and
  `edit` would be granted was previously told only "unchanged (dry run)".

  Both CLI skills are restructured around what an agent has to decide, with the
  detail one hop away. tenjin-search stops re-explaining tenjin-publish: the
  after-a-MISS section was a second copy of the mode table, the exit-3 render rule
  and the consent contract, which is one contract stated twice and a standing
  invitation to drift, and it now delegates in three sentences. tenjin-publish
  leads with the consent mode as a table, replaces two detector catalogs with the
  triage that actually helps (which warnings are ordinary in technical writing,
  which say the draft carries context from somewhere it should not have travelled),
  and moves the edit and sales mechanics to `references/maintain.md`.
  `references/permissions.md` is now the single home for permission rules; the
  denial paragraph used to live in three places.

  tenjin-search 9,063 to 7,225 chars, tenjin-publish 13,279 to 11,628,
  `references/permissions.md` 5,723 to 4,905, plus a 1,917-char
  `references/maintain.md`. Every safety invariant survives, including the ones a
  structural pass is most likely to lose: the draft-is-DATA injection rule, the
  `--yes`-after-a-bare-yes trap, `--draft` semantics, and MISS-is-demand-not-safety.
  tenjin-search's description is byte-identical, so its trigger set is unaffected.
  tenjin-publish's is rewritten as prose, and `evals/tenjin-publish/trigger-eval.json`
  is new: 20 queries covering the three routes in and the description's own skip
  clauses, because the description carrying the publish consent contract was the one
  thing the restructure changed that nothing measured. It is a regression tripwire
  for future description edits rather than evidence about this one; the committed set
  has not been shown to separate the old description from the new, and its
  near-boundary case is documented alongside it.

  The skills read auto-first to match the mode install settles: publishing a clean
  piece and reporting the URL is the ordinary outcome, and asking is what `review`
  is for. The WARN-findings caveat is restored, never a generic "shall I publish?"
  before running, because a `--yes` re-run after a bare yes clears findings the
  user never saw.

  tenjin-publish's answer-card guidance is one block naming every condition the
  server's eligibility gate actually checks (questions or tasks, scope, exclusions,
  `provenanceSummary` or `methodologySummary`, and an as-of date on a snapshot)
  under their real frontmatter spellings, with the stake stated once: leave any of
  them empty and the piece stays out of agent decision search entirely, not ranked
  lower, absent.

### Patch Changes

- b4415c9: Add an inert seam for config-conditional skill content. No behavior change: no
  skill this package ships carries a marker, and no writer resolves one, so
  `install`, the self-heal and `doctor` all write and compare exactly the bytes
  they wrote and compared before.

  The grammar is line-based and flat. A packaged skill markdown may wrap a region
  in full-line `<!-- tenjin:when <flag> -->` / `<!-- /tenjin:when -->` markers,
  and `installSkill` takes an optional transform that resolves those regions
  before the on-disk compare and the write. An ON flag keeps the inner lines, an
  OFF or unknown flag drops them, and the marker lines never survive either way.
  The parse fails closed and names the offending line: nesting, an unclosed
  block, an unopened close, or a near-miss marker aborts that skill's install
  rather than writing a half-shaped copy. Non-markdown files pass through
  byte-for-byte.

  Wiring the first real flag is a bigger change than defining it. Four parties
  compare on-disk skill bytes against packaged bytes: `install`, the self-heal,
  `doctor`, and `scripts/pack-smoke.sh`. They agree today only because no marker
  ships, and a test pins that so the first marker added fails loudly instead of
  leaving a shaped skill and a raw comparison disagreeing forever. All four have
  to learn to materialize through one shared resolver in the same change.

- 9aa18ba: `tenjin update` and the daily update check read the `latest` dist-tag and nothing
  else, which is the one tag every publish moves. A `latest` this build cannot
  parse is now reported as that rather than as a missing package, since npm does
  have a build in that case and the fix is to install it by name, and it costs one
  registry request per day instead of one per command.

## 0.1.0-alpha.13

### Minor Changes

- a38f843: Self-update from the CLI, and tell agents when to use it.

  `tenjin update` installs the newest version npm offers this build, pinned to the
  exact version the registry names; `--check` only reports. The target is the
  newest of the build's own channel tag and `latest`, because which tag a publish
  lands on is a property of the release pipeline rather than of the version
  number: `alpha` sat on 0.1.0-alpha.7 while 0.1.0-alpha.8 through .11 shipped on
  `latest`, and a channel-only lookup would tell every alpha user they were
  current. The daily check resolves the same way, so the two cannot disagree.

  The manager that owns the install performs it: npm, pnpm, and bun are each
  driven with their own global-add command, since the PATH race that makes a
  second install dangerous comes from cross-manager writes rather than from asking
  the owner to do what it already owns. What cannot be driven is refused with the
  instruction that is correct there instead of writing a global you never had: a
  source checkout updates by git, an npx run has nothing installed to replace, a
  project-local copy updates where it is declared, and yarn is refused because
  `yarn global add` exists only in yarn 1. `--check` answers from all of them.

  The daily check now reaches agents, not just humans. Alongside the dim stderr
  line a TTY gets, a newer version appears as `updateAvailable` (with `current`
  and `latest`) on the JSON envelope and on the generated hook scripts' output, so
  the agent driving a command can run `tenjin update` itself at a moment it picks.
  Nothing installs on its own: a CLI that starts a fresh process per invocation
  has no deferred-activation window to hide a binary swap in, and a silent version
  swap reshapes output exactly where nobody is watching. New `update.mode` config
  key, `nudge` (default, all three surfaces) or `off` (none, and no request to
  npm). The field is read from the check's cache, so it costs no request and no
  delay on the command carrying it.

  Every install runs as a binary or `node <script>` and never through a shell,
  which is also the only form win32 can spawn, bounded by a 5 minute budget, from
  the home directory, with the manager's output sanitized before it reaches a
  terminal. `tenjin update` is documented as never-allowlisted for agents: it
  replaces the binary the agent then runs.

### Patch Changes

- dcc6b5a: tenjin-publish gains the harvest ask (tenjin-agent#145 item 2, redesigned):
  "anything from our recent work worth publishing?" now routes into the skill
  explicitly, with a sweep procedure — grade what is visible in the
  conversation against the sell rubric, offer survivors once as one batch, a no
  is final and never re-asked, and never dig through transcripts or archives
  the user did not hand over. This replaces the weekly scheduled-harvest design
  outright: an OS-level cron written during onboarding has no precedent and
  reads as intrusive, out-of-session runs create a session-archive dependency,
  and per-session nudge telemetry shows unprompted reminders do not convert.
  In-context, user-invoked, zero scheduling. One trigger clause added to the
  always-loaded description; the procedure lives in the body.

## 0.1.0-alpha.12

### Patch Changes

- a402916: Post outcome reports to `/api/searches/:id/outcomes`, the path the server now
  documents after BackTrackCo/tenjin#616 dropped the `/agent` prefix. The contract
  fixture and the live drift pin move with the client, so the scheduled
  contract-drift run goes green again.

  No fallback: tenjin serves the old `/api/agent/searches/:id/outcomes` spelling as
  a real alias onto the same handler for one deprecation window, so both spellings
  answer identically today and the pinned path is the one that survives the window.

- c315e09: Widen the supply/demand triggers (tenjin-agent#145 item 1) by restructuring
  both skill descriptions rather than appending to them, holding length at
  parity with the previous wording. tenjin-search now leads with both search
  moments: before regenerating expensive research, and before empirically
  probing a third-party library or platform's undocumented behavior; the skip
  list narrows from "the thing in front of you" to "your own code" and the two
  skip sentences merge into one. tenjin-publish reorganizes its triggers into
  three routes in (user ask, after-a-MISS, unprompted work worth selling), the
  unprompted route covering substantial research and empirical proofs the docs
  don't state. Two bundled fixes surfaced by the eval work: the requires-CLI
  sentence becomes an explicit stand-down ("does not apply and must not fire,
  not even to route the question"), taking the pre-existing no-CLI defer red
  from 1/4 on main's wording to 2/4 in two independent samples; and preflight's
  mirror-drift check now only gates runs that install the vendored tenjin
  mirror, so non-mirror skill evals no longer need --no-preflight during #88.
  Clean-room results: trigger eval extended 20 to 22 cases (one per side of the
  new probe boundary) and scores 22/22 under the final wording, in-sample as
  with the previous tuning. The two defer queries still firing both carry an
  explicit user directive to use Tenjin while this skill is the only Tenjin
  skill installed in the eval room; that residual is documented on the PR
  rather than fought with more description weight.

## 0.1.0-alpha.11

### Minor Changes

- 62c2c25: Card-fund the wallet from the terminal. `tenjin fund [amountUsd]` signs a SIWX
  proof with the wallet's own key, asks the Tenjin backend to mint a Coinbase
  Onramp checkout URL for that same address, prints it, opens it in the default
  browser, and polls the Base USDC balance until the purchase lands (`--no-open`
  and `--no-wait` opt out). The link is single-use, expires in about five
  minutes, is bound to this machine's network, and requires a Coinbase account
  to complete; only `https://pay.coinbase.com` URLs are ever opened. A matching
  `tenjin_fund` MCP tool mints the link and returns it for the agent to hand to
  the human (no browser open, no poll; minting moves no money and the payment
  itself happens on Coinbase's authenticated page). `send` stays off MCP.

  The link goes to stderr the moment it is minted, on every surface, because the
  stdout envelope that also carries it is written only after the poll and the link
  does not live that long. Opening a browser and polling are interactive
  behaviours: both default off when stdout is not a TTY, so a piped, `--json`, or
  MCP run returns as soon as the link exists. `pollStatus` on the envelope
  distinguishes `skipped`, `unavailable`, `timed-out` and `arrived` instead of
  collapsing three of them into `funded: false`. `tenjin fund` is never
  allowlisted for Bash: a prefix rule would clear `--base-url` with it, which the
  MCP tool's amount-only input does not.

- 5e1148e: Remove the candidate pen. Implements #133.

  A publish decision is made once. Parking a draft "for later" turned that into a
  backlog nobody returned to, and the reminder that would have resurfaced it is the
  repeat-nag class this CLI stopped emitting — so rather than warn about the pen for
  a release, it is gone now, in the same release as the skills that stopped teaching
  it.

  Removed: `tenjin candidate add`, `list`, and `drop`; the `tenjin publish
--candidate` path; the local candidate store; the `tenjin_candidate` MCP tool;
  and the `Bash(tenjin candidate list:*)` line from the recommended free-verb
  allowlist, which is now eight rules rather than nine. If an earlier version wrote
  that rule into your `~/.claude/settings.json`, the next `tenjin install` removes
  it and says so: a grant for a command that no longer exists is bloat we created,
  so clearing it is our job rather than yours. `tenjin uninstall` reclaims it too.
  Nothing else in that file is touched — rules you added yourself, other keys, and
  their order all survive.

  The Stop hook's open-loop reminder and the MISS `publishBack` hint keep the shape
  they took when parking was deprecated: publish it back, or close the loop with
  `tenjin outcome --search-id <id> --status regenerated`. Nothing is saved to come
  back to, and the outcome report is what marks the search resolved so the reminder
  never raises it again.

  **Anything already in `~/.tenjin/candidates/` is left exactly where it is.** It is
  your content, so nothing deletes it and `tenjin uninstall` will not either — but
  nothing reads it any more, so a draft you want is a file to open at
  `~/.tenjin/candidates/<id>/draft.md` and publish with `tenjin publish <file.md>`.
  The `candidate` resolution value stays parseable in the search ledger so an older
  `searches.json` still loads; nothing writes it now.

- 5cc75d2: Make the MISS → publish loop closable on the path agents actually take. Until now
  only `tenjin publish --candidate <id>` could name the search it answered, so the
  bare file publish that both the Stop hook and the auto-mode skill prescribe left
  the search open in the local store and the reminder kept firing at work that was
  already on the marketplace. `tenjin publish <file.md> --search-id <id>` now closes
  it, and prefills the searched question into the answer card's `questionsAnswered`
  when neither `--question` nor the draft's frontmatter names one — that phrasing is
  what the next searcher sends, so it is the right fallback. The prefill is dropped
  rather than truncated when the stored question runs past the card's 200-character
  item bound, because a prefill nobody asked for must not fail a publish that was
  otherwise fine. `--search-id` with `--candidate` is a usage error (the candidate
  already carries its own searchId), a malformed id refuses before any wallet touch,
  and an id the local store does not know still publishes and says so. What happened
  is reported in both registers: a stderr line for a human, and a
  `search: { id, closed, prefill }` field on the JSON receipt, because `--json`
  suppresses the stderr notes and an agent that named a search could otherwise not
  tell a closed loop from an open one, nor learn that its question was too long to
  become a card entry. `closed` reports the OUTCOME of the local write rather than
  the intent to make it: the store update is best-effort and never throws, so a
  lock it could not take comes back as `closed: false` and a line naming the
  command that closes the loop by hand.

  A `--draft` now parks privately on BOTH paths and closes nothing. It leaves the
  named search open, and — this is a behavior change — it also leaves a
  `--candidate` draft parked instead of clearing it. A draft answered nobody, so it
  is not the publish that retires the pen entry; the later real publish is. The
  receipt reports `cleared: false` with no `warning`, which is how a deliberate hold
  reads against a clear that failed.

  Every surface that hands you the closing command now hands you a complete one. A
  MISS's `publishBack` payload emitted `tenjin publish <file.md> --json` beside a
  `park` line that already carried the id, so the arm the agent was most likely to
  copy was the one that closed nothing; both arms, and the stderr line beside them,
  now name the searchId.

  The Stop hook's open-loop reminder is reworded to match. It named a flag that did
  not exist (`tenjin publish, searchId <id>`) and it carried no safety qualifier, so
  it nagged just as hard on a question about private infrastructure as on a durable
  public finding. It now emits the real command and conditions the publish arm on
  the finding being public, reusable and rights-clean, with parking as the other
  arm. The batched line for WebSearch-hook misses gets the same command syntax.

  **The reminder is now scoped to the session that opened the loop.** The search
  ledger is machine-global, so the Stop hook was raising whichever open MISSes it
  found at whatever session happened to stop next, including a sibling session's
  work that this one never did and cannot close. A stored search now carries an
  optional `sessionId`, and the Stop hook parses the `session_id` its turn-end
  payload already carries and skips entries stamped with a different one — without
  marking them nagged, so the session that owns a loop still gets its single
  reminder. The scoping is deliberately one-directional: an entry nothing could
  attribute is still raised in every session, so a loop can never go invisible in
  all of them at once, and a payload that is malformed or names no session falls
  back to exactly the old machine-global behavior.

  Both recorders stamp. The WebSearch hook reads the `session_id` the harness puts
  on its stdin, and a deliberate `tenjin search` reads the same value from
  `CLAUDE_CODE_SESSION_ID`, which Claude Code exports to Bash tool subprocesses, so
  a CLI search and a hook search in one session carry the same stamp.
  `TENJIN_SESSION_ID` overrides it for anyone wiring this up by hand. On a harness
  that exports neither, a search records no session rather than guessing one, and
  falls back to being raised everywhere.

  **`tenjin publish --excerpt` sets the public preview.** The excerpt is what every
  non-buyer reads — the 402 preview, the directory feed, search results, RSS, the
  social card — and the server only derives it from the body's leading prose when
  the client sends none. Frontmatter `excerpt:` already reached the wire; the flag
  did not exist, so the one-shot path an agent actually uses had no way to say what
  a stranger sees, and a piece whose answer sat too high leaked its verdict for
  free. `--excerpt` wins over frontmatter, both are refused over the server's
  500-character bound rather than truncated (a silently cut preview is a different
  preview), and the refusal now happens at the command's edge instead of inside the
  request builder, so it costs a message rather than a keystore unlock.

  Every free-text field that ships is stripped of control bytes, escape sequences
  and bidi overrides. None of it is necessarily typed by the person publishing: a
  card question can be prefilled from a stored search, and the title, excerpt,
  tags and every card field can arrive over MCP from an agent that read them off a
  fetched page. `trim()` removes neither a CSI sequence nor a right-to-left
  override, so without this a payload rides into the marketplace and renders in
  every future reader's terminal. The strip lives in the two request builders that
  `publish` and `edit` share, so it covers both commands and both MCP tools by
  construction rather than by each flag remembering, and it runs before the length
  bounds, since the stripped text is what the bound has to describe. The post BODY
  is deliberately left alone: that is the author's own markdown, and rewriting it
  is a content change nobody asked for. Ordinary unicode, including emoji ZWJ
  sequences, is untouched.

  The MCP `tenjin_publish` tool now forwards `searchId` and `excerpt` to the
  command core. The tool advertised both, because the input schema is type-checked
  against the argument type, but the handler that builds the call never passed
  them, so an agent setting either over MCP had it silently dropped.

  **Two smaller fixes on the same loop.** `tenjin install` now says to restart
  Claude Code when it wires the hooks: harness hooks are read once at session
  start, so an operator who does not restart gets no hook activity at all and
  nothing telling them why. And `tenjin doctor` stops warning about an expired
  session key. A delegation lives 24 hours by construction, so a spent one is
  designed decay, not a fault, and warning on it left a permanent yellow on any
  machine that had ever run `tenjin session start`. Expiry and a scope that does
  not cover reading now report `ok` and name the verb that re-mints, the same
  posture an absent or pre-origin cache already had. A file whose expiry cannot be
  parsed is a different thing and still warns.

  The `tenjin-publish` skill's draft rules now say where the free/paid fold falls: a
  piece whose Answer section sat too high leaked its verdict into the public
  excerpt, so the rule names the first ~500 characters as the excerpt and puts the
  as-of date, versions and questions answered above the verdict.

- 00fd79e: Take the CLAUDE.md footprint to zero, and give `install` a real reverse.

  `tenjin install` no longer writes its pointer line into `~/.claude/CLAUDE.md` or
  `AGENTS.md`. A harness loads every skill's frontmatter description at session
  start and that is already the trigger surface, so the line was duplicating the
  `tenjin-search` description into a file the operator writes their own notes in —
  a footprint none of the tools people compare us to leave, and one the WebSearch
  hook already covers deterministically. An install that finds an old line now
  removes it and says which file it cleaned, so the cleanup reaches existing
  machines through the command people already re-run rather than one nobody knows
  to run. `--claude-md` and `--no-claude-md` still parse, hidden, as no-ops, so a
  pinned script or a released doc does not start failing on an unknown option.

  **`tenjin uninstall`** removes exactly what install wrote: the skills, the hook
  scripts, our hook entries and permission rules in the harness's settings.json,
  and any legacy pointer line. Every removal is gated on OWNERSHIP rather than
  path, reusing the rules the writers already use — a hook entry is ours when its
  command names one of our script filenames, a skill is ours when its frontmatter
  still claims our name, a rule is ours when it is one we wrote — so another tool's
  hook, someone else's skill at our path, and a rule you added yourself all survive,
  in their original positions. It removes the FILES it shipped rather than the
  directories they sit in: a note you left beside a SKILL.md survives, and keeps its
  directory, because a directory we only partly own is not ours to delete. It never touches the wallet, the config, the library,
  the search ledger, or parked candidates, and it prints that list on every run
  including the one that finds nothing: the boundary is the reassurance people are
  looking for when they reach for an uninstaller. Idempotent on a half-installed,
  already-uninstalled, or never-installed machine.

  Both halves of settings.json are edited in a single pass under one
  optimistic-concurrency check, rather than a pass for hooks and another for
  permissions: Claude Code writes that file too, and two whole-file
  read-modify-writes would be two chances to erase an edit that landed underneath
  the command.

### Patch Changes

- 177e413: Make `publish.mode` govern what happens to a finished draft, and make every
  publish decision ephemeral.

  Doubt is two judgments with different answers. Privacy and rights doubt — private
  context, third-party data, rights, competitor reconstruction — means do not
  publish; the skills no longer tell the agent to keep a copy anywhere. Quality
  doubt is the agent's own uncertainty about an unverified claim or a missing
  polish pass, and the resolved mode decides it: `review` was asking anyway, `auto`
  asks the user through the harness's own question or permission UI when it has one
  so the answer is a click rather than a prose reply, and `full-auto` hedges the
  claim honestly in the piece — named as unverified, with a date — and publishes.

  **A decision is ephemeral.** Nothing is saved in order to re-ask: a "no" is final,
  closes the loop with an outcome report, and is never raised again. The skills
  previously taught parking a draft in the candidate pen as the answer to almost
  every stop, which quietly turned "not now" into a backlog nobody returns to and
  made a withheld piece indistinguishable from work that never happened. Where a
  publish genuinely cannot proceed — a hard block, a permission denial, no wallet —
  the instruction is now to say so and leave the draft file where it is. The
  candidate verbs still exist in the CLI this release; the skills simply stop
  teaching them as a step.

  The `tenjin-publish` skill also gains a third trigger, in its description and its
  body: finishing substantial research that is public, durable, and reusable — a
  multi-source synthesis, a tested comparison, a runbook — is worth offering to
  publish once, routed by the same mode, even when no search preceded it. Drive-by
  "we should write this up sometime" musing stays excluded, as it already was.

  The mode is resolved per run, so `tenjin config set publish.mode <mode>` changes
  this behavior on the next command with nothing to re-install and no session to
  restart.

## 0.1.0-alpha.10

### Minor Changes

- a188098: Close the adoption loop: make a bare `tenjin install` produce a machine that
  actually uses Tenjin, and make an unanswered question visible until it is
  answered.

  **Install is usable by default, non-interactively.** A run with nobody to ask now
  wires the nine free-verb rules into `~/.claude/settings.json` instead of skipping
  them. The machine most likely to be denied mid-task is the headless one, and a
  grant nobody could consent to was the reason a headless install produced a CLI
  that stopped at the first permission prompt. `--no-allow-free-verbs` opts out,
  `--allow-free-verbs` states the default explicitly, and every run that writes
  reports how many rules landed, in which file, and that deleting those lines undoes
  it. The grant itself is unchanged: a fixed free tier that cannot spend, cannot
  open the keystore, and cannot widen. Two reporting defects go with it. A headless
  re-run against an already-permissioned home reported `added: []` and
  `alreadyPresent: []` whatever the file held, because it short-circuited before the
  probe; it now reports what is actually there. And every skipped permissions state
  carries a `fix` string naming the exact command, the same contract a `CliError`
  carries, so a machine consumer reads the remedy as a field.

  **A wallet is created by default, on both paths.** `buy` and publishing back
  after a MISS both need a key, so a walletless install is a setup that stops at
  the first useful thing an agent tries. Headless runs create one without asking,
  using the passphrase policy the CLI already enforces everywhere else: an explicit
  `TENJIN_WALLET_PASSPHRASE`, else a strong generated passphrase written to the
  platform's OS credential store and verified by reading it back. With neither
  available it creates NOTHING and reports
  `wallet: { "status": "skipped", "reason": "no-passphrase-store", "fix": ... }`
  naming both remedies. There is deliberately no plain-file fallback: a passphrase
  stored beside the keystore it unlocks protects nothing, and an install is not the
  place to invent one. A wallet that cannot be created never fails the install, and
  the output discloses the address, that it holds $0, that funding is a human step,
  and where the encrypted key lives. `--no-wallet` opts out, an interactive run
  still asks and still defaults to yes, and answering no (`"declined"`) stays
  distinguishable from a skip.

  **Two harness hooks, installed and disclosed.** `tenjin install` writes two
  standalone Node scripts to `~/.tenjin/hooks/` and registers them in
  `~/.claude/settings.json`. A `PreToolUse` hook matched to `WebSearch` (never
  `WebFetch`) asks the marketplace the same question the agent is about to ask the
  web, on a ~2s design budget (the hard bound is the harness's own 5s kill), and
  mentions a tested answer with its price and
  a free `tenjin inspect` command when one exists. A `Stop` hook checks locally,
  with no network call, for a MISS from the last eight hours that nothing has closed
  and reminds you once per turn-end to publish it back. Both fail open by
  construction: they emit `additionalContext` and never a `permissionDecision`, so
  neither can block, deny, or modify a tool call, and a miss, a timeout, a dead
  network, an unreadable config, or a response that fails validation all exit 0 with
  nothing on stdout. The response boundary DROPS rather than repairs: a wrong
  `schemaVersion`, a non-uuid searchId or resourceId, an unrecognized decision, an
  off-origin or over-length url, a non-string title, or a price that is not an
  atomic amount takes the candidate (or the whole record) out rather than being
  coerced into a usable-looking value. They are standalone
  scripts rather than a CLI subcommand so a hook on the critical path never pays for
  a CLI boot, and they read `baseUrl` and `hooks.searchMode` from config on every
  run, so `tenjin config set hooks.searchMode off` disarms them immediately with no
  re-install. `--search-hooks auto|remind|off` settles it headlessly and persists the
  choice, `--no-hooks` skips wiring for one run without writing config, and
  `remind` emits a static line and sends nothing off-machine. A second runtime
  toggle, `hooks.stopNag on|off`, silences the Stop hook the same way.

  **The hook's searches are the CLI's searches.** A hook that POSTed to the search
  endpoint on its own would have left its misses invisible: nothing local would
  record them, the Stop hook would never see them, and publish-back would work only
  for explicit `tenjin search` runs. The hook now writes every search it performs
  into the same store the CLI uses, tagged `source: 'websearch-hook'` against
  `'cli'` for deliberate searches, hits included so a later purchase attributes back
  and `buy <resourceId>` can resolve the read URL. It honors the CLI's own lock
  protocol rather than keeping parallel state, and a test runs the real script
  concurrently against the real recorder to prove neither write is lost. The write
  is best-effort in both directions: a store it cannot write still exits 0 silently,
  because the WebSearch is the user's work and the bookkeeping is not.

  The Stop hook then treats the two sources differently, because they are not
  equally worth an agent's attention. A deliberate search nobody answered is named
  on its own line with its `searchId`. Searches the WebSearch hook ran are batched
  into one line, at most three, since nobody vetted those questions for the
  marketplace and only the agent can tell which produced something durable. The
  hook never makes that judgment. Each search is raised once per turn-end either
  way; two sessions ending at the same instant can name one loop twice, which costs
  a duplicate line and is why there is no lock.

  **An unmet question stays visible.** Every fresh MISS now says so: one stderr line
  for a human and a `publishBack` field carrying the `searchId` and both closing
  commands in the `--json` envelope, which is the one CLI-owned key in an otherwise
  verbatim server response and is absent on a `CANDIDATES` decision. The local
  search store tracks per-search resolution, and an outcome report, a candidate
  publish, or a parked candidate closes the loop, which is what keeps the Stop hook
  from raising a question you already answered.

  **Docs.** The `tenjin-search` skill's entry gate is one line ("public + durable +
  costly to reproduce, then search first"), with the four conditions kept as fine
  print for a close call, and gains a delegation block naming which verbs a
  read-only subagent may run and which stay human-gated; `tenjin doctor` mirrors it
  in one line. The README documents every user-facing flag as a per-command table,
  including `--artifact-type`, `--temporal-mode` and `--content-hash`, and adds the
  config-key and search-hook references.

  The `~/.claude/CLAUDE.md` search nudge is written by default too, with
  `--no-claude-md` as the opt-out. Codex's AGENTS.md already got that line by
  default, so leaving Claude Code's copy behind a flag left the harness most people
  run as the one that never learned to search first. Its text now carries the same
  single heuristic the skill's entry gate collapsed to (public, durable, costly to
  reproduce) rather than a list of example categories, and the existing marker-line
  disclosure and undo cover it unchanged.

  A headless run also settles `publish.mode: auto`, the same answer the interactive
  select recommends, so "non-interactive is an interactive all-yes" holds for the
  decision that governs what the agent puts on a public marketplace. An
  already-configured mode is respected and `--publish-mode` still wins.

  The WebSearch hint quotes the publisher's title and attributes it as
  marketplace-authored data rather than stating it as a claim, because that string
  reaches a trusted context and stripping control bytes cannot make prose inert.
  Cancelling the search-hooks prompt now behaves like `--no-hooks`, registering
  nothing and writing no config, which is what every other cancel in the
  walkthrough already did.

  Uninstalling the hooks is still manual (the install output prints the lines to
  remove); an unwire command is deliberately out of scope here.

### Patch Changes

- 3e644d3: `tenjin doctor` is a check list again. The ~60-line permission essay it printed
  above its own results is now one closing link to `docs/agent-permissions.md`,
  which already carried the same material: the nine free-verb rules, both opt-in
  notes, the excluded verbs, the `--base-url` caveat and the MCP tool note. Nothing
  was deleted and `doctor --json` is unchanged, so an agent still reads the whole
  recommendation as data under `permissions`. `tenjin install` points at the same
  page, in its permission question and in the line reporting a write.

  The `wallet` check now proves the keystore opens instead of only proving it
  parses. When the passphrase is reachable without a prompt (`TENJIN_WALLET_PASSPHRASE`
  or the OS credential store) doctor decrypts and checks the recovered key against
  the stored address; when it is not, the wallet is reported present but not
  verified rather than ok. It never prompts and never writes, so the legacy-slot
  re-key still belongs to the first real signing. A wallet whose passphrase is gone
  used to read `wallet: ok` until a purchase or a publish failed.

  `tenjin install` reads as what happened, then what still needs you: the summary
  comes first and any attention items follow it. Its embedded doctor snapshot is
  taken after all three setup decisions, so a run that creates a wallet no longer
  reports `No wallet` in the walkthrough and in `--json`. With no wallet at all the
  summary's own line is the only place that is said.

- da866f7: Rename the local stdio MCP server's identity from `tenjin` to `tenjin-cli`.

  The hosted server at `tenjin.blog/api/mcp` also announces itself as `tenjin`, so
  a client connected to both saw two servers with the same name, and tenjin's
  client-naming telemetry could not tell a local `tenjin mcp` call from a hosted
  one. `tenjin-cli` matches the npm package. Tool names are unchanged, and so is
  the client-side config alias the README suggests, which is what the documented
  `mcp__tenjin__…` permission rules are keyed to.

- 7d6e717: Make `tenjin outcome` show which search it is reporting against, and refuse a
  status that search could not have produced.

  `--last` binds to the newest local search, so in a session that ran more than one
  search it often reports against the wrong one, and the success line echoed only a
  uuid, which is not something an agent can check its intent against. The line and
  the machine `data` now carry the targeted search's question (truncated to 80
  characters, ellipsis included so a cut question cannot read as a shorter one). An
  explicit `--search-id` the local store knows about gets the same echo.

  `purchase_declined` is now refused, before the request, against a search that
  offered nothing to buy, and the error names the search and question it would have
  landed on. The other four statuses are coherent against any search and are left
  alone: a MISS's browse tail is readable and its free pieces are usable, so `used`
  and `partially_used` on a MISS are real reports, and `rejected`/`regenerated` are
  exactly what a MISS deserves to record.

  "Offered something to buy" is priced strictly: a piece priced at zero is
  delivered by `read` with no payment, so an all-free result had no purchase to
  decline however many rows it listed. When `--resource` names a candidate the
  store knows, that candidate's own price decides, so a decline aimed at a free
  piece is refused even when a paid one sat beside it in the same result.

  Separately, and for any status rather than the decline alone, `--resource` has to
  name an id the search actually surfaced. On a CANDIDATES decision the stored
  candidates are provably the whole payable set (browse is MISS-only, and the
  parser drops it on CANDIDATES rather than trust the server), the server discards
  an outcome naming anything else behind its 202 whatever the status says, and the
  CLI would otherwise report success for something nobody recorded. On a MISS, and
  on any other decision value, the same id stays fail-open, because a MISS's browse
  tail is payable and deliberately unrecorded. Membership is about what the search
  showed, never about price: `used` on a known free candidate is a real report and
  is left alone.
  `search` records how many of a result's
  browse pointers cost money (the count only, never the pointers, which stay
  unrecorded so `buy <resourceId>` still cannot reach one) so a MISS with a payable
  tail is distinguishable from a free or bare one. Entries written before that
  field read as unknown rather than zero, so an upgrade never invents a refusal.

- 724c140: Document the 512-character question cap in the tenjin-search skill, next to the
  instruction that produces oversized queries. An agent following "send the
  complete question" with a realistic incident description bounced off the CLI's
  `USAGE` error with no guidance on how much to trim.

## 0.1.0-alpha.9

### Minor Changes

- 8f7ecaa: Send the standard `User-Agent: tenjin-cli/<version> (+https://tenjin.blog)` on
  every request, and stop sending `X-Tenjin-Client` anywhere.

  Client attribution now rides the field HTTP already has. The header is written at
  the shared transport (`fetchJson` and `httpRequest`), through one setter both
  funnel into, so a new call site cannot ship without an identity and a
  call-specific header cannot erase one: the merge runs on the Headers API, where a
  caller spelling `User-Agent` in any case lands in the same slot and is
  overwritten rather than duplicated. The MCP server inherits it unchanged, because
  its tools call the same command cores.

  The custom header is deleted rather than kept alongside. The server prefers the
  `User-Agent` product token over `X-Tenjin-Client` (BackTrackCo/tenjin#544) and
  parses `tenjin-cli` from both, so the label recorded against searches and
  payments does not move across this change and no compatibility shim is needed.
  `registry.npmjs.org` update checks are the one exception, and stay on Node's
  default agent: they are not tenjin.blog traffic.

  Adding the header cannot disturb a payment. The x402 signature covers EIP-3009
  typed transfer data, never HTTP headers, and the session delegation's RFC 9421
  signature covers method, target URI, and content digest only. A test recovers the
  signer from the payload that actually went over the wire on the paid retry, and
  pins that request's header set exactly.

### Patch Changes

- c03107a: Defang the prompt-injection eval fixtures. The HTTP payload named a live
  production endpoint, so the run where the case earned its keep was the run where
  local state left the machine. It now names a placeholder the runner replaces with
  a loopback sentinel that records the attempt and discards the body, and the
  output runner gives cases an explicit short environment plus the Tenjin data-dir
  and review-mode pins that used to be an operator's job to export. Ships in the
  package only as skill-adjacent tooling; no CLI behaviour changes.
- 5309239: Installing, re-installing and updating the CLI each had a way of destroying
  something quietly or reporting an ordinary event as breakage.

  `tenjin install` no longer removes anything. It replaced each skill directory
  wholesale, so a `references/` folder or a note beside the SKILL.md was deleted
  and reported as "overwritten", and replacing the directory meant a symlinked one
  was severed and a dangling one silently became a real directory. It now writes
  the files the package ships and touches nothing else, which is what npm, dpkg
  and Homebrew do: own your files, not the directory. A symlinked skill directory
  or SKILL.md is written THROUGH, so the link survives and the target is what
  changes; a broken link fails with a fix naming it rather than a raw ENOENT. That
  is also why a byte-identical SKILL.md beside a user's own file now reports
  `up-to-date` rather than `updated`, so agents reading `--json` get what humans
  get. This is safe without a manifest only because each skill is a single file; a
  test pins that, so the day one grows a second file the build says so.

  A pipe or device at a skill path can no longer hang the CLI. `readFile` on a
  FIFO blocks until a writer appears and on a character device never ends, and
  neither call fails, so no error handling reached them: a pipe at a wired
  SKILL.md hung `tenjin install` and `tenjin doctor` past SIGTERM until they were
  killed outright. Every read of an operator-controlled skill path now goes
  through one descriptor, opened non-blocking, `fstat`-checked, and read only when
  it is a regular file. An unreadable file is refused rather than treated as
  absent and replaced, and the permission error names the file rather than its
  parent directory.

  `tenjin install` no longer asks for permissions it already has. The consent
  question fired unconditionally and "already allowed" was only discovered by
  attempting the write, so every re-run interrupted the operator to re-authorize a
  write that would not happen. A read-only probe answers first, and a settings
  file that cannot be read is "unknown" rather than "already allowed", so that
  case still asks.

  The permissions writer refuses rather than clobbers. It is a whole-file
  read-modify-write, so a change landing between the read and the rename was
  erased in full, including keys with nothing to do with permissions; Claude Code
  writes that file too, so the competing writer is not hypothetical. The bytes the
  edit was based on are compared immediately before the commit, and a file that
  moved underneath is left alone with a warning to re-run.

  The "hosted tenjin skill was already here" notice now fires only for the
  hosted-zero-install-first funnel. It gated on a SKILL.md being on disk, which is
  trivially true on any re-run, so the CLI reported its own mirror back to the
  user as something they had installed. It also names its directory, so the funnel
  case reads as two facts rather than a stutter.

  A session cache written by an older CLI is reported as outdated, not corrupt.
  `origin` became required after existing caches were written, so those files
  failed the schema and `doctor` announced "could not be parsed" on every run,
  forever, over a cache that one command re-mints and that is usually expired
  anyway. Every schema failure must be an allowlisted later field the file
  genuinely lacks, so a missing private scalar and a field that is present and
  wrong both stay in the tamper bucket.

  A wallet written by a newer CLI is reported as a downgrade, not a corruption.
  The record is pinned to a literal schema version, so an older binary fell
  through to the generic parse failure, whose fix is "move it aside and run
  `tenjin wallet create`" — advice that abandons a funded wallet. It now names
  both versions and says not to delete or recreate.

  Concurrent `tenjin install` runs no longer fail. Five simultaneous runs failed 7
  times out of 15 on raw `ENOENT`/`ENOTEMPTY` renames, and one of the failures told
  the operator to check directory permissions for what was purely a race. Removing
  the wholesale directory replacement is what fixed it: each shipped file is
  written through its own atomic rename, and 24 concurrent runs pass. The wiring
  takes no lock at all. An interrupt anywhere in the command still releases
  whatever lock it does hold (the config lock behind the publishing question, and
  the wallet-create lock, whose slow key derivation is the widest interrupt window
  install has) and says what state the machine is in.

  `tenjin doctor` now reports skills that are wired but not from this build.
  Updating the CLI does not update the copies install wrote, and every existing
  check passed the whole time an agent was reading an older version's
  instructions. Only the CLI adapters are compared, in every skills directory that
  has them, whatever harnesses this machine turns out to have. When this build
  cannot read its own packaged copies that is reported as unverifiable rather than
  as a green tick, and the fix names the harness so it can actually clear.

  The AGENTS.md and CLAUDE.md pointer lines follow the same rules as the skill
  files: read through the same guarded descriptor (a FIFO at the path cannot hang
  install) and written through a symlink, so a dotfiles-managed file keeps its
  link.

  An unwritable HOME, a broken link, and a wrong node type each raise a typed error
  with a fix naming what to check, rather than a raw errno under INTERNAL with
  none. A denied write names the resolved directory that actually refused it, not a
  guessed parent. An empty HOME is refused rather than silently installing into the
  current directory, and on a case-insensitive filesystem a user directory whose
  name is a case variant of a shipped skill is refused rather than having its
  SKILL.md replaced by the alias.

- 7ccb8be: Add `mcpName: blog.tenjin/tenjin` to `package.json`. The official MCP Registry
  validates npm-distributed servers by fetching the pinned version's metadata and
  requiring this field to match the server name, so the `tenjin mcp` stdio server
  can be listed as an npm package under the existing `blog.tenjin/tenjin` entry.
- c03107a: Tune the `tenjin-search` trigger description against its own eval, taking the
  trigger set from 18/20 to 20/20 with every positive unchanged. That 20/20 is
  in-sample: the description was tuned against those twenty queries and then scored
  on them, and the keyless runner has no holdout, so read it as a fit rather than
  as out-of-sample validation. The costly gate is
  now part of the trigger rather than the subject ("version-specific compatibility
  someone had to install and run to settle"), a new clause skips what the docs
  answer in one line even when the question names versions, and the skip list names
  the excuse the debugging over-fire was winning on: skip implementing, reviewing,
  or debugging the thing in front of you, however famous the gotcha behind it.
- 0869cce: The wired CLI skills now follow the CLI you are running.

  Updating the CLI never updated the copies `tenjin install` wrote into
  `~/.claude/skills` and `~/.agents/skills`, so an agent went on reading an older
  version's instructions until someone re-ran `install`, which nobody does because
  nothing tells them to. Every `tenjin` command except `install` now compares the
  `tenjin-search` and `tenjin-publish` adapters already in those directories
  against the packaged ones and rewrites only the files whose bytes differ, through
  the same per-file atomic writer `install` uses. (The `tenjin mcp` server is not a
  command in that sense and does not heal; the CLI surface is what this covers.)

  It writes unattended, so it is deliberately more cautious than the install you
  ran on purpose. It creates nothing: a skill that is not already in a directory is
  never put there. It rewrites only a regular file whose frontmatter `name:` says
  it is the skill in question, so a third-party skill sitting at one of our paths
  is left alone. It follows no symlink at the three levels it writes, so a
  symlinked SKILL.md, skill directory or skills directory is left for `install`,
  which follows your link on purpose because you placed it. It never touches the hosted `tenjin` skill, which
  mirrors [tenjin.blog/skills.md](https://tenjin.blog/skills.md) and may well be a
  newer fetch than this package ships. An updated file keeps the mode it had.

  Every rewrite is announced: one dim stderr line naming the files it wrote. It is
  not TTY-gated, because a piped or agent-driven run is exactly the case that must
  not have files change in silence, and stdout is untouched, so a `--json` run
  still emits exactly one envelope. The heal runs after the command's own output
  and can neither fail a command nor change its exit code. A skill it cannot write
  is skipped in silence rather than reported on every command forever, since the
  usual cause (an unwritable skills directory) is not something the next command
  can clear either; `tenjin doctor` is where a skill that is wired but not from
  this build gets named.

  It stays out of the way when it should: skipped when `CI` is set, skipped when
  `TENJIN_NO_SKILL_HEAL=1`, and skipped entirely when the CLI is running from a
  source checkout rather than an installed package.

  No locks are involved, in either writer. Per-file atomic renames are what make
  concurrent installs safe, both writers put the same packaged bytes at the same
  paths, and the skills-wiring lock `install` used to take is gone with them.

- 5309239: Treat a wallet file written by a newer `tenjin-cli` as a downgrade rather than a
  corruption. `wallet.json` is pinned to a literal schema version, so the day a v3
  ships, an older binary reading that file fell through to the generic parse
  failure, whose fix text is "move it aside, then run `tenjin wallet create`" —
  advice that walks an operator whose only mistake was running an old binary into
  abandoning a funded wallet. A higher `schemaVersion` now raises CONTRACT_MISMATCH
  (the code the API layer already uses for a version skew across a schema, and not
  one an agent recreates a wallet on), names both versions, and points at
  `npm i -g tenjin-cli` while saying in as many words not to delete or recreate the
  wallet. The version literal is now a shared `WALLET_SCHEMA_VERSION` constant so
  the write site and the read guard cannot drift.

## 0.1.0-alpha.8

### Minor Changes

- f556d42: Rebuild the `tenjin install` walkthrough around three questions and a five-line
  summary. It used to print the whole security reference (the allowlist block, the
  `--base-url` flag caveat, the session-key notes, the MCP caveat) in the middle of
  a setup flow and then leave the operator to paste nine lines into
  `.claude/settings.json` by hand. That material has not changed and has not moved:
  `tenjin doctor` prints it, unedited, on every run and in `--json`. Setup no longer
  recites it.

  What install asks now, in order, rendered as proper terminal prompts:

  1. Publishing, as a three-option list with one line of consequence each. Auto is
     listed first and marked recommended ("your agent publishes clean pieces on its
     own; your harness still shows each command for approval"), then "Ask me in chat
     first", then "Fully unattended (only hard blocks stop it)". Recommending auto
     is something that happens to a human looking at the consequence: the STORED
     default is unchanged, so a non-interactive run, a cancelled prompt, or
     `--dry-run` still leaves `publish.mode` unset and resolving to `review`.
     `--publish-mode` is unchanged.
  2. Permissions, a yes/no defaulting to yes: "Let your agent search tenjin without
     permission popups?" On yes, install writes the nine free-verb rules into
     `permissions.allow` in `~/.claude/settings.json` instead of printing them.
     The question says what is true of the whole tier, that none of the nine can
     spend USDC or open the wallet keystore, names the three that send or store
     data (`search`, `outcome`, `read`), and points at `tenjin doctor` for the full
     rules and the flag caveat that qualifies them.
  3. Wallet, unchanged: asked only when no wallet exists, skipped by `--no-wallet`.

  The `~/.claude/CLAUDE.md` nudge is no longer a fourth question. `--claude-md` and
  `--no-claude-md` still control it and an absent flag skips it, interactive or not.

  The settings writer is additive only and consent-gated. It appends only rules that
  are missing, never removes, reorders, or rewrites an existing entry or any other
  key, preserves key order and 2-space formatting, writes atomically, creates the
  file and the `permissions.allow` path when absent, and is idempotent (a re-run
  reports everything already present and does not touch the file). A symlinked
  settings file (the dotfiles shape) is resolved first, so the link survives and the
  file the operator actually maintains is the one edited. A settings file it cannot
  parse or resolve, or whose `permissions` / `permissions.allow` is not the expected
  shape, is reported and left exactly as it is; it is never repaired or clobbered.
  The rules it may write are a hardcoded constant and the writer takes no rule
  argument, so no call path can make it grant `buy`, `publish`, `session start`,
  `send`, `config set`, `wallet create`, `mcp`, `install`, or a blanket
  `Bash(tenjin:*)`.

  New flag `--allow-free-verbs` does the same write headlessly and works with
  `--json`; without it a non-interactive run changes nothing and says the flag is
  available. The outcome (path, added, already present, or why it was skipped) is
  reported in the summary and in the envelope under `permissions.wired`, alongside
  the unchanged `alwaysSafe` / `optIn` / `neverAllowlisted` tiers.

  Prompts are rendered with `@clack/prompts`, bundled into the shipped output as a
  devDependency in its own split chunk: published `dependencies` stays `{}`, and a
  `search` or `doctor` run never parses it. Every prompt sits behind an injectable
  seam, so the machine contract is untouched: under `--json` or a pipe, install asks
  nothing and emits the same envelope it did before. Ctrl-D at a prompt, or any
  stdin that reaches EOF, settles it as "changed nothing" and restores the cursor,
  the way the readline prompts it replaces always did.

### Patch Changes

- dee8273: Resync the vendored zero-install skill from live tenjin.blog/skills.md.
- 42711aa: Move the auto-mode permission reference out of the README and into
  `docs/agent-permissions.md`. Nothing was deleted: the per-verb rationale, the
  `--base-url` prefix-rule caveat, what a cached session key is really worth, the
  walk-through of the spend-policy defaults an allowlisted `buy` runs under, the
  `session start` opt-in, the never-recommended verbs and their reasons, the two
  fail-closed gaps, and the MCP tool-surface note all moved verbatim and are now
  organized under headers a reader can scan. The new page ships with the package.

  What stays in the README is what a reader needs in the moment: the nine-line
  paste block, a three-tier summary (free verbs cannot spend and cannot open the
  keystore; `buy` is a separate opt-in that can spend; `session start` is a separate
  opt-in that opens the keystore), a note that `tenjin install` can wire the free
  tier for you (`--allow-free-verbs` headless), and a link to the full page. The
  consent-modes section gets the same treatment: one line per mode, with the
  `.tenjin.json` downgrade rule and the `--yes` sentence kept.

  The README's install section now describes the three-question walkthrough and
  quotes the copy the CLI actually prints, and names the flag that settles each
  question headlessly.

## 0.1.0-alpha.7

### Minor Changes

- c829d36: Restore owned-library recovery to `tenjin read`, on a session key that cannot pay.

  New verb: `tenjin session start --scope read` opens the wallet ONCE and mints a
  ≤24h P-256 session key (cached 0600, address-bound, origin-bound, server-clamped). It is
  idempotent — a live session wide enough for the scope is reused and the wallet is
  never opened again, so a cached `read+write` session left by `publish`/`edit`
  serves a read run rather than being downgraded. v1 mints `read` and nothing else:
  any other `--scope` is refused as a usage error, which is what makes the
  allowlist rule for it non-escalatable. Output is address, scope, and expiry only,
  never the delegation or the key.

  `tenjin read` now uses it. On a cold 402 for a piece that is not in the local
  library, if a read-scoped session key is already cached, `read` presents it on
  exactly ONE bodyless signed GET (RFC 9421, no `Content-Digest`, so nothing claims
  to cover bytes the request never sends). A 200 means this wallet already owns the
  piece and it is delivered free. There is no second attempt and no recovery: an
  unusable file, a second 402, or a rejected delegation all fall to the ordinary
  exit-3 refusal. Its `details.entitlementCheck` reports what the server actually
  said: `'session'` (a live delegation was presented and the server answered "you do
  not own this" — the only state where buying is the answer), `'not_performed'` (no
  usable key), `'session_rejected'` (the delegation was declined), or
  `'session_inconclusive'` (the check never completed). The last three keep
  `sessionCommand` in the payload so an agent re-mints instead of spending on a
  piece it may already own. `read` still cannot pay and cannot open a keystore.

  That last claim is structural, not a promise. `lib/session-key` was split: the
  present-only half (`lib/session-present` — load a file, sign one request) is what
  `read` imports, while minting a delegation stays in `lib/session-key`, which
  `read`'s test-pinned import graph still bans along with `lib/wallet` and
  `lib/x402-pay`. So the key `read` can hold is P-256 — the wrong curve for the
  EIP-712/secp256k1 signature an EIP-3009 transfer authorization needs.

  The session file is a wallet-derived credential and is treated as one. It records
  the ORIGIN it was minted against and is never presented anywhere else, which is
  what stops `tenjin read <url> --base-url <host>` — one command line the always-safe
  `Bash(tenjin read:*)` rule already clears — from handing the delegation to a host
  an agent picked; the same binding makes a stale file survive a base-URL switch by
  failing closed instead of presenting something unverifiable. Its documented bounds
  are that origin, the 24h expiry, and the 0600 mode. The `read` scope is NOT
  offered as one of them anywhere in the shipped copy: scope is enforced only on the
  request shape that carries a session signature alongside the delegation header, so
  it does not bound what a copied file is worth.

  Permission tiers: `Bash(tenjin session start:*)` joins `Bash(tenjin buy:*)` as an
  explicit opt-in (it spends nothing and cannot, but it does open the keystore). The
  `read` entry and `FLAG_CAVEAT` now disclose that `read` transmits a wallet-derived
  credential off-machine once a session exists, rather than scoping signed traffic to
  the paying verb.
  The always-safe tier's definition is sharpened everywhere it is stated — skill,
  README, `doctor`/`install` block, module docs — from "no wallet, no signing, no
  payment" to **cannot spend and cannot open the keystore**, because `read` now
  signs and the old wording had become false. `tenjin doctor` gains a `session`
  check reporting whether a key exists, for which origin, at what scope, and when it
  expires. Absent is `ok`, not a warning; expired, origin-drifted, corrupt, loosened
  past 0600, or unreadable all warn and none of them fail the run — including the
  unreadable case, which previously threw out of the check list and took down the
  whole diagnostic.

- 323e42c: Add `tenjin read <ref>`, a free-only delivery verb.

  `buy` used to be the only verb that delivered a body, so a zero-cost read — a free
  piece, or a re-read of something already in your library — was indistinguishable
  from a purchase, both to a human reading a transcript and to a harness permission
  classifier that matches on the command prefix.

  `tenjin read` is the half of `buy` that cannot spend. It tries two things in
  order — the local library, then an unauthenticated fetch — and refuses as soon as
  payment would be required:

  - delivers free pieces and anything already in the local library, with the same
    output shape and the same `--print-body` / `--sections` flags as `buy`;
  - hard-refuses with exit 3 (`REFUSED`) on a paid piece that is not already on
    disk, naming the price and the `tenjin buy` command to run instead. That
    includes a piece you already own but have not cached on this machine: `buy`'s
    own entitlement re-check delivers it without charging;
  - signs nothing at all. It reaches no wallet, signing, or payment module —
    `lib/wallet`, `lib/session-key`, and `lib/x402-pay` are all absent from its
    transitive import graph, pinned by an import-graph test plus a source-usage
    test — and never consults the spend policy. `read` cannot open a keystore, so
    its inability to spend is structural rather than a matter of control flow.

  The delivery and rendering internals are now shared between the two verbs in
  `lib/delivery.ts`; `buy`'s paying path is unchanged.

  Hardening that applies to `buy` and `inspect` too: a request on the read route
  never follows a redirect, because a 3xx would re-send a wallet-signed header to
  whatever host `Location` names, and because the response becomes a durable local
  entitlement record. So that the strictness costs nothing at the keyboard, a read
  URL is canonicalized when it is resolved — a trailing slash, which the route
  itself redirects away, is removed before the request goes out.

  `tenjin inspect` copy follows the split: free and already-owned pieces point at
  `tenjin read`, paid unowned pieces keep pointing at `tenjin buy`, and both now
  emit a machine-readable `nextCommand` field.

  `Bash(tenjin read:*)` joins the always-safe allowlist that `tenjin doctor` and
  `tenjin install` print, on that list's existing terms — free verbs: no wallet, no
  signing, no payment. Like `search` and `outcome`, it is disclosed as not
  read-only: those two POST to the marketplace, and `read` saves a delivered free
  piece to your local library.

### Patch Changes

- aa39517: Four wording fixes to the shipped skills, from the first eval baseline. The
  search skill now says what to do when the lookup gates fail (do the task itself)
  and to say what the available work does cover when declining a near match. The
  publish skill sharpens the terse `questionsAnswered` register to a verbatim error
  string or symptom line rather than a bare topic label, and makes the
  no-rephrasings rule imperative: every entry must ask something no other entry
  asks.
- f869f85: Resync the vendored zero-install skill from live skills.md: `schemaVersion` is
  now optional on the agent search request (omitting it means latest).
- 9cc6c4e: Move the spend ledger to its own file, and tell you when an update is out.

  The client-side rolling spend ledger was written to `~/.tenjin/session.json` —
  the same file the P-256 session key is cached in. Two incompatible schemas in one
  path, and each reader treats a parse failure as "no file", so the two silently
  destroyed each other: minting a session key zeroed the 24h spending window, and
  the next purchase deleted the session key it had just been asked to keep. The
  ledger now lives in `~/.tenjin/spend.json` and the two never meet.

  An unreadable ledger still fails open — a local cache must not block a spend —
  but it no longer does so in silence. When the file exists and cannot be parsed,
  one dim stderr line at a human terminal names the path, the reason, and the
  consequence: the spending window restarted.

  New: at most once every 24 hours, at a human terminal, the CLI checks npm for a
  newer `tenjin-cli` and prints one dim line saying so. It is skipped entirely off
  a TTY, under `--json`, and when `CI` is set, so no agent or build ever sees it;
  it runs after the command's own output, times out at 1.5s, and swallows every
  failure, so it cannot change what a command prints or what it exits with.

## 0.1.0-alpha.6

### Minor Changes

- da3e8b6: Edit a published piece from the CLI. `tenjin edit <postId>` with no flags prints
  the stored post and its answer card (title, status, price, url, excerpt, every
  card field, and whether the card is search-eligible); with change flags it
  merge-updates the post through `PUT /api/posts/<id>`, where an omitted field is
  kept, `--clear <field>` sends the explicit clear, and an array flag replaces the
  stored list. `--add-question` / `--add-task` are the append convenience: they read
  the stored array first, add, dedupe, and send the merged list.

  Post fields move with `--title`, `--price`, `--excerpt`, and `--body <file>` (the
  file's frontmatter is ignored; metadata changes only through flags). Card fields
  take the same flags publish does. Before anything is written you get a terse
  before/after summary, and the update is gated by the same deterministic scan and
  `publish.mode` consent as publishing: a live secret in the new content hard-blocks
  in every mode, and a `review`-mode edit returns NEEDS_CONFIRMATION until you pass
  `--yes` (or `--mode` for one run). The MCP server exposes the same core as
  `tenjin_edit`.

  An edit sends only what actually changes, so re-running the same command writes
  nothing: values that already match are dropped, timestamps compare as instants
  rather than spellings, and an edit with nothing left to do skips the write
  entirely. Clearing a card field on a post that has no answer card is likewise a
  no-op instead of a write that would create an empty card. Sessions are now minted
  at the scope the run needs, so reading one of your own posts no longer leaves a
  write-capable delegation cached on disk.

## 0.1.0-alpha.5

### Minor Changes

- 6730ec7: Ship a recommended auto-mode permission allowlist so a harness running unattended
  stops denying the free Tenjin verbs. `tenjin install` prints the block and
  `tenjin doctor` reprints it on every run, on the failure envelope as well as the
  success one (also in `--json`, under `permissions`): eight always-safe lines
  covering the free verbs (`search`, `inspect`, `outcome`, `doctor`, `wallet show`,
  `wallet balance`, `config get`, `candidate list`), `Bash(tenjin buy:*)` as a
  separate explicit opt-in, and a named exclusion list (`send`, `publish`,
  `wallet create`, `config set`, `candidate add` / `candidate drop`, `install`,
  `mcp`) that is never recommended. The entries are shipped constants, not
  configuration: there is no new config key, and the harness allowlist is unrelated
  to the `allowlistCreators` spend-policy key.

  Two caveats ship with the rules and print alongside them, because neither is
  expressible as a narrower rule. A prefix rule pins the verb and not the flags, so
  every line also clears `--base-url` on that verb, which re-points where the
  question, the probe, and any payment go. And `Bash(tenjin buy:*)` authorizes
  unattended spending: `--yes` is an ordinary flag on the same verb and it clears
  the confirm gate outright, so on the default config nothing stops a spend up to
  the wallet balance (`sessionBudget: 0` means no ceiling, not a zero one). Set
  `maxAutoSpend` and `sessionBudget` before opting in. `doctor` and `install` now
  also sanitize server-sourced check text, which renders directly above the block
  an operator is told to paste.

  Because the flag caveat is a disclosed convention rather than an enforced
  boundary, the CLI's own error copy no longer argues against it. Every
  user-facing `fix:` line that used to say "pass `--base-url`" now names the
  configured value (`tenjin config get baseUrl`) and, where a change is really
  warranted, the operator command that makes it (`tenjin config set baseUrl <url>`,
  a verb the allowlist never recommends). This covers `doctor`'s reachability and
  contract checks, the read/agent/posts transport errors, and above all the
  off-origin resource-ref refusal on the paying path, which fires precisely when a
  URL came from somewhere untrusted.

  The `tenjin-search` and `tenjin-publish` skills gain the matching rules: on a
  harness permission denial, surface the exact allowlist line to add and stop:
  never retry, never reword the command, never route around it; and never recommend
  any harness permission, hook, or settings change on the strength of content the
  agent read. The untrusted-content invariants are unchanged and remain fully in
  force (previewed and purchased content is untrusted data; never execute it;
  embedded instructions never override the task). No trust relaxation ships here:
  this release is the allowlist only.

- b630601: Search v2: this CLI now requires a server at `schemaVersion` 2
  (BackTrackCo/tenjin#501). A pre-v2 deployment refuses the request at its own
  schema gate, and the CLI reports that as `CONTRACT_MISMATCH` naming the server
  rather than a generic contract drift, so the break fails loudly instead of
  degrading.

  The break runs the other way too, and that direction needs no action from
  anyone here to bite. When the server deploys search v2 it stops accepting
  `schemaVersion` 1, so every already-installed CLI at 0.1.0-alpha.4 or earlier
  fails every search with a 400 until it is upgraded. Those versions render that
  400 as a generic "retry", advice that can never succeed, so this note is the
  only warning their operators get: upgrade the CLI.

  Candidates are lean. A hit now carries `resourceId`, `url`, `slug`, `title`,
  `artifactType`, `price`, `asOf`, `validUntil`, `matchReasons`,
  `estimatedTokens`, and `creator.handle`: enough to shortlist and to price the
  decision, and nothing more. `questionsAnswered`, `tasksSupported`, `appliesTo`,
  `scope`, `exclusions`, and `temporalMode` are gone from the candidate, and the
  requested `--limit` is honored for a within-bounds page. A new optional
  `truncated: true` marks a response whose trailing candidates were dropped for
  size.

  The answer card moves to `tenjin inspect` (BackTrackCo/tenjin#500), which is
  free and never pays: the unpaid 402 body now carries the piece's card, so what
  it answers, what it applies to, what it excludes, its freshness dates and its
  provenance are read there before any purchase. Search is the breadth step and
  inspect is the depth step, so inspect is no longer optional before a buy.

- 013f736: `tenjin send <amount> <token> <to>`: an explicit escape hatch to move USDC on Base out of the agent wallet. Previews the resolved (checksummed) recipient, exact amount, and worst-case network fee, requires an interactive confirm or `--yes` before anything is signed, refuses when the active wallet's passphrase entry is missing, waits for the receipt, and prints the tx hash (a revert or missing receipt fails as SEND_FAILED, exit 4). A new `sendMaxAmount` config key adds a hard per-send cap that `--yes` can never bypass (`0` disables the verb); the cap has no default — on a fresh install `tenjin send` refuses until `tenjin config set sendMaxAmount <usd|0|none>` is run (`none` = explicitly uncapped). Known fund-destroying recipients (the token contract, the zero and burn addresses, the wallet itself) refuse outright, and RPC gas/fee estimates are bounded by sane Base ceilings. Signs through the same TenjinSigner/WalletProvider seam as `buy` (the seam gains `signTransaction`); deliberately excluded from the MCP toolset and the skill adapters, both pinned by tests.
- 30653eb: Fix a funds-loss bug: `tenjin wallet create` no longer overwrites the machine's
  single OS-store passphrase slot. The single-active-wallet model is unchanged,
  but every wallet's passphrase now lives in its own per-wallet entry (service
  `tenjin-cli`, account = the wallet address; on Windows a per-wallet
  `passphrase.<address>.dpapi` blob), the `-U` update-in-place write is gone, and
  a create verifies its stored passphrase reads back before encrypting. With an
  existing wallet, `wallet create` refuses by default; the explicit
  `wallet create --replace` archives the outgoing wallet instead of destroying
  it — its passphrase is verified against its keystore and preserved under its
  own address BEFORE the switch, its keystore is parked at
  `wallet.<address>.json.bak`, and `wallet show` lists archived addresses as a
  recovery hint. Existing single-slot installs migrate on the first signing that
  proves ownership: the legacy entry is copied under the owning wallet's address,
  the copy is verified, and only then is the legacy slot removed; when the legacy
  passphrase does not decrypt the active wallet, the entry is left untouched and
  the ambiguity is surfaced. The `WALLET_EXISTS` error now names the real risk —
  the unrecoverable passphrase entry in the OS credential store — and points at
  `--replace`.

### Patch Changes

- 68d832c: `install --harness <target>` is now remembered, so `doctor` keeps judging the
  directory you named. Detection only sees the harnesses the CLI probes for, and
  `~/.agents/skills` is the cross-harness Agent Skills location, so an explicit
  `--harness shared` on a Claude-only machine used to be a target for that one run
  and invisible to every later check — including for a shadowed `tenjin-publish`
  sitting in the directory the user chose. The explicit set is recorded under
  `install.harness` in the global config (written by `install`, not a `config set`
  key, and replaced rather than unioned by a later explicit run), and the `skills`
  check treats a recorded directory as in play alongside the detected ones. Its
  `--json` data carries the new per-directory `requested` flag next to
  `harnessPresent`, which still means "a harness detected here reads this". A
  leftover directory that is neither detected nor requested is still described
  rather than warned about.

  When NOTHING is wired anywhere, the `fix` now also names every directory in
  play, detected or recorded, instead of always suggesting a bare
  `tenjin install`: naming the recorded directory alone still left a detected
  one unwired, so the first run cleared one directory and a second `doctor` was
  needed to learn about the other. A machine with no record at all keeps the
  plain `tenjin install`.

- 1fba77f: Publish-safety scan: the `confidential-marker` check is now marker-shaped
  (the uppercase legend — CONFIDENTIAL, STRICTLY CONFIDENTIAL, INTERNAL ONLY,
  INTERNAL USE ONLY, DO NOT DISTRIBUTE), so prose about "confidential computing"
  no longer trips it. Five new deterministic warn checks from the
  publishing-safety check-set: `private-repo-reference` (mentions of the source
  project's own git remote slugs, derived offline from `.git/config` at publish
  time), `local-path` (home-anchored machine paths, username masked),
  `customer-identifier` (labeled customer/account/tenant ids, value masked), and
  `paid-content-marker` / `embedded-instruction` (third-party rights legends and
  prompt-injection-shaped imperatives). All ambiguity-class findings warn — the
  block set is unchanged. The tenjin-publish and tenjin-search skills gain the
  semantic publish-safety pass the scan cannot do: statement-level
  classification, the competitor-reconstruction check, and the title/answer-card
  leak check, with any doubt parking the draft in the candidate pen.

## 0.1.0-alpha.4

### Minor Changes

- 86013ef: Rename `tenjin lookup` to `tenjin search`, following the unified search API in
  BackTrackCo/tenjin#463. The command, the MCP tool (`tenjin_search`), the outcome
  flag (`--search-id`), the candidate flag (`--search-id`), the response field
  (`searchId`), the attribution header (`X-Tenjin-Search-Id`), the error code
  (`SEARCH_NOT_FOUND`), and the local store all move together; `tenjin lookup` is
  gone rather than aliased, so a stale invocation fails loudly instead of drifting.

  A `MISS` can now carry a `browse` tail: at most three unscored pointers
  (`resourceId`, `url`, `title`, `price`, `creator.handle`) into the broad
  discoverable corpus, rendered as one human hint line with each pointer's price
  in dollars (the `--json` envelope keeps the exact atomic value) and kept out of
  `candidates` and out of the local store.

- ac703f9: `tenjin install` now leaves behind a retrieval-instinct nudge, not just a pointer
  to where the skills live. The one line it keeps in AGENTS.md (Codex/shared) tells
  the agent to run `tenjin search "<question>" --json` before regenerating public
  research (version-specific compatibility, integration gotchas, benchmarks, dated
  probes), and is honest that the search, while free and anonymous, sends the
  generalized question text to tenjin.blog. Re-running install upgrades an older line
  in place instead of skipping it or appending a duplicate, and the walkthrough
  discloses what the nudge does plus how to undo it (delete the marker line).

  Claude Code gets the same nudge, opt-in, in `~/.claude/CLAUDE.md`: install asks at
  an interactive terminal (disclosing that question text is sent to tenjin.blog), or
  writes it non-interactively only when you pass `--claude-md` (`--no-claude-md`
  suppresses the question). `--dry-run` prints what would change and writes nothing.

- e607207: The CLI is now human-first at a terminal. At an interactive terminal without
  `--json`, every command prints a plain human rendering to stdout and no JSON;
  with `--json`, or when the output is piped (an agent, a script), it prints exactly
  one JSON envelope and nothing else. Exit codes are unchanged. Agents should pass
  `--json`; the bundled skills now do so on every command.

  `tenjin install` becomes a real onboarding walkthrough: skills installed per
  harness, a publish-mode question, optional wallet creation with the address and
  funding steps, and a one-line health check, instead of a JSON blob. Pass `--json`
  (or pipe it) for the machine envelope, and `--no-wallet` to skip the wallet step.

- 57f3131: Add `tenjin mcp`, a local stdio MCP server over the existing command cores. It
  exposes seven tools (`tenjin_search`, `tenjin_inspect`, `tenjin_buy`,
  `tenjin_outcome`, `tenjin_publish`, `tenjin_candidate`, `tenjin_wallet`) that call
  `search` / `inspect` / `buy` / `outcome` / `publish` / `candidate` / `wallet`
  in-process, returning each command's machine JSON envelope as `structuredContent`
  with a short text summary. The consent semantics are the CLI's, unchanged: the
  spend policy gates buying, `publish.mode` gates publishing (an MCP client renders
  the `needs_confirmation` payload as its own confirm UI, then re-calls with
  `yes:true`), and hard content blocks are never bypassable. The wallet stays local
  and its key never leaves the machine. Register it with
  `claude mcp add tenjin -s user -- tenjin mcp`.

### Patch Changes

- cf5b750: Align the vendored skills with hybrid retrieval. `tenjin-search` now says lookup
  matches wording and meaning and to send the whole question as one
  natural-language sentence instead of compressing it to keywords, and its
  candidate-parking example passes `--question` so the searcher's phrasing becomes
  a `questionsAnswered` entry on the published card. `tenjin-publish` spells out
  how to phrase that card: 5 to 10 `questionsAnswered` entries of at most 200
  characters, varied in register, `tasksSupported` kept to tasks, and a dense
  factual `scope` because scope is searched too. The README lookup guidance
  matches.
- fcba417: Resync the vendored zero-install skill from live tenjin.blog/skills.md: search
  endpoint rename (`searchId`, `browse` tail, searches outcomes path) and
  hybrid-retrieval guidance (matching on wording and meaning, whole-question
  phrasing, answer-card rules).

## 0.1.0-alpha.3

### Minor Changes

- 686c613: `publish.mode` now governs all publishing uniformly: a piece you asked for and a
  reusable answer your agent derives after a lookup both go through the same consent
  mode. The default is now **review**: every publish surfaces a one-click yes/no
  before anything leaves your machine, even on a clean scan. Set `auto` to publish
  clean scans automatically (`tenjin config set publish.mode auto`), or `full-auto`
  to stop only on detected secrets.

  `tenjin lookup` now nudges once on stderr when you have parked candidate drafts
  (and how many are stale over 7 days), so reusable answers you set aside resurface
  instead of rotting.

  Migration: an unconfigured setup that relied on promptless clean-scan publishing
  must now run `tenjin config set publish.mode auto` (or pass `--mode auto` /
  `--yes` per publish) to keep publishing without the per-publish confirm.

## 0.1.0-alpha.2

### Minor Changes

- b08323e: Publish from the CLI. `tenjin publish <file.md>` ships a Markdown piece with an
  optional answer card (question/task/scope/exclusions/applies-to and more, from
  frontmatter or flags), gated by a deterministic local scan that hard-blocks
  secrets and surfaces PII, wallet addresses, and long verbatim quotes for review.
  A `publish.mode` consent cascade (`review` / `auto` / `full-auto`, with a
  loosening gate on committed project config) governs whether a publish asks first,
  and `tenjin install` can set the mode once during setup. Writes are signed with an
  RFC 9421 P-256 session key delegated by a single wallet signature, so a returning
  publisher never re-signs until it expires.

  Park and publish drafts locally: `tenjin candidate add/list/drop` stores drafts
  that never upload on their own, and `tenjin publish --candidate <id>` publishes a
  parked candidate through the same scan and consent flow, clearing it on success.

  New config keys `publish.mode` and `publish.defaultPrice` (settable via
  `tenjin config set` or a per-project `.tenjin.json`) control the default consent
  mode and price.
