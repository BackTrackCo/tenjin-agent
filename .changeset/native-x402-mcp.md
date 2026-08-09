---
'tenjin-cli': minor
---

Add a provider-neutral external-wallet lane to `tenjin_buy` using the official
`@x402/mcp` package. Clients opt in with `paymentMode:"external"`, receive the
standard direct `PaymentRequired` result, retry with `_meta["x402/payment"]`, and
receive canonical settlement metadata in `_meta["x402/payment-response"]`.
Integrated local-wallet purchases also return their canonical receipt, while an
explicit mode boundary prevents one request from selecting two wallet lanes.
