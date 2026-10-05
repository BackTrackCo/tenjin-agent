---
'tenjin-cli': minor
---

`tenjin` becomes an x402 router for Claude Code. `tenjin install` writes two
hook entries and one permission rule, registers the `x402` MCP server, and sets
the spend limits a lookup runs under; `tenjin mcp` carries one `request` tool
that pays for a routing decision and then pays the provider, through the same
spend gate `tenjin pay` uses. `tenjin status` reports the local window.

This release registers core (`install`, `uninstall`, `update`, `wallet`, `pay`,
`config`, `doctor`) plus router (`hook`, `mcp`, `status`). The shelf product's
commands are NOT registered and do not ship: `search`, `inspect`, `read`,
`discover`, `buy`, `publish`, `edit`, `delete`, `profile`, `stats`, `hooks`,
`grade`, `daemon`, `outcome`, and the shelf MCP server. Their source stays until
a follow-up removes it. Needs `X402_ROUTER_API=on` on the backend.
