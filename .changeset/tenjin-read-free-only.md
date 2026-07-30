---
'tenjin-cli': minor
---

Add `tenjin read <ref>`, a free-only delivery verb.

`buy` used to be the only verb that delivered a body, so a zero-cost read — a free
piece, or a re-read of something already in your library — was indistinguishable
from a purchase, both to a human reading a transcript and to a harness permission
classifier that matches on the command prefix.

`tenjin read` is the half of `buy` that cannot spend. It tries two things in
order — the local library, then an unauthenticated fetch — and refuses as soon as
payment would be required:

- delivers free pieces and anything already in the local library, with the same
  output shape and the same `--print-body` / `--sections` flags as `buy`;
- hard-refuses with exit 3 (`REFUSED`) on a paid piece that is not already on
  disk, naming the price and the `tenjin buy` command to run instead. That
  includes a piece you already own but have not cached on this machine: `buy`'s
  own entitlement re-check delivers it without charging;
- signs nothing at all. It reaches no wallet, signing, or payment module —
  `lib/wallet`, `lib/session-key`, and `lib/x402-pay` are all absent from its
  transitive import graph, pinned by an import-graph test plus a source-usage
  test — and never consults the spend policy. `read` cannot open a keystore, so
  its inability to spend is structural rather than a matter of control flow.

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
