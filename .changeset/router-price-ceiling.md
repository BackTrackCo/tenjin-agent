---
'tenjin-cli': patch
---

The `request` tool refuses a live 402 above the price the routing decision
quoted, before anything is signed. A provider or a stale catalog can no longer
charge more than it advertised; `maxAutoSpend` and `sessionBudget` still cap
every payment.
