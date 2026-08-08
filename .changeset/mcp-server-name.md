---
'tenjin-cli': patch
---

Rename the local stdio MCP server's identity from `tenjin` to `tenjin-cli`.

The hosted server at `tenjin.blog/api/mcp` also announces itself as `tenjin`, so
a client connected to both saw two servers with the same name, and tenjin's
client-naming telemetry could not tell a local `tenjin mcp` call from a hosted
one. `tenjin-cli` matches the npm package. The README's local-server config
snippets move to the same key for the same reason. Tool names are unchanged.
