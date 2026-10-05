---
'tenjin-cli': patch
---

A paid result is now checked against its success rule up to 4 MB, not 128 KB.
An Apollo person hit runs 60-180 KB because it embeds the employer's whole
organization record, so a good match came back `unverified` with a "possibly
not the answer that was paid for" caveat: a body past 64 KB failed the check on
a size limit meant for inputs, and one past 128 KB was never checked. A body
over 4 MB is still delivered whole and flagged unverified, as before.
