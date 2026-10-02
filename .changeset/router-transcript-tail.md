---
'tenjin-cli': patch
---

A session whose transcript is over 4 MB is routed again. The router read nothing
from a transcript that size, so every long working session lost the pre-call
redirect and the delegation offer for the rest of its life ("this session's
transcript could not be read"). It now reads the last 4 MB, from the first whole
line, and uses it only when that window still holds a user message, so this
turn's own instructions are always what the decision reads.
