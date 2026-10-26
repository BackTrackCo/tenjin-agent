---
'tenjin-cli': patch
---

Remove balance RPC preflights from routing offers, deposits and x402 signing. Keep startup funding notices with a 500 ms total deadline shared by RPC fallbacks, and bound explicit balance reads.
