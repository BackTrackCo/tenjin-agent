# Troubleshooting

## Claude Code asks about a new project MCP server named `x402`

Updating to `0.1.0-alpha.18` could accidentally register the server in `~/.mcp.json` while refreshing a user install. After upgrading to a release with the fix, check that file. If its `x402` entry runs `tenjin mcp` and you didn't install at project scope in your home directory on purpose, remove just that registration:

```bash
(cd ~ && claude mcp remove x402 -s project)
```

This keeps your other MCP entries and the user registration in `~/.claude.json`. Run `tenjin install`, then restart Claude Code. Don't use `tenjin uninstall --project` from home for this: its settings path is also the user settings path.

When refreshing from home, Tenjin keeps the existing user registration if there is one, or preserves a project-only registration; with neither, it defaults to user scope. `tenjin install --refresh --project` selects project scope explicitly.
