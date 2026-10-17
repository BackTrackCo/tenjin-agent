---
'tenjin-cli': patch
---

`tenjin install --harness codex` sets up Tenjin in Codex: the wallet, the spend limits, the Codex plugin `tenjin` through `codex plugin marketplace add` and `codex plugin add` from the package's `dist/hosts/codex`, and, once you approve the limits, the grant `plugins."tenjin@tenjin".mcp_servers.router.tools.request.approval_mode = "approve"`. The plugin's hooks route your prompt and one web search before it runs and after, and its `router` server carries the request tool, named `mcp__router__request`. Codex asks you to trust the hooks in `/hooks`. `tenjin doctor --harness codex` reads the plugin, hook trust, the grant and whether a Pay once ask can show, and writes nothing. `tenjin uninstall --harness codex` removes the plugin, its marketplace and the grant when it is still `approve`, and `tenjin update` re-adds the plugin from the new build.

Every router request now names its host in `harness` (`claude` or `codex`), on the hook, tool and outcome bodies, so the router can leave out a lookup the host's own tools already do.
