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
