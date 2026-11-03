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
