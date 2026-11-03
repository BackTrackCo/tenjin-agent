---
'tenjin-cli': patch
---

Add `mcpName: blog.tenjin/tenjin` to `package.json`. The official MCP Registry
validates npm-distributed servers by fetching the pinned version's metadata and
requiring this field to match the server name, so the `tenjin mcp` stdio server
can be listed as an npm package under the existing `blog.tenjin/tenjin` entry.
