---
'tenjin-cli': patch
---

Every router request now lists `tolerant` in `accepts`, telling the server this build ignores fields it does not know and honors `requires`, so new answer fields can be sent to it while older releases keep today's shape.
