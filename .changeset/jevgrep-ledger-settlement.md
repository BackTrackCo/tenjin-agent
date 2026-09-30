---
'tenjin-cli': patch
---

Settle a Jevgrep evaluation into the current daily window when the supplier answers it with a validated response, so answered evaluations stop charging every later window; fold settled records older than the window into one per run; add `tenjin jevgrep reconcile` to settle evaluations recorded before this build that have a saved response.
