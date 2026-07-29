---
'tenjin-cli': minor
---

Add `tenjin read <ref>`, a free-only delivery verb.

`buy` used to be the only verb that delivered a body, so a zero-cost read — a free
piece, or a re-read of something already in your library — was indistinguishable
from a purchase, both to a human reading a transcript and to a harness permission
classifier that matches on the command prefix.

`tenjin read` is the half of `buy` that cannot spend. It tries three things in
order — the local library, an unauthenticated fetch, then a SIWX entitlement check
— and only refuses when you are genuinely unentitled:

- delivers free pieces, anything already in the local library, and anything the
  wallet is already entitled to (including a piece bought on another machine,
  which it stores locally), with the same output shape and the same
  `--print-body` / `--sections` flags as `buy`;
- hard-refuses with exit 3 (`REFUSED`) when payment would be required, naming the
  price and the `tenjin buy` command to run instead;
- signs an **authentication** message only, the same class of signature `publish`
  makes. It imports no payment module and never consults the spend policy —
  pinned by an import-graph test and a source-usage test, not just by control
  flow. Signer resolution is lazy, so a library hit or a free read never unlocks
  the keystore.

The delivery and rendering internals are now shared between the two verbs in
`lib/delivery.ts`; `buy`'s paying path is unchanged.

Hardening that applies to `buy` and `inspect` too: a request on the read route
never follows a redirect, because a 3xx would re-send a wallet-signed header to
whatever host `Location` names, and because the response becomes a durable local
entitlement record. So that the strictness costs nothing at the keyboard, a read
URL is canonicalized when it is resolved — a trailing slash, which the route
itself redirects away, is removed before the request goes out.

`tenjin inspect` copy follows the split: free and already-owned pieces point at
`tenjin read`, paid unowned pieces keep pointing at `tenjin buy`, and both now
emit a machine-readable `nextCommand` field.
