---
'tenjin-cli': patch
---

Drop `not-requested` from the permissions skip vocabulary. It belonged to the
old non-interactive install that skipped the permissions question; install is
the consent now, headless included, so no code path could produce it and the
one summary branch it fed printed the declined wording anyway. Internal
cleanup, nothing user-visible changes.
