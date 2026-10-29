---
'tenjin-cli': patch
---

Router answers are read tolerantly: a field this build does not know is ignored instead of making the whole answer unreadable, and every field it knows keeps its type and safety checks. An offer may name client features it needs in `requires`; this build skips such an offer by name, with nothing paid, and keeps the rest of the answer.
