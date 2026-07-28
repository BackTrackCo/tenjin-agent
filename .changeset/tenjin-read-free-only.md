---
'tenjin-cli': minor
---

Add `tenjin read <ref>`, a free-only delivery verb.

`buy` used to be the only verb that delivered a body, so a zero-cost read — a free
piece, or a re-read of something already in your library — was indistinguishable
from a purchase, both to a human reading a transcript and to a harness permission
classifier that matches on the command prefix.

`tenjin read` is the half of `buy` that cannot spend:

- delivers free pieces, and anything already in the local library, with the same
  output shape and the same `--print-body` / `--sections` flags as `buy`;
- hard-refuses with exit 3 (`REFUSED`) the moment payment would be required,
  naming the price and the `tenjin buy` command to run instead;
- imports no payment module and never resolves the wallet, signs a SIWX header, or
  consults the spend policy — pinned by an import-graph test, not just by control
  flow.

The delivery and rendering internals are now shared between the two verbs in
`lib/delivery.ts`; `buy`'s paying path is unchanged.

`tenjin inspect` copy follows the split: free and already-owned pieces point at
`tenjin read`, paid unowned pieces keep pointing at `tenjin buy`, and both now
emit a machine-readable `nextCommand` field.
