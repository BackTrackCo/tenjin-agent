---
'tenjin-cli': minor
---

Let the agent that runs the CLI travel in the same `User-Agent` field, behind the
`tenjin-cli` product: export `TENJIN_CALLER_USER_AGENT` when you launch it.

Composition happens in one place (`composeUserAgent` in `lib/client-meta.ts`) and
is idempotent: the caller value is decomposed into products, any copy of our own
product or comment is dropped from it, and the field is rebuilt from the package
identity. A retry, a nested helper, or an agent re-exporting the env it received
therefore cannot mint a second `tenjin-cli` token, and the caller's own products
survive byte for byte in their original order. The write still runs through the
Headers API, so a call-specific `User-Agent` in any casing cannot erase the
composed field or add a second one.

The handoff accepts a product sequence and nothing else, which is what keeps a
user, wallet, session, hostname, or machine identifier structurally out of it. A
value that is not printable ASCII, not a bare product sequence, or long enough to
push the composed field past the 512 characters the server accepts is omitted
whole: the CLI identity travels alone rather than as a truncated token that would
read as a different client. It is self-reported telemetry, never trusted policy
input, and no signed header set changes: the payment and RFC 9421 signatures
cover the same material they did before.

The generated WebSearch hook script carries the identity too. It is the CLI's
highest-volume request path and it imports nothing, so it had been sending Node's
default `User-Agent: node` and every hook-driven search was landing as a
synthetic client named `node` that was in fact this CLI. It now composes the same
field, from constants interpolated out of `lib/client-meta.ts` at generation time
and the caller handoff read at run time, with a test that runs the shipped bytes
and the real composer over the same inputs so the two cannot drift.
