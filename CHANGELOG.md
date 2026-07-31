# tenjin-cli

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
