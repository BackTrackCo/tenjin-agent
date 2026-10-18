---
'tenjin-cli': patch
---

The Claude Code plugin now runs on Windows: every command it carries is exec form, `node` and its arguments started with no shell, so Git Bash and PowerShell no longer parse it. The `SessionStart` leg and the `router` MCP server run `node` with the package's own `dist/index.js` (found from `${CLAUDE_PLUGIN_ROOT}` in the shipped plugin, and written as an absolute path into the `skills/tenjin-router/` folder fallback), never the `tenjin` npm shim, which Windows cannot spawn without a shell. The two permission answers are fixed JSON that `node -e` prints. `tenjin doctor` reports the hook form it finds, and on Windows warns about a plugin folder or an earlier settings install still in shell form. The settings-install remover also recognizes those entries in exec form or behind a Windows path.
