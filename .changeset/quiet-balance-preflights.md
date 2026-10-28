---
'tenjin-cli': patch
---

Remove balance RPC preflights from routing offers, deposits and x402 signing. A routing deposit signs $0.25 first; when the facilitator answers that the wallet holds less, it signs the $0.03 hint once more, and a wallet below that gets no route and the funding notice. Keep startup funding notices with a 500 ms total deadline shared by RPC fallbacks, and bound explicit balance reads.
