# tenjin-cli

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
