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

The curated `ecosystem` kind ships empty. An entry is added only once a reviewer
has confirmed a configured registry currently lists the endpoint. Nothing in the block is probed and nothing in it reaches
`bazaar-listings.json`, the pay lane's evidence store: a pin no registry lists
still refuses as unlisted at pay time.

`docs/ecosystem.md` (linked from the README) documents how third parties list
themselves, by pull request. Both tiers are entered and reviewed the same way; a
VIP entry additionally ships inside the CLI as a discover pin, which is why it
must carry reproducible registry evidence.
