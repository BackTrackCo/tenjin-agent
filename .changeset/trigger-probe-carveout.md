---
'tenjin-cli': patch
---

Widen the supply/demand triggers (tenjin-agent#145 item 1) by restructuring
both skill descriptions rather than appending to them, holding length at
parity with the previous wording. tenjin-search now leads with both search
moments: before regenerating expensive research, and before empirically
probing a third-party library or platform's undocumented behavior; the skip
list narrows from "the thing in front of you" to "your own code" and the two
skip sentences merge into one. tenjin-publish reorganizes its triggers into
three routes in (user ask, after-a-MISS, unprompted work worth selling), the
unprompted route covering substantial research and empirical proofs the docs
don't state. Clean-room results: trigger eval extended 20 to 22 cases (one per
side of the new probe boundary) and scores 22/22 under the new wording,
in-sample as with the previous tuning; the no-CLI defer eval reads 1/4 but
reads 1/4 on the unchanged main wording too, so that red is pre-existing, not
this change. All runs used --no-preflight because preflight fails on the known
skills/tenjin mirror drift (#88), which no run here touches.
