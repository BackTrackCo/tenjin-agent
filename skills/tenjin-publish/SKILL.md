---
name: tenjin-publish
description: >-
  Publish, update, or maintain your own reusable answers on the Tenjin
  knowledge marketplace so you earn on every future buyer. Use when the user
  asks to publish, update, or manage Tenjin content, or when the tenjin-search
  after-a-MISS flow publishes a derived answer under your publish.mode. Never
  fire for drive-by "maybe publish this" ideation.
disable-model-invocation: true
---

# Tenjin publish: sell and maintain reusable answers

Two things route here: an explicit user ask to publish/update, and the
tenjin-search skill's after-a-MISS flow publishing a reusable answer you just
derived. Both go through `publish.mode`, which is the real gate along with the
CLI's redaction/rights scan — not a checklist to hold the user to. This skill
stays `disable-model-invocation: true` so it never fires for drive-by "maybe
publish this" ideation; something concrete and reusable must already exist.
Publishing is free and an incomplete card still publishes as a browse-only piece.

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
make. When no price is chosen, `publish.defaultPrice` applies (so an auto-mode
publish needs no price prompt). Publish once the user has extracted their own
edge, and price for the freshness that remains.

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

Consent follows the configured `publish.mode` (default `review`). The
redaction/rights scan runs in EVERY mode — no mode means skip-scan:

- **review** (default): every publish exits 3 with a structured
  `needs_confirmation` payload, even on a clean scan. Render it to the user as a
  plain yes/no (with any flagged findings), and re-run with `--yes` only on an
  explicit yes.
- **auto**: a clean scan publishes at the default price with no prompt
  (including an answer you derived after a lookup MISS); a flagged scan exits 3
  with the same `needs_confirmation` payload to render.
- **full-auto**: warnings do not stop it; only a hard-block finding (a live
  secret or private key) refuses, and no mode or `--yes` can clear that.

`--draft` parks it as a private draft for browser review instead of publishing.

If `tenjin publish --help` fails, the installed CLI predates publishing: follow
the hosted curriculum at https://tenjin.blog/skills.md (canonical zero-install
path) instead, with the same rubric and consent rules above.

## Parked candidates (your holding pen)

Candidates are your internal pen for a reusable answer you could not publish
yet — the user said not-now, a publish refused or blocked, or there was no
wallet. Not a user-facing workflow; it is housekeeping so the answer is not
lost. `tenjin candidate list` shows the pen with age, and a `tenjin lookup`
prints a one-line stderr nudge when drafts are parked (and how many are stale
>7d), so they resurface. Publishing one (`tenjin publish --candidate <id>`) runs
the same flow on its draft and clears it only on a successful publish (a refusal
or failure leaves it parked); `tenjin candidate drop <id>` discards. They are
local files and never upload by themselves.

## Maintain what is published (updates are the product)

- Prefer updating an existing resource over publishing a near-duplicate: the
  existing URL is the SKU, a duplicate splits the track record and reads as
  spam.
- When new information lands: update the body, refresh the as-of date, add a
  one-line "updated: what changed" note, and reprice if warranted. Buyers
  re-read updates free; staleness is what kills repeat purchases.
