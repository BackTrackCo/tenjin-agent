---
'tenjin-cli': minor
---

Add `tenjin mcp`, a local stdio MCP server over the existing command cores. It
exposes seven tools (`tenjin_lookup`, `tenjin_inspect`, `tenjin_buy`,
`tenjin_outcome`, `tenjin_publish`, `tenjin_candidate`, `tenjin_wallet`) that call
`lookup` / `inspect` / `buy` / `outcome` / `publish` / `candidate` / `wallet`
in-process, returning each command's machine JSON envelope as `structuredContent`
with a short text summary. The consent semantics are the CLI's, unchanged: the
spend policy gates buying, `publish.mode` gates publishing (an MCP client renders
the `needs_confirmation` payload as its own confirm UI, then re-calls with
`yes:true`), and hard content blocks are never bypassable. The wallet stays local
and its key never leaves the machine. Register it with
`claude mcp add tenjin -s user -- tenjin mcp`.
