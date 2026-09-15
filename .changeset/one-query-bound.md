---
'tenjin-cli': patch
---

Every hook arm and `tenjin search` send up to 8,000 characters, the shelf's one
query bound, so a long prompt reaches the shelf whole. Needs BackTrackCo/tenjin#853
on the shelf; an older shelf answers a long non-dispatch query with a 400.
