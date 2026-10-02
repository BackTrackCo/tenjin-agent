---
'tenjin-cli': patch
---

A paid request to a third-party host now connects only to an address that
passed the private-network check. Before, `tenjin pay` and the router's
`request` tool checked that the provider's name resolved to a public address,
then let the request resolve the name again on its own, so a host that
answered publicly to the check and privately a moment later (DNS rebinding)
could get the probe or the paid retry. Every leg now resolves the name once
per connection and refuses a private answer there, before anything is sent.
Behind a proxy Node was told to use (`NODE_USE_ENV_PROXY=1` or
`--use-env-proxy`), the request keeps going through the proxy, which resolves
the name itself.
