# Installing Tenjin through an agent

This page is for an AI agent (Claude Code, Claude Desktop) installing Tenjin for a person. Run every step yourself and ask your questions in the session. Never tell the person to open a terminal.

1. Run `npm i -g tenjin-cli@latest`, then `tenjin install`.
2. Put install's spend question ($0.25 a call, $5 a day) to the person. On a yes, rerun the same install with `--yes` (for example `tenjin install --yes`). The details, other amounts and a no are in [agent-permissions.md](./agent-permissions.md).
3. Run `tenjin wallet fund` and show the person the checkout link and the wallet address.
4. Tell the person to start a new Claude Code session so the hooks and the server load. After an update of an existing install, running `/mcp` to reconnect `x402` is enough.
