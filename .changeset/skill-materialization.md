---
'tenjin-cli': minor
---

Shape installed skill content by machine facts, starting with wallet presence.

A packaged skill markdown may wrap a region in full-line
`<!-- tenjin:when <flag> -->` / `<!-- /tenjin:when -->` markers, and every
writer (`install`, the post-command self-heal) materializes those regions
against the same flag set before the on-disk compare and the write. An ON flag
keeps the inner lines, an OFF or unknown flag drops them, and the marker lines
never survive either way, so an installed SKILL.md carries no machinery for an
agent to read. The parse is flat and fails closed: nesting, an unclosed block,
or an unopened close aborts that skill's install rather than writing a
half-shaped copy, and non-markdown files pass through byte-for-byte.

The first flag is `wallet`. A `--no-wallet` install now receives a
`tenjin-search` skill that teaches no spending verbs: the `## Buy` section and
the `fund`/`wallet show`/`wallet balance` allowlist lines exist only where a
wallet does, so an agent is never coached into flows that end at
WALLET_MISSING. A wallet created later flips the flag: `install` re-shapes in
the same run when it creates one, and the self-heal re-shapes on the next
command when one appears out of band. `doctor` compares wired copies against
the same materialized expectation, so a shaped copy is current, never stale.

Because the transform runs before the compare, `up-to-date` means "matches
what this machine's facts would write", and the flag flip turns the same
packaged source into a real update. `matchesSomeVariant` lets a maintenance
pass distinguish "ours, shaped by other flags" from "edited or foreign"
without a ledger. The next consumer is the upcoming `bazaarPay` toggle, whose
skill block must only be visible when the operator opted in.
