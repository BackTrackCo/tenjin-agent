---
'tenjin-cli': patch
---

Document the 512-character question cap in the tenjin-search skill, next to the
instruction that produces oversized queries. An agent following "send the
complete question" with a realistic incident description bounced off the CLI's
`USAGE` error with no guidance on how much to trim.
