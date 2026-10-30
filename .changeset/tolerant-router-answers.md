---
'tenjin-cli': patch
---

Router answers are read tolerantly: a field this build does not know is ignored instead of making the whole answer unreadable, and every field it knows keeps its type and safety checks. An offer may name client features it needs in `requires`; the server sends those only to a client that lists them in `accepts`. As a backstop, a build that meets one it lacks skips by name, with no provider paid: the whole answer when its line names that offer, or else only that offer.
