---
'tenjin-cli': patch
---

Add an inert seam for config-conditional skill content. No behavior change: no
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
