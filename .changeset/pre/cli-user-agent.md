---
'tenjin-cli': minor
---

Send the standard `User-Agent: tenjin-cli/<version> (+https://tenjin.blog)` on
every request, and stop sending `X-Tenjin-Client` anywhere.

Client attribution now rides the field HTTP already has. The header is written at
the shared transport (`fetchJson` and `httpRequest`), through one setter both
funnel into, so a new call site cannot ship without an identity and a
call-specific header cannot erase one: the merge runs on the Headers API, where a
caller spelling `User-Agent` in any case lands in the same slot and is
overwritten rather than duplicated. The MCP server inherits it unchanged, because
its tools call the same command cores.

The custom header is deleted rather than kept alongside. The server prefers the
`User-Agent` product token over `X-Tenjin-Client` (BackTrackCo/tenjin#544) and
parses `tenjin-cli` from both, so the label recorded against searches and
payments does not move across this change and no compatibility shim is needed.
`registry.npmjs.org` update checks are the one exception, and stay on Node's
default agent: they are not tenjin.blog traffic.

Adding the header cannot disturb a payment. The x402 signature covers EIP-3009
typed transfer data, never HTTP headers, and the session delegation's RFC 9421
signature covers method, target URI, and content digest only. A test recovers the
signer from the payload that actually went over the wire on the paid retry, and
pins that request's header set exactly.
