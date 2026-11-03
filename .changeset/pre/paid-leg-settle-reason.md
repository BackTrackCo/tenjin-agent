---
'tenjin-cli': patch
---

When a seller rejects a signed payment and its payment-response header says it
did not settle (`success: false`), `tenjin pay` and the `request` tool now say
so, with the seller's reason: "The endpoint did not settle the payment: …". The
`request` tool's result carries that reason as `settlementError`, beside
`providerError`. Before, the reason was dropped, and a seller that answered with
an empty `{}` body reached the agent as `providerError: "{}"` and "settlement
unknown". The amount stays counted and the settlement stays `unknown`, because
the signed authorization is valid until it expires.
