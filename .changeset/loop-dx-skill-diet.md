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
mid-publish to discover.

`tenjin publish --search-id <id>` re-links a loop something else already closed,
so a MISS closed as `regenerated` while the answer was still being written can
still be attributed to the piece that answered it.

`publish.mode` auto or full-auto now carries `Bash(tenjin publish:*)`: `install`
writes it, a return to `review` takes it back, and `uninstall` reclaims it. The
mode is the consent, so the harness no longer asks a second time for what the
operator already granted. A bare headless install does not write it — that run
defaults the mode rather than being told it.

tenjin-search is now a lean SKILL.md plus `references/permissions.md`, loaded on
demand; tenjin-publish drops its duplicated scan-tier explanation and its
narration. Every invariant is kept, and both frontmatter descriptions are under
the 1,024-character trigger budget.

`tenjin publish --search-id <id>` now sends that id to the server, which accepts
and documents it as the attribution for the MISS the piece answers. It never
reached the wire before, so every publish that named a search still went out
unlinked — the thing #161 is actually about. It rides the relink and draft paths
too, and the id is validated at the command edge against the shape the server
declares rather than the CLI's looser uuid, so a bad one costs a message instead
of a 400 collected after the wallet signature.

`tenjin config set publish.mode` now syncs that harness rule instead of leaving
it to the next `install`. Loosening to auto or full-auto asks once, naming the
rule, and writes on yes; no terminal, `--json`, or a decline writes nothing and
points. Tightening back to review retracts it unprompted, since that direction
can only take back what this CLI wrote.

Installing Tenjin is now the consent for auto-publishing. Every install settles
`publish.mode` at `auto` unless told otherwise, and the first install — headless
included — writes `Bash(tenjin publish:*)` alongside the free tier, naming the
mode, the rule, and the three ways out in its own output. The bare CLI, with no
install ever run, still defaults to `review`. `--publish-mode review` opts out at
install time; the interactive question is unchanged, with auto as its default
answer.

The skills read auto-first to match: publishing a clean piece and reporting the
URL is the ordinary outcome, and asking is what `review` is for. The
WARN-findings caveat is restored — never a generic "shall I publish?" before
running, because a `--yes` re-run after a bare yes clears findings the user never
saw. The stop hook now honors `TENJIN_PUBLISH_MODE`, so the hook, `publish`, and
`doctor` agree on the mode.
