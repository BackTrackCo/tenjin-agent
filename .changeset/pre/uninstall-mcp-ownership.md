---
'tenjin-cli': patch
---

`tenjin uninstall` leaves an `x402` MCP server it did not write. Before removing the
registration it reads the scope's own file the way `install` does, and when the `x402`
entry launches something other than `tenjin mcp`, or the file cannot be read, it removes
nothing and says why instead of running `claude mcp remove x402`. An entry that is the
router's, or no entry at all, is removed as before.
