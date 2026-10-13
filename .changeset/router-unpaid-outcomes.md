---
'tenjin-cli': patch
---

A call run from an offer's spec now tells Tenjin how it ended when it stopped
before anything was paid, too: the input did not fit the spec, the live 402 was
not the spec's deal, the provider answered something other than a 402, the
provider could not be reached, or the wallet could not pay (no wallet, a locked
one, or too little USDC). It is reported as `unpaid` with that reason, which
never counts as the offer taken, and a spend-limit refusal as `needs_approval`.
Before, only a call that ran or paid was reported, so a call stopped before
payment looked the same as an offer nobody used. The report still carries no
input and no result.
