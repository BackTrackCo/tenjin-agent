---
'tenjin-cli': minor
---

`tenjin discover` now opens with a pinned block: the configured deployment's own
paid endpoints ahead of the registry sweep, so an agent looking for a payable
endpoint sees them without a registry happening to index them.

Pins live in `src/lib/vip-listings.ts` as static data. First-party entries are
built from `settings.baseUrl` plus fixed paths, so a self-hosted deployment pins
its own endpoints; v1 pins exactly one, `/api/phone-lookup` (`/api/answer` stays
out, and article reads stay search-driven). A query filters pins by exact word
overlap against each entry's keywords and description, with no query meaning
browse-everything. An endpoint the sweep also lists renders once, in the pinned
block, carrying the registry's live price. The JSON envelope gains an additive
`pinned` array with a `kind` field; every existing key is unchanged.

The curated `ecosystem` kind ships empty. Curation is endorsement, so an entry
is added only once an operator has vetted the seller and confirmed a configured
registry lists it. Nothing in the block is probed and nothing in it reaches
`bazaar-listings.json`, the pay lane's evidence store: a pin no registry lists
still refuses as unlisted at pay time.

`docs/ecosystem.md` (linked from the README) documents how third parties list
themselves, by pull request: an open Ecosystem directory listing, and the
curated VIP pins as a stricter, separately reviewed tier with registry evidence
required.
