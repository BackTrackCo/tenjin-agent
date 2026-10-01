---
'tenjin-cli': patch
---

Every paid router lookup now reports its settlement transaction (from the
x402 payment-response header) and is recorded in `~/.tenjin/paid/ledger.jsonl`
with what was sent (masked), the seller, the amount, the signed
authorization's nonce, and any files saved. Media a paid result links to is
downloaded into `~/.tenjin/downloads/`. `tenjin payments reconcile` resolves a
payment whose settlement was unknown from USDC's `authorizationState` once its
authorization has expired, and gives a payment that was never charged back to
the daily limit; the `request` tool runs the same check for up to three before
each lookup.
