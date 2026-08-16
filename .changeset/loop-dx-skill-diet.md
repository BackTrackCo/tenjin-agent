---
'tenjin-cli': minor
---

Publish-back loop DX (tenjin-agent#161, #162), plus a skill diet.

The Stop hook's weak arm now fires at most once per session. A research fan-out
mints new searchIds every turn, so per-searchId dedupe never rate-limited it and
the batch read as harness debug output. `hooks.stopNag` gains `deliberate-only`,
which drops that arm and keeps the deliberate-search one, so silencing the noise
is no longer the cliff `off` is. Whatever the hook raises now leads with the
resolved publish.mode, which an agent otherwise had to run `tenjin config get`
mid-publish to discover. That line resolves the mode in the CLI's own order,
global config then a project `.tenjin.json` found by walking up from the session's
cwd then `TENJIN_PUBLISH_MODE`, so the hook, `publish`, and `doctor` agree on what
the next publish in that directory will actually run under. A committed project
`full-auto` reads as `auto`, mirroring the loosening gate.

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

tenjin-search is now a lean SKILL.md plus `references/permissions.md`, loaded on
demand; tenjin-publish drops its duplicated scan-tier explanation and its
narration. Every invariant is kept, and both frontmatter descriptions are under
the 1,024-character trigger budget.

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
