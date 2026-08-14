---
'tenjin-cli': patch
---

Teach the skill writer config-conditional content, behind an inert seam.

A packaged skill markdown may now wrap a region in full-line
`<!-- tenjin:when <configKey> -->` / `<!-- /tenjin:when -->` markers, and
`installSkill` accepts a `materialize` transform that resolves those regions
against a flag set before the on-disk compare and the write. An ON flag keeps
the inner lines, an OFF or unknown flag drops them, and the marker lines never
survive either way, so an installed SKILL.md carries no machinery for an agent
to read. The parse is flat and fails closed: nesting, an unclosed block, or an
unopened close aborts that skill's install rather than writing a half-shaped
copy, and non-markdown files pass through byte-for-byte.

Because the transform runs before the compare, `up-to-date` means "matches what
the current config state would write", and flipping a flag turns the same
packaged source into a real update. `matchesSomeVariant` tells a maintenance
pass whether an on-disk copy equals ANY flag assignment of its source, which is
what lets a later doctor check distinguish "ours, shaped by other config" from
"edited or foreign" without a ledger.

Nothing ships marked content or passes the transform yet; every existing
install, heal, and doctor path is byte-for-byte unchanged. The first consumer
is the upcoming `bazaarPay` toggle, whose skill block must only be visible when
the operator opted in.
