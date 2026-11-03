---
'tenjin-cli': patch
---

tenjin-publish gains the harvest ask (tenjin-agent#145 item 2, redesigned):
"anything from our recent work worth publishing?" now routes into the skill
explicitly, with a sweep procedure — grade what is visible in the
conversation against the sell rubric, offer survivors once as one batch, a no
is final and never re-asked, and never dig through transcripts or archives
the user did not hand over. This replaces the weekly scheduled-harvest design
outright: an OS-level cron written during onboarding has no precedent and
reads as intrusive, out-of-session runs create a session-archive dependency,
and per-session nudge telemetry shows unprompted reminders do not convert.
In-context, user-invoked, zero scheduling. One trigger clause added to the
always-loaded description; the procedure lives in the body.
