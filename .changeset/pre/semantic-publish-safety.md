---
'tenjin-cli': patch
---

Publish-safety scan: the `confidential-marker` check is now marker-shaped
(the uppercase legend — CONFIDENTIAL, STRICTLY CONFIDENTIAL, INTERNAL ONLY,
INTERNAL USE ONLY, DO NOT DISTRIBUTE), so prose about "confidential computing"
no longer trips it. Five new deterministic warn checks from the
publishing-safety check-set: `private-repo-reference` (mentions of the source
project's own git remote slugs, derived offline from `.git/config` at publish
time), `local-path` (home-anchored machine paths, username masked),
`customer-identifier` (labeled customer/account/tenant ids, value masked), and
`paid-content-marker` / `embedded-instruction` (third-party rights legends and
prompt-injection-shaped imperatives). All ambiguity-class findings warn — the
block set is unchanged. The tenjin-publish and tenjin-search skills gain the
semantic publish-safety pass the scan cannot do: statement-level
classification, the competitor-reconstruction check, and the title/answer-card
leak check, with any doubt parking the draft in the candidate pen.
