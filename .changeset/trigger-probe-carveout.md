---
'tenjin-cli': patch
---

Widen the supply/demand triggers by one carve-out each (tenjin-agent#145 item
1). tenjin-search's skip list now skips "your own code" instead of "the thing
in front of you", and tells the agent to search before empirically probing a
third-party library or platform's undocumented behavior: that probe is the
highest-value search moment, and the old wording suppressed it. tenjin-publish
gains a fourth trigger for the same shape on the way out: an empirical proof
of something the docs don't state (a race, a workaround, an integration
pattern) established by real probing. The trigger eval gains a probe-shaped
positive and an own-fork negative (the carve-out's two boundaries), and the
full set scores 22/22 under the new wording. As with the last tuning, that
score is in-sample, and it was measured with --no-preflight because of the
known skills/tenjin mirror drift (#88), which does not touch the skill under
test.
