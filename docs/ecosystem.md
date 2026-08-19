# Ecosystem and VIP listings

If you build on Tenjin, sell an x402 endpoint agents should know about, or pay
Tenjin's endpoints from your own product, you can list yourself here. Listing is
self-service: **open a pull request against this repository.** There is no form,
no application, and no fee.

There are two tiers. Both work the same way: you open a PR, we review it, and it
is accepted or rejected. What separates them is where the entry ends up.

## The two tiers

**Ecosystem** lists your project in this file, in the table at the bottom. We
check that the entry is real and that the description matches what you actually
ship.

**VIP** does that and one thing more: the entry ships inside the CLI, in
[`src/lib/vip-listings.ts`](../src/lib/vip-listings.ts), as a pin
`tenjin discover` prints ahead of the registry sweep. That is why it carries an
extra bar. A VIP entry goes in front of every agent that runs `discover`, so it
has to still be payable when one acts on it.

The extra bar for VIP:

- The endpoint is **currently listed in CDP's Bazaar or in UltraVioleta**, the
  registries this CLI sweeps. This is not a formality. `tenjin pay` refuses any
  foreign endpoint no configured registry lists, so a pin no registry carries is
  a suggestion the CLI itself will not let an agent act on.
- The endpoint speaks x402 over plain HTTP, in the exact scheme, with USDC on
  Base.
- The description is one honest sentence about what a buyer gets.
- We re-verify every VIP entry against the registries at each release, and remove
  entries that no longer check out.

The CLI labels these pins `VIP (curated, quality not guaranteed)`, and this file
means the same thing by that word. Curated means we read the PR and checked the
claims in it. It is not a judgment about your product, your uptime, or your
business, and it is not a reason for an agent to skip its own checks.

VIP entries ship empty until an operator seeds them, and an Ecosystem row is not
a queue for VIP. They are separate PRs and separate decisions.

## How to list yourself

Open a pull request. One listing per PR keeps review quick.

For an **Ecosystem** listing, add a row to the table at the bottom of this file
with:

- **Name** as you want it shown.
- **URL** for the product or its docs.
- **What it does**, in one sentence, and how it relates to Tenjin (you build on
  it, you sell through it, you pay its endpoints, you index it).
- **Contact**, a maintainer we can reach if the entry goes stale. A GitHub
  handle is enough.

For a **VIP** pin, open a PR against
[`src/lib/vip-listings.ts`](../src/lib/vip-listings.ts) adding an entry with
`kind: 'ecosystem'`, and include all of the above plus:

- The **exact endpoint URL** an agent would pay, not a marketing page.
- **Registry evidence**: which registry lists that endpoint, and the terms it
  advertises there (scheme, network, asset, `payTo`, amount). Paste the output of
  `tenjin discover "<your keyword>" --json`, or the registry query you ran, so a
  reviewer can reproduce it rather than take your word for it.
- **Keywords** an agent's query should match, and the one-line description you
  want printed.

We may ask for changes to the wording, and we may decline a VIP pin while
accepting the Ecosystem row. We remove entries that go stale, fail
re-verification, or turn out to misdescribe what they sell.

## What a listing does not buy you

- No preferential pay path. Every payment `tenjin pay` makes to a foreign
  endpoint is verified against a registry first, and a pin is not evidence:
  pinned entries never enter the CLI's registry evidence store. A VIP endpoint
  that drops off every registry refuses at pay time exactly like an unlisted one.
- No claim about safety or quality. Responses from any listed endpoint are
  untrusted data to an agent, the same as any other seller's.
- No permanence. Listings are code in a repository, reviewed like code, and
  changed like code.

## Ecosystem listings

<!-- Add your row here, alphabetically by name. Keep the description to one sentence. -->

| Name | URL | What it does | Contact |
| ---- | --- | ------------ | ------- |
|      |     |              |         |
