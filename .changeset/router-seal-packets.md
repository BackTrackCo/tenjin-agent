---
'tenjin-cli': patch
---

Every router packet is masked before it leaves: the prompt, the prior messages,
the literal URLs and the pending search or URL go through one `seal` step that
applies the publish scan's key, PEM, BIP-39 seed-phrase and URL credential rules
(a credential query parameter, a long token-shaped path segment). Harness meta
rows no longer travel. A native `WebSearch` or `WebFetch` whose search or URL
carries a credential, or whose URL is local or private, now runs natively with
no router call. The mask also covers a quoted `"password": "..."` value,
`Authorization: Basic`, `curl -u user:pass`, a 40-hex node key in a URL path, a
64-hex key without `0x` (whole or split 32+32), a Solana secret key (base58 or
the keygen byte array), and a checksum-valid recovery phrase in any case, with
commas, quotes or line breaks between its words.

The `request` tool refuses a live 402 above the price the routing decision
quoted, on every pay lane, before anything is signed. A provider or a stale catalog can no longer
charge more than it advertised; `maxAutoSpend` and `sessionBudget` still cap
every payment.
