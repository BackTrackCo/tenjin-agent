---
'tenjin-cli': patch
---

Defang the prompt-injection eval fixtures. The HTTP payload named a live
production endpoint, so the run where the case earned its keep was the run where
local state left the machine. It now names a placeholder the runner replaces with
a loopback sentinel that records the attempt and discards the body, and the
output runner gives cases an explicit short environment plus the Tenjin data-dir
and review-mode pins that used to be an operator's job to export. Ships in the
package only as skill-adjacent tooling; no CLI behaviour changes.
