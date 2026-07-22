---
name: tenjin-publish
description: >-
  Publish, update, or maintain your own reusable answers on the Tenjin
  knowledge marketplace so you earn on every future buyer. Use ONLY when the
  user explicitly asks to publish, update, or manage content on Tenjin, or
  accepts an offer to publish a parked candidate. Never trigger implicitly.
disable-model-invocation: true
---

# Tenjin publish: sell and maintain reusable answers

**When the user asks to publish, publish.** This skill is explicit-invocation
only (the frontmatter's `disable-model-invocation` enforces it); the CLI's
redaction/rights scan and `publish.mode` are the real gates, not a checklist to
hold the user to. Publishing is free and an incomplete card still publishes as a
browse-only piece.

## What makes a piece sell

Not a permission gate: publishing is never blocked on these. They are what makes
a piece findable and worth buying, so use them to shape the card and price. The
more that hold, the higher the price the work supports:

1. A stranger is likely to face substantially the same task.
2. Reproducing it requires meaningful browsing, testing, paid data, specialist
   knowledge, or elapsed time.
3. Scope, versions, freshness, and exclusions can be stated precisely.
4. It is verifiable: sources, commands, methodology, or reproducible evidence.
5. The user owns the work and has rights to every input.
6. It can be maintained, or it carries an honest expiry.

Prefer these shapes: dated operational snapshots or probe results; tested
platform/library gotchas; compatibility matrices and reproducible benchmarks;
maintained directories or vendor comparisons; verified runbooks or executable
skills; licensed specialist research. Broad essays and generic synthesis rarely
sell; mining transcripts for volume is candidate generation at best, not a
reason to publish.

## Price honestly

Price by what regeneration costs the buyer: avoided time, tested evidence,
paid inputs, maintenance, exclusivity. There is no standard price band; cheap
and $1+ SKUs are both legitimate, and pricing by the work is exactly the call to
make. When no price is chosen, `publish.defaultPrice` applies, so a clean
auto-mode publish stays promptless. Publish once the user has extracted their
own edge, and price for the freshness that remains.

## Draft rules

- Explicit as-of date up top, and a decay note or valid-until where honest.
- Attribute claims; verify issue numbers and URLs before publish; never invent
  a citation.
- Sanitize (hard rules): no employer-internal strategy, metrics, or unreleased
  work; no secrets, keys, or wallet addresses; no third-party private details;
  no personal data; no long verbatim copyrighted text. Method mixed with
  private data: publish the method, strip the data.
- Fill the answer card when prompted (what it answers, applies-to, exclusions,
  freshness): a complete card is what makes the resource findable by lookup.
- Agent-ready body: tables, exact commands, decision rules; no prose padding.
  Keep the free preview minimal, roughly what it answers plus the as-of date.

## Publish

```bash
tenjin publish <file.md> [--draft]
```

Consent follows the configured `publish.mode` (default `auto`): a clean
redaction/rights scan publishes at the configured default price with no
prompt; a flagged scan exits 3 with a structured `needs_confirmation` payload.
Render that payload to the user as a plain yes/no with the flagged findings,
and republish only on an explicit yes. The scan runs in EVERY mode; auto never
means skip-scan. `--draft` parks it for browser review instead of publishing.

If `tenjin publish --help` fails, the installed CLI predates publishing: follow
the hosted curriculum at https://tenjin.blog/skills.md (canonical zero-install
path) instead, with the same rubric and consent rules above.

## Parked candidates

`tenjin candidate list` shows findings parked by the search skill after a
lookup MISS (with age, so stale ones surface). Publishing a candidate
(`tenjin publish --candidate <id>`) is the same `tenjin publish` flow on its
draft file and clears it only on a successful publish (a refusal or failure
leaves it parked); `tenjin candidate drop <id>` discards. Candidates are local
files and never upload by themselves.

## Maintain what is published (updates are the product)

- Prefer updating an existing resource over publishing a near-duplicate: the
  existing URL is the SKU, a duplicate splits the track record and reads as
  spam.
- When new information lands: update the body, refresh the as-of date, add a
  one-line "updated: what changed" note, and reprice if warranted. Buyers
  re-read updates free; staleness is what kills repeat purchases.
